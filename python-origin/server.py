"""Python Railway origin for MovieAPI's authenticated MovieBox relay."""

import base64
import hashlib
import hmac
from html.parser import HTMLParser
import json
import os
import re
import threading
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from curl_transport import CurlStreamClient, MAX_STREAMS
from engine import BOOTSTRAP_HOST, NATIVE_API_BASE, WEB_USER_AGENT, MovieBoxEngine


RELAY_SECRET = os.environ.get("RELAY_SECRET", "")
if not RELAY_SECRET:
    raise RuntimeError("RELAY_SECRET must be configured before starting the MovieAPI origin")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
engine = MovieBoxEngine.get_instance()
_bootstrap_lock = threading.Lock()
_token_deadline = 0.0
_media_slots = threading.BoundedSemaphore(MAX_STREAMS)
_dash_probe_lock = threading.Lock()
_dash_probe_cache: dict[str, tuple[float, bool]] = {}
_media_hosts = (
    "hakunaymatata.com",
    "aoneroom.com",
    "histar.tv",
    "cloudfront.net",
    "aisports.mobi",
    "aisports.cc",
    "moviebox.ph",
    "movieboxhd.net",
    "inmoviebox.com",
)
_redirect_statuses = {301, 302, 303, 307, 308}
_media_response_headers = {
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "date",
    "etag",
    "expires",
    "last-modified",
}
_header_name = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_range_value = re.compile(r"^bytes=\d*-\d*$")
_web_hosts = ("https://h5-api.aoneroom.com",)
_web_headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": "https://moviebox.ph/",
    "User-Agent": WEB_USER_AGENT,
    "x-client-info": '{"timezone":"Asia/Calcutta"}',
}


class OriginError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _install_native_host_failover(api):
    if getattr(api, "_movieapi_native_host_failover", False):
        return
    original_request = api.api_request
    bases = tuple(dict.fromkeys(
        value.rstrip("/") for value in (NATIVE_API_BASE, BOOTSTRAP_HOST)
        if isinstance(value, str) and urlsplit(value).scheme == "https"
    ))
    approved_hosts = {"api3.aoneroom.com", "apig.inmoviebox.com"}
    bases = tuple(base for base in bases if urlsplit(base).hostname in approved_hosts)

    def request(method, path_or_url, body_dict=None, use_token=True, retry_auth=True):
        if not isinstance(path_or_url, str):
            return original_request(method, path_or_url, body_dict, use_token, retry_auth)
        parsed = urlsplit(path_or_url)
        if parsed.scheme or parsed.netloc:
            if parsed.scheme != "https" or parsed.hostname not in approved_hosts:
                return original_request(method, path_or_url, body_dict, use_token, retry_auth)
            first = f"{parsed.scheme}://{parsed.netloc}"
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            candidates = (first, *(base for base in bases if base != first))
        else:
            path = path_or_url if path_or_url.startswith("/") else "/" + path_or_url
            candidates = bases

        for base in candidates:
            try:
                return original_request(
                    method,
                    base + path,
                    body_dict=body_dict,
                    use_token=use_token,
                    retry_auth=retry_auth,
                )
            except Exception:
                continue
        raise OriginError(
            "Movie data is temporarily unavailable. Please try again shortly.",
            502,
        ) from None

    api.api_request = request
    api._movieapi_native_host_failover = True


class _MovieBoxPageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.nuxt_data = []
        self.anchors = []
        self._script = False
        self._anchor = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "script" and values.get("id") == "__NUXT_DATA__":
            self._script = True
        elif tag == "a":
            self._anchor = {
                "href": values.get("href", ""),
                "text": [],
                "thumbnail": None,
            }
        elif tag == "img" and self._anchor is not None:
            self._anchor["thumbnail"] = values.get("src")

    def handle_endtag(self, tag):
        if tag == "script" and self._script:
            self._script = False
        elif tag == "a" and self._anchor is not None:
            self.anchors.append(self._anchor)
            self._anchor = None

    def handle_data(self, data):
        if self._script:
            self.nuxt_data.append(data)
        if self._anchor is not None:
            self._anchor["text"].append(data)


