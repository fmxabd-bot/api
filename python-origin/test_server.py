import base64
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import sys
import types
import unittest
import zipfile


os.environ.setdefault("RELAY_SECRET", "unit-test-relay-secret")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "movieapi" / "media-transport"))
import curl_transport  # noqa: E402

engine_module = types.ModuleType("engine")
with zipfile.ZipFile(ROOT / "attached_assets" / "provider_(1)_1792978236105.zip") as archive:
    source = archive.read("provider/engine.py").decode("utf-8")
exec(compile(source, "engine.py", "exec"), engine_module.__dict__)
sys.modules["engine"] = engine_module

import server  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def make_ticket(url, headers=None, expiry_ms=4_000_000_000_000):
    payload = json.dumps({
        "url": url,
        "headers": headers or {"User-Agent": "test-agent"},
        "exp": expiry_ms,
    }, separators=(",", ":")).encode()
    key = hashlib.sha256(os.environ["RELAY_SECRET"].encode()).digest()
    iv = b"0123456789ab"
    sealed = AESGCM(key).encrypt(iv, payload, None)
    packed = iv + sealed[-16:] + sealed[:-16]
    return base64.urlsafe_b64encode(packed).decode().rstrip("=")


class FakeResponse:
    def __init__(self, status, headers=None, chunks=()):
        self.status_code = status
        self.headers = headers or {}
        self.chunks = chunks
        self.closed = False

    def iter_raw(self, size=65536):
        yield from self.chunks

    def close(self):
        self.closed = True


class FakeCurlClient:
    def __init__(self, responses):
        self.responses = deque(responses)
        self.requests = []

    def build_request(self, method, url, headers):
        return method, url, headers

    def send(self, request, stream=True):
        self.requests.append(request)
        return self.responses.popleft()


class PythonOriginTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.auth = {"x-relay-secret": os.environ["RELAY_SECRET"]}

    def test_health_is_public_and_identifies_origin(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["service"], "movieapi-origin")

    def test_internal_routes_require_relay_secret(self):
        response = self.client.post("/internal/moviebox", json={"action": "home"})
        self.assertEqual(response.status_code, 401)

    def test_moviebox_action_envelope_is_worker_compatible(self):
        original = server.service

        class StubService:
            def call(self, action, params):
                return {"action": action, "params": params}

        server.service = StubService()
        try:
            response = self.client.post(
                "/internal/moviebox",
                headers=self.auth,
                json={"action": "search", "params": {"query": "test"}},
            )
        finally:
            server.service = original
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"]["action"], "search")

    def test_native_content_request_retries_the_second_approved_host(self):
        class FakeNativeAPI:
            def __init__(self):
                self.calls = []

            def api_request(self, method, url, **kwargs):
                self.calls.append((method, url, kwargs))
                if len(self.calls) == 1:
                    raise RuntimeError("primary host unavailable")
                return {"data": {"items": []}}

        api = FakeNativeAPI()
        server._install_native_host_failover(api)
        result = api.api_request(
            "POST",
            "/wefeed-mobile-bff/subject-api/search",
            body_dict={"keyword": "test"},
        )
        self.assertEqual(result, {"data": {"items": []}})
        self.assertTrue(api.calls[0][1].startswith(server.NATIVE_API_BASE))
        self.assertTrue(api.calls[1][1].startswith(server.BOOTSTRAP_HOST))

    def test_native_failover_returns_a_safe_error_if_both_hosts_fail(self):
        class FakeNativeAPI:
            def api_request(self, method, url, **kwargs):
                raise RuntimeError(f"private upstream detail at {url}")

        api = FakeNativeAPI()
        server._install_native_host_failover(api)
        with self.assertRaises(server.OriginError) as caught:
            api.api_request("GET", "/wefeed-mobile-bff/subject-api/get?subjectId=1")
        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(
            str(caught.exception),
            "Movie data is temporarily unavailable. Please try again shortly.",
        )

    def test_info_preserves_audio_dubs_nested_under_subject(self):
        service = server.service
        original_web = service.web
        original_details = service.api.get_details
        dubs = [{"subject_id": "987654321", "lang_name": "English", "language": "en"}]
        service.web = lambda *args, **kwargs: {
            "subject": {
                "subjectId": "987654321",
                "title": "Test title",
                "detailUrl": "https://moviebox.ph/movies/test-title",
                "dubs": dubs,
            },
            "resource": {},
        }
        service.api.get_details = lambda subject_id: self.fail(
            "native details should not be needed when nested dubs exist"
        )
        try:
            result = service.info("987654321")
        finally:
            service.web = original_web
            service.api.get_details = original_details
        self.assertEqual(result["dubs"], dubs)

    def test_media_range_uses_http2_transport_and_streams_bytes(self):
        fake = FakeCurlClient([FakeResponse(
            206,
            {"content-type": "video/mp4", "content-range": "bytes 0-4/5", "content-length": "5"},
            [b"video"],
        )])
        original = server.CurlStreamClient
        server.CurlStreamClient = lambda: fake
        try:
            response = self.client.post(
                "/internal/moviebox-media",
                headers={**self.auth, "Range": "bytes=0-4", "If-Range": '"etag-value"'},
                json={"ticket": make_ticket("https://cdn.aoneroom.com/video.mp4"), "method": "GET"},
            )
        finally:
            server.CurlStreamClient = original
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, b"video")
        self.assertEqual(fake.requests[0][2]["Range"], "bytes=0-4")
        self.assertEqual(fake.requests[0][2]["If-Range"], '"etag-value"')

    def test_media_relay_caps_concurrency_and_returns_capacity_error(self):
        self.assertEqual(server.MAX_STREAMS, 8)
        self.assertEqual(curl_transport.MAX_STREAM_QUEUE_CHUNKS, 8)
        acquired = 0
        try:
            for _ in range(server.MAX_STREAMS):
                if not server._media_slots.acquire(blocking=False):
                    self.fail("expected to acquire every media slot")
                acquired += 1
            response = self.client.post(
                "/internal/moviebox-media",
                headers=self.auth,
                json={
                    "ticket": make_ticket("https://cdn.aoneroom.com/video.mp4"),
                    "method": "GET",
                },
            )
        finally:
            for _ in range(acquired):
                server._media_slots.release()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["message"], "Media relay is at capacity")

    def test_head_preserves_upstream_length_for_worker_hop(self):
        fake = FakeCurlClient([FakeResponse(200, {
            "content-type": "video/mp4",
            "content-length": "12345",
        })])
        original = server.CurlStreamClient
        server.CurlStreamClient = lambda: fake
        try:
            response = self.client.post(
                "/internal/moviebox-media",
                headers=self.auth,
                json={"ticket": make_ticket("https://cdn.aoneroom.com/video.mp4"), "method": "HEAD"},
            )
        finally:
            server.CurlStreamClient = original
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("x-media-content-length"), "12345")

    def test_media_proxy_rejects_redirects_outside_moviebox_allowlist(self):
        fake = FakeCurlClient([FakeResponse(302, {"location": "https://untrusted.example/video.mp4"})])
        original = server.CurlStreamClient
        server.CurlStreamClient = lambda: fake
        try:
            response = self.client.post(
                "/internal/moviebox-media",
                headers=self.auth,
                json={"ticket": make_ticket("https://cdn.aoneroom.com/video.mp4"), "method": "GET"},
            )
        finally:
            server.CurlStreamClient = original
        self.assertEqual(response.status_code, 400)
        self.assertEqual(len(fake.requests), 1)

    def test_sources_omit_dash_when_moviebox_rejects_the_manifest(self):
        fake = FakeCurlClient([FakeResponse(403, {"content-type": "text/html"})])
        service = server.service
        original_info = service.info
        original_streams = service.api.get_streams
        original_client = server.CurlStreamClient
        service.info = lambda subject_id: {"title": "Test title", "detailPath": ""}
        service.api.get_streams = lambda subject_id, season, episode, detail_path: [
            {
                "id": "dash",
                "url": "https://cdn.aoneroom.com/test-dash-filter.mpd?case=403",
                "format": "DASH",
                "quality": "Adaptive",
                "quality_value": 999,
                "headers": {"User-Agent": "test-agent"},
            },
            {
                "id": "mp4",
                "url": "https://cdn.aoneroom.com/test-video.mp4",
                "format": "MP4",
                "quality": "720p",
                "quality_value": 720,
            },
        ]
        server.CurlStreamClient = lambda: fake
        try:
            result = service.call("sources", {"id": "test-subject"})
        finally:
            service.info = original_info
            service.api.get_streams = original_streams
            server.CurlStreamClient = original_client
        self.assertEqual([row["format"] for row in result["results"]], ["MP4"])
        self.assertEqual(fake.requests[0][0], "GET")

    def test_sources_include_caption_stream_ids_subtitles_and_audio_tracks(self):
        service = server.service
        original_info = service.info
        original_streams = service.api.get_streams
        original_subtitles = service.api.get_subtitles
        original_details = service.api.get_details
        subtitle_calls = []
        expected_subtitles = [{
            "id": "caption-1",
            "language": "English",
            "code": "en",
            "url": "https://captions.example.test/movie.vtt",
            "size": 100,
        }]
        expected_audio_tracks = [{
            "subject_id": "987654321",
            "lang_name": "English",
            "language": "en",
        }]
        service.info = lambda subject_id: {
            "title": "Test title",
            "detailPath": "test-title",
            "dubs": [],
        }
        service.api.get_streams = lambda subject_id, season, episode, detail_path: [{
            "id": "123456789",
            "url": "https://cdn.aoneroom.com/test-video.mp4",
            "format": "MP4",
            "quality": "720p",
            "quality_value": 720,
        }]

        def get_subtitles(subject_id, stream_id=None, season=0, episode=0):
            subtitle_calls.append((subject_id, stream_id, season, episode))
            return expected_subtitles

        service.api.get_subtitles = get_subtitles
        service.api.get_details = lambda subject_id: {"dubs": expected_audio_tracks}
        try:
            result = service.call("sources", {
                "id": "987654321",
                "season": 1,
                "episode": 2,
            })
            stream_id = result["results"][0]["id"]
            caption_result = service.call("captions", {
                "id": "987654321",
                "streamId": stream_id,
                "season": 1,
                "episode": 2,
            })
        finally:
            service.info = original_info
            service.api.get_streams = original_streams
            service.api.get_subtitles = original_subtitles
            service.api.get_details = original_details

        self.assertEqual(stream_id, "123456789")
        self.assertEqual(result["subtitles"], expected_subtitles)
        self.assertEqual(result["audioTracks"], expected_audio_tracks)
        self.assertEqual(caption_result, expected_subtitles)
        self.assertEqual(subtitle_calls[0], ("987654321", "123456789", 1, 2))
        self.assertEqual(subtitle_calls[1], ("987654321", "123456789", 1, 2))

    def test_expired_ticket_is_rejected(self):
        response = self.client.post(
            "/internal/moviebox-media",
            headers=self.auth,
            json={"ticket": make_ticket("https://cdn.aoneroom.com/video.mp4", expiry_ms=1), "method": "GET"},
        )
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