def _response_error(message: str, status: int) -> JSONResponse:
    return JSONResponse({"message": message}, status_code=status, headers={"Cache-Control": "no-store"})


def _safe_media_url(value: str):
    if not isinstance(value, str) or not value or len(value) > 8192:
        raise OriginError("Media host is not permitted", 400)
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except ValueError:
        raise OriginError("Media host is not permitted", 400) from None
    if (
        parsed.scheme.lower() != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or (port is not None and port != 443)
        or parsed.fragment
        or not any(host == suffix or host.endswith("." + suffix) for suffix in _media_hosts)
    ):
        raise OriginError("Media host is not permitted", 400)
    return parsed


def _media_headers(value) -> dict[str, str]:
    if value is None:
        value = {}
    if not isinstance(value, dict) or len(value) > 24:
        raise OriginError("Invalid media headers", 400)
    result = {}
    allowed = {"referer", "origin", "user-agent", "cookie", "accept", "accept-language"}
    forbidden = {
        "host",
        "authorization",
        "proxy-authorization",
        "connection",
        "content-length",
        "transfer-encoding",
        "range",
    }
    for name, raw in value.items():
        if not isinstance(name, str) or not _header_name.fullmatch(name) or name.lower() in forbidden:
            raise OriginError("Invalid media headers", 400)
        if not isinstance(raw, str) or len(raw) > 4096 or "\r" in raw or "\n" in raw:
            raise OriginError("Invalid media headers", 400)
        if name.lower() in allowed:
            result[name] = raw
    result.setdefault("User-Agent", "Mozilla/5.0")
    result["Accept-Encoding"] = "identity"
    return result


def _dash_playable(url: str, headers: dict[str, str]) -> bool:
    try:
        _safe_media_url(url)
    except OriginError:
        return False
    header_fingerprint = json.dumps(
        sorted((name.lower(), value) for name, value in headers.items()),
        separators=(",", ":"),
    )
    fingerprint = hashlib.sha256((url + header_fingerprint).encode("utf-8")).hexdigest()
    now = time.monotonic()
    with _dash_probe_lock:
        cached = _dash_probe_cache.get(fingerprint)
        if cached and cached[0] > now:
            return cached[1]
    response = None
    available = False
    try:
        client = CurlStreamClient()
        response = client.send(client.build_request("GET", url, _media_headers(headers)))
        available = (
            response.status_code == 200
            and "dash" in response.headers.get("content-type", "").lower()
        )
    except Exception:
        available = False
    finally:
        if response is not None:
            response.close()
    with _dash_probe_lock:
        if len(_dash_probe_cache) >= 300:
            _dash_probe_cache.pop(next(iter(_dash_probe_cache)))
        _dash_probe_cache[fingerprint] = (time.monotonic() + 120, available)
    return available


def _duration_seconds(value) -> float:
    try:
        return max(0.0, float(value or 0))
    except (TypeError, ValueError):
        return 0.0


def _open_ticket(ticket: str) -> dict:
    try:
        if not isinstance(ticket, str) or len(ticket) > 18000:
            raise ValueError()
        padded = ticket + ("=" * (-len(ticket) % 4))
        packed = base64.urlsafe_b64decode(padded.encode("ascii"))
        if len(packed) < 29:
            raise ValueError()
        iv, tag, ciphertext = packed[:12], packed[12:28], packed[28:]
        key = hashlib.sha256(RELAY_SECRET.encode("utf-8")).digest()
        data = json.loads(AESGCM(key).decrypt(iv, ciphertext + tag, None))
        if not isinstance(data, dict):
            raise ValueError()
    except Exception:
        raise OriginError("Invalid playback ticket", 401) from None

    expiry = data.get("exp")
    if not isinstance(expiry, (int, float)) or expiry < time.time() * 1000:
        raise OriginError("Playback ticket expired; request fresh sources", 401)
    return data


def _unwrap(payload):
    if isinstance(payload, dict):
        code = payload.get("code")
        if code is not None and str(code) not in {"0", "200"}:
            raise OriginError("MovieBox rejected the request", 502)
        return payload.get("data", payload)
    return payload


def _decode_nuxt(table, value, depth=0):
    if depth > 40:
        return None
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        if value < 0 or value >= len(table):
            return None
        return _decode_nuxt(table, table[value], depth + 1)
    if isinstance(value, list):
        return [_decode_nuxt(table, child, depth + 1) for child in value]
    if isinstance(value, dict):
        return {key: _decode_nuxt(table, child, depth + 1) for key, child in value.items()}
    return value


class MovieBoxService:
    def __init__(self, api: MovieBoxEngine):
        self.api = api
        _install_native_host_failover(api)
        self._token_seen = api.bearer_token

    def _web_bootstrap(self) -> bool:
        for host in _web_hosts:
            url = f"{host}/wefeed-h5api-bff/home?host=movieboxhd.net"
            response = None
            try:
                response = self.api.session.get(
                    url,
                    headers={"User-Agent": WEB_USER_AGENT, "Referer": host + "/"},
                    timeout=10,
                    stream=True,
                )
                raw = response.headers.get("x-user")
                token = json.loads(raw).get("token") if raw else None
                if token:
                    self.api.bearer_token = token
                    self._token_seen = token
                    return True
            except Exception:
                continue
            finally:
                if response is not None:
                    try:
                        response.close()
                    except Exception:
                        pass
        return False

    def ensure_token(self, force=False):
        global _token_deadline
        with _bootstrap_lock:
            now = time.monotonic()
            if (
                not force
                and self.api.bearer_token
                and self.api.bearer_token == self._token_seen
                and now < _token_deadline
            ):
                return self.api.bearer_token
            if force or now >= _token_deadline:
                self.api.bearer_token = None
            if self._web_bootstrap():
                _token_deadline = time.monotonic() + 40 * 60
                return self.api.bearer_token
            try:
                token = self.api.bootstrap_token(force=True)
                self._token_seen = token
                _token_deadline = time.monotonic() + 40 * 60
                return token
            except Exception:
                raise OriginError("MovieBox session is temporarily unavailable", 502) from None

    def web(self, path, params=None, body=None, bootstrap=True):
        if bootstrap:
            self.ensure_token()
        last_error = None
        for host in _web_hosts:
            url = host + "/wefeed-h5api-bff" + path
            if params:
                url += "?" + urlencode(params, doseq=True)
            headers = dict(_web_headers)
            if self.api.bearer_token:
                headers["Authorization"] = "Bearer " + self.api.bearer_token
            try:
                if body is None:
                    response = self.api.session.get(url, headers=headers, timeout=12)
                else:
                    response = self.api.session.post(url, headers=headers, json=body, timeout=12)
                if response.status_code != 200:
                    raise OriginError("MovieBox web request failed", 502)
                data = _unwrap(response.json())
                if path == "/home":
                    token_header = response.headers.get("x-user")
                    token = json.loads(token_header).get("token") if token_header else None
                    if token:
                        self.api.bearer_token = token
                        self._token_seen = token
                        global _token_deadline
                        _token_deadline = time.monotonic() + 40 * 60
                return data
            except OriginError as error:
                last_error = error
            except Exception:
                last_error = OriginError("MovieBox web request failed", 502)
        raise last_error or OriginError("MovieBox web request failed", 502)

    @staticmethod
    def normalize(item):
        if not isinstance(item, dict):
            item = {}
        subject = item.get("subject") if isinstance(item.get("subject"), dict) else item
        cover = subject.get("cover") or subject.get("image") or subject.get("thumbnail")
        if isinstance(cover, dict):
            cover = cover.get("url")
        subject_id = str(subject.get("subjectId") or subject.get("id") or "")
        genre = subject.get("genre")
        genres = [part.strip() for part in genre.split(",") if part.strip()] if isinstance(genre, str) else subject.get("genres") or []
        return {
            **subject,
            "id": subject_id,
            "subjectId": subject_id,
            "title": subject.get("title") or subject.get("name") or "",
            "thumbnail": cover,
            "description": subject.get("description"),
            "subjectType": subject.get("subjectType"),
            "genres": genres,
            "rating": subject.get("imdbRatingValue"),
        }

    def info(self, subject_id):
        try:
            data = self.web("/detail", params={"subjectId": subject_id})
        except OriginError:
            fallback = self.api.get_details(subject_id)
            subject = {
                "subjectId": fallback.get("subject_id"),
                "title": fallback.get("title"),
                "subjectType": fallback.get("subject_type"),
                "description": fallback.get("description"),
                "releaseDate": fallback.get("release_date"),
                "duration": fallback.get("duration"),
                "imdbRatingValue": fallback.get("imdb_rating"),
                "genre": fallback.get("genre"),
                "countryName": fallback.get("country"),
                "language": fallback.get("language"),
                "cover": fallback.get("cover"),
            }
            normalized = self.normalize(subject)
            normalized.update({
                "detailPath": fallback.get("detail_path") or "",
                "resource": None,
                "stars": None,
                "metadata": None,
                "dubs": fallback.get("dubs") or [],
            })
            return normalized
        if not isinstance(data, dict):
            data = {}
        subject = data.get("subject") if isinstance(data.get("subject"), dict) else data
        result = self.normalize(subject)
        dubs = (
            data.get("dubs")
            or subject.get("dubs")
            or data.get("audioTracks")
            or subject.get("audioTracks")
            or []
        )
        detail_url = data.get("detailUrl") or subject.get("detailUrl") or subject.get("detailPath")
        detail_path = str(detail_url or "").rstrip("/").split("/")[-1]
        if not detail_path:
            try:
                fallback = self.api.get_details(subject_id)
                detail_path = fallback.get("detail_path", "")
                result.setdefault("title", fallback.get("title") or "")
                if not dubs:
                    dubs = fallback.get("dubs") or []
            except Exception:
                pass
        result.update({
            "detailPath": detail_path,
            "resource": data.get("resource"),
            "stars": data.get("stars"),
            "metadata": data.get("metadata"),
            "dubs": dubs,
        })
        return result

    def call(self, action, params):
        subject_id = str(params.get("id") or "")
        if action == "home":
            return self.web("/home", params={"host": "movieboxhd.net"}, bootstrap=False)
        if action == "search":
            query = str(params.get("query") or "").strip()
            if not query:
                raise OriginError("A search query is required", 400)
            page = max(1, int(params.get("page") or 1))
            per_page = min(100, max(1, int(params.get("perPage") or 20)))
            try:
                data = self.web(
                    "/subject/search",
                    body={"keyword": query, "page": page, "perPage": per_page},
                )
            except OriginError:
                fallback_items = self.api.search(query, page, per_page)
                return {
                    "items": [self.normalize({
                        "subjectId": row.get("subject_id"),
                        "title": row.get("title"),
                        "subjectType": row.get("subject_type"),
                        "releaseDate": row.get("release_date"),
                        "imdbRatingValue": row.get("imdb_rating"),
                        "genre": row.get("genre"),
                        "cover": row.get("cover"),
                    }) for row in fallback_items],
                    "pager": None,
                }
            if not isinstance(data, dict):
                data = {}
            items = data.get("items") or data.get("list") or []
            return {"items": [self.normalize(item) for item in items], "pager": data.get("pager")}
        if action == "info":
            return self.info(subject_id)
        if action == "episodes":
            info = self.info(subject_id)
            resource = info.get("resource") if isinstance(info.get("resource"), dict) else {}
            seasons = resource.get("seasons") if isinstance(resource, dict) else None
            if not isinstance(seasons, list):
                seasons = [
                    {
                        "se": row.get("season", 1),
                        "maxEp": row.get("episode_count", 1),
                        "resolutions": row.get("resolutions") or [],
                    }
                    for row in self.api.get_episodes(subject_id)
                ]
            return {"title": info.get("title"), "seasons": seasons}
        if action == "filter":
            return self.web(
                "/subject/filter",
                body={
                    "tabId": 5 if int(params.get("type") or 1) == 2 else 4,
                    "filter": {
                        "sort": params.get("sort") or "RECOMMEND",
                        "genre": params.get("genre") or "ALL",
                        "country": params.get("country") or "ALL",
                        "year": params.get("year") or "ALL",
                        "language": params.get("language") or "ALL",
                    },
                    "page": max(1, int(params.get("page") or 1)),
                    "perPage": min(100, max(1, int(params.get("perPage") or 20))),
                },
            )
        if action == "sources":
            info = self.info(subject_id)
            season = int(params.get("season") or 0)
            episode = int(params.get("episode") or 0)
            streams = self.api.get_streams(
                subject_id,
                season,
                episode,
                info.get("detailPath"),
            )
            caption_stream_id = next(
                (
                    str(value)
                    for stream in streams
                    if isinstance(stream, dict)
                    for value in (stream.get("_caption_stream_id"), stream.get("id"))
                    if value is not None and str(value).isdigit()
                ),
                "",
            )
            results = []
            full_duration = max(
                (_duration_seconds(row.get("duration_sec")) for row in streams), default=0
            )
            for stream in streams:
                url = stream.get("url")
                if not url:
                    continue
                duration = _duration_seconds(stream.get("duration_sec"))
                if full_duration > 600 and 0 < duration < full_duration / 2:
                    continue
                headers = dict(stream.get("headers") or {})
                cookie = stream.get("cookie")
                if cookie:
                    headers.setdefault("Cookie", cookie)
                stream_format = str(
                    stream.get("format") or ("DASH" if ".mpd" in url else "MP4")
                )
                is_dash = stream_format.lower() in {"dash", "mpd"} or urlsplit(url).path.lower().endswith(".mpd")
                if is_dash and not _dash_playable(url, headers):
                    continue
                quality_value = int(stream.get("quality_value") or 0)
                if is_dash and quality_value == 999:
                    quality_value = 0
                codec = stream.get("codec") or ""
                results.append({
                    "id": str(
                        stream.get("_caption_stream_id")
                        or caption_stream_id
                        or stream.get("id")
                        or ""
                    ),
                    "url": url,
                    "quality": stream.get("quality") or "Default",
                    "qualityValue": quality_value,
                    "format": stream_format,
                    "size": stream.get("size_bytes"),
                    "duration": duration or None,
                    "codec": codec,
                    "browserCompatible": not bool(re.search(r"hevc|h265|hvc1|hev1", codec, re.I)),
                    "requireMemberType": 0,
                    "headers": headers,
                })
            if not results:
                raise OriginError("MovieBox returned no playable sources for this title/episode", 404)
            results.sort(key=lambda row: row["qualityValue"], reverse=True)
            try:
                subtitles = self.api.get_subtitles(
                    subject_id,
                    caption_stream_id or None,
                    season,
                    episode,
                )
            except Exception:
                subtitles = []
            audio_tracks = info.get("dubs") or []
            if not audio_tracks:
                try:
                    audio_tracks = self.api.get_details(subject_id).get("dubs") or []
                except Exception:
                    audio_tracks = []
            return {
                "title": info.get("title") or "",
                "results": results,
                "subtitles": subtitles,
                "audioTracks": audio_tracks,
            }
        if action == "captions":
            return self.api.get_subtitles(
                subject_id,
                str(params.get("streamId") or "") or None,
                int(params.get("season") or 0),
                int(params.get("episode") or 0),
            )
        if action in {"football", "football-info", "football-sources"}:
            return self.football(params, action)
        raise OriginError("Unknown MovieBox action", 400)

    def football(self, params, action):
        url = "https://movieboxhd.net/live"
        try:
            response = self.api.session.get(
                url,
                headers={"User-Agent": WEB_USER_AGENT},
                timeout=20,
            )
            if response.status_code != 200:
                raise OriginError("MovieBox football page is unavailable", 502)
            html = response.text
        except OriginError:
            raise
        except Exception:
            raise OriginError("MovieBox football page is unavailable", 502) from None

        parser = _MovieBoxPageParser()
        parser.feed(html)
        matches, seen = [], set()
        raw_nuxt = "".join(parser.nuxt_data)
        if raw_nuxt:
            try:
                table = json.loads(raw_nuxt)
                entry = next(
                    (row for row in table if isinstance(row, dict) and "matchList" in row),
                    None,
                )
                if entry is not None:
                    rows = _decode_nuxt(table, entry.get("matchList")) or []
                    for match in rows:
                        if not isinstance(match, dict) or str(match.get("type", "")).lower() != "football":
                            continue
                        match_id = str(match.get("id") or "")
                        team1 = match.get("team1") if isinstance(match.get("team1"), dict) else {}
                        team2 = match.get("team2") if isinstance(match.get("team2"), dict) else {}
                        matches.append({
                            **match,
                            "id": match_id,
                            "title": f"{team1.get('name') or ''} vs {team2.get('name') or ''}",
                            "source": "MovieBox",
                            "detailUrl": f"https://movieboxhd.net/live/detail?id={match_id}&sportType=football",
                        })
                        seen.add(match_id)
            except (ValueError, TypeError, StopIteration):
                pass

        for anchor in parser.anchors:
            href = anchor.get("href") or ""
            if not re.search(r"/live/(?:detail|match|football)|/sports-detail/", href, re.I):
                continue
            full_url = urljoin("https://movieboxhd.net", href)
            parsed = urlsplit(full_url)
            query = parse_qs(parsed.query)
            if (query.get("sportType") or [""])[0] != "football":
                continue
            match_id = (query.get("id") or [parsed.path.rstrip("/").split("/")[-1]])[0]
            if not match_id or match_id in seen:
                continue
            seen.add(match_id)
            matches.append({
                "id": match_id,
                "title": " ".join("".join(anchor.get("text") or "").split()),
                "thumbnail": anchor.get("thumbnail"),
                "detailUrl": full_url,
            })

        if not matches:
            raise OriginError("MovieBox football feed is unavailable", 502)
        match_id = str(params.get("id") or "")
        if match_id:
            match = next((row for row in matches if row.get("id") == match_id), None)
            if match is None:
                raise OriginError("Match not found in the current MovieBox football feed", 404)
            if action == "football-sources":
                play_path = match.get("playPath")
                if not isinstance(play_path, str) or not play_path.startswith("https://"):
                    raise OriginError("This match has no playable source yet", 404)
                return {
                    "title": match.get("title") or "Live football",
                    "results": [{
                        "id": match_id,
                        "url": play_path,
                        "quality": "Live",
                        "qualityValue": 0,
                        "format": "HLS",
                        "browserCompatible": True,
                        "headers": {
                            "User-Agent": WEB_USER_AGENT,
                            "Referer": "https://movieboxhd.net/",
                            "Origin": "https://movieboxhd.net",
                        },
                    }],
                    "subtitles": [],
                    "audioTracks": [],
                }
            return match
        return {"items": matches, "source": "MovieBox"}


service = MovieBoxService(engine)
_actions = {
    "home",
    "search",
    "info",
    "episodes",
    "filter",
    "sources",
    "captions",
    "football",
    "football-info",
    "football-sources",
}


@app.middleware("http")
async def authenticate_and_limit(request: Request, call_next):
    if request.url.path.startswith("/internal/"):
        supplied = request.headers.get("x-relay-secret", "")
        if not supplied or not hmac.compare_digest(supplied, RELAY_SECRET):
            return _response_error("Unauthorized", 401)
        try:
            declared_length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return _response_error("Invalid request", 400)
        if declared_length > 32 * 1024:
            return _response_error("Request body is too large", 413)
        body = await request.body()
        if len(body) > 32 * 1024:
            return _response_error("Request body is too large", 413)
        request._body = body
    return await call_next(request)


@app.get("/health")
def health():
    return {"success": True, "service": "movieapi-origin", "version": "2.0.0"}


@app.post("/internal/moviebox")
async def moviebox(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return _response_error("Invalid JSON request", 400)
    if not isinstance(payload, dict):
        return _response_error("Invalid request", 400)
    action = payload.get("action")
    params = payload.get("params") or {}
    if action not in _actions:
        return _response_error("Unknown MovieBox action", 400)
    if not isinstance(params, dict):
        return _response_error("Invalid MovieBox parameters", 400)
    try:
        result = await run_in_threadpool(service.call, action, params)
        return JSONResponse({"results": result}, headers={"Cache-Control": "no-store"})
    except OriginError as error:
        return _response_error(str(error), error.status)
    except Exception:
        # Avoid logging or returning signed URLs, cookies, or upstream credentials.
        return _response_error("Movie data is temporarily unavailable. Please try again shortly.", 502)


def _start_media(url, headers, range_value, method, if_range_value=None):
    current = url
    current_headers = dict(headers)
    for _ in range(5):
        response = None
        try:
            transport = CurlStreamClient()
            request_headers = dict(current_headers)
            if range_value:
                request_headers["Range"] = range_value
            if if_range_value:
                request_headers["If-Range"] = if_range_value
            request = transport.build_request(
                method,
                current,
                request_headers,
            )
            response = transport.send(request)
        except Exception:
            raise OriginError("MovieBox media request failed", 502) from None
        if response.status_code not in _redirect_statuses:
            return response
        location = response.headers.get("location")
        response.close()
        if not location:
            raise OriginError("MovieBox media redirect is invalid", 502)
        next_url = urljoin(current, location)
        next_parts = _safe_media_url(next_url)
        current_parts = urlsplit(current)
        if next_parts.hostname != current_parts.hostname:
            current_headers = {
                key: value for key, value in current_headers.items()
                if key.lower() in {"user-agent", "referer", "origin", "accept", "accept-language"}
            }
        current = next_url
    raise OriginError("Too many MovieBox media redirects", 502)


@app.post("/internal/moviebox-media")
async def moviebox_media(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return _response_error("Invalid JSON request", 400)
    if not isinstance(payload, dict):
        return _response_error("Invalid request", 400)
    try:
        ticket = _open_ticket(payload.get("ticket"))
        target = ticket.get("url")
        _safe_media_url(target)
        headers = _media_headers(ticket.get("headers"))
        range_value = request.headers.get("range")
        if_range_value = request.headers.get("if-range")
        if range_value and not _range_value.fullmatch(range_value):
            return _response_error("Only a single byte range is supported", 416)
        method = "HEAD" if payload.get("method") == "HEAD" else "GET"
    except OriginError as error:
        return _response_error(str(error), error.status)

    if not _media_slots.acquire(blocking=False):
        return _response_error("Media relay is at capacity", 503)
    try:
        upstream = await run_in_threadpool(
            _start_media, target, headers, range_value, method, if_range_value
        )
    except OriginError as error:
        _media_slots.release()
        return _response_error(str(error), error.status)

    status = int(upstream.status_code or 502)
    forwarded = {
        name: value
        for name, value in upstream.headers.items()
        if name.lower() in _media_response_headers
    }
    closed = False
    close_lock = threading.Lock()

    def close_upstream():
        nonlocal closed
        with close_lock:
            if closed:
                return
            closed = True
        try:
            upstream.close()
        finally:
            _media_slots.release()

    if status not in {200, 206, 416}:
        close_upstream()
        if status == 429:
            return _response_error("MovieBox media host rate-limited the request", 429)
        return JSONResponse(
            {"message": "MovieBox media host rejected the request", "upstreamStatus": status},
            status_code=status if 400 <= status < 600 else 502,
            headers={"Cache-Control": "no-store"},
        )
    if method == "HEAD" or status == 416:
        if method == "HEAD":
            length = forwarded.pop("content-length", None)
            if length:
                forwarded["X-Media-Content-Length"] = length
        close_upstream()
        return Response(status_code=status, headers=forwarded)

    def stream_body():
        try:
            yield from upstream.iter_raw()
        finally:
            close_upstream()

    return StreamingResponse(
        stream_body(),
        status_code=status,
        headers=forwarded,
        background=BackgroundTask(close_upstream),
    )


@app.exception_handler(Exception)
async def unexpected_error(_request: Request, _error: Exception):
    return _response_error("Internal MovieAPI origin error", 500)
