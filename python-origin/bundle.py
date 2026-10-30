"""Build the source bundle used to convert the existing Railway service in place."""

import base64
import json
from pathlib import Path
import sys
import zipfile
import zlib


ROOT = Path(__file__).resolve().parents[2]
UPLOAD = ROOT / "attached_assets" / "provider_(1)_1792978236105.zip"
SOURCE_FILES = {
    "server.py": Path(__file__).with_name("server.py").read_text(encoding="utf-8"),
    "curl_transport.py": (ROOT / "movieapi" / "media-transport" / "curl_transport.py").read_text(encoding="utf-8"),
    "requirements.txt": Path(__file__).with_name("requirements.txt").read_text(encoding="utf-8"),
}


def replace_once(source: str, before: str, after: str, label: str) -> str:
    count = source.count(before)
    if count != 1:
        raise SystemExit(f"Expected one provider {label} marker, found {count}.")
    return source.replace(before, after, 1)


def patch_engine_source(source: str) -> str:
    # Preserve the provider's resource IDs so callers can pass them to captions.
    source = replace_once(
        source,
        '                        streams.append({\n                            "source": f"Web CDN ({domain})",',
        '                        streams.append({\n'
        '                            "id": str(st.get("id") or st.get("streamId") or st.get("resourceId") or ""),\n'
        '                            "source": f"Web CDN ({domain})",',
        "web stream ID",
    )
    source = replace_once(
        source,
        '                            streams.append({\n                                "source": f"Web DASH ({domain})",',
        '                            streams.append({\n'
        '                                "id": str(d.get("id") or d.get("streamId") or d.get("resourceId") or ""),\n'
        '                                "source": f"Web DASH ({domain})",',
        "DASH stream ID",
    )
    source = replace_once(
        source,
        '                streams.append({\n                    "source": "Mobile Native CDN",',
        '                streams.append({\n'
        '                    "id": str(st.get("id") or st.get("streamId") or st.get("resourceId") or ""),\n'
        '                    "source": "Mobile Native CDN",',
        "native stream ID",
    )
    source = replace_once(
        source,
        '''            caption_stream_id = next(
                (str(st["id"]) for st in native_streams if isinstance(st, dict) and st.get("id")), ""
            )''',
        '''            caption_stream_id = next(
                (
                    str(st.get("id") or st.get("streamId") or st.get("resourceId"))
                    for st in native_streams
                    if isinstance(st, dict) and (st.get("id") or st.get("streamId") or st.get("resourceId"))
                ),
                "",
            )''',
        "caption stream ID",
    )
    source = replace_once(
        source,
        '''                if raw_streams and raw_streams[0].get("id"):
                    stream_id = str(raw_streams[0]["id"])''',
        '''                candidate_stream_id = next(
                    (
                        item.get("id") or item.get("streamId") or item.get("resourceId")
                        for item in raw_streams
                        if isinstance(item, dict)
                        and (item.get("id") or item.get("streamId") or item.get("resourceId"))
                    ),
                    None,
                )
                if candidate_stream_id is not None:
                    stream_id = str(candidate_stream_id)''',
        "subtitle stream ID fallback",
    )

    details_start = source.index("    def get_details(")
    details_end = source.index("\n    def get_episodes(", details_start)
    details = source[details_start:details_end].replace("data.get(", "subject.get(")
    details = replace_once(
        details,
        '        data = self.api_request("GET", url).get("data", {})\n',
        '        data = self.api_request("GET", url).get("data", {})\n'
        '        subject = data.get("subject") if isinstance(data.get("subject"), dict) else data\n'
        '        dubs_data = data.get("dubs") or data.get("audioTracks") or subject.get("dubs") or subject.get("audioTracks") or []\n',
        "nested detail fields",
    )
    details = replace_once(
        details,
        'for d in subject.get("dubs", [])',
        "for d in dubs_data",
        "audio track fields",
    )
    source = source[:details_start] + details + source[details_end:]
    return source


if not UPLOAD.is_file():
    raise SystemExit("The supplied MovieBox provider ZIP is missing from attached_assets.")

with zipfile.ZipFile(UPLOAD) as archive:
    try:
        engine_source = archive.read("provider/engine.py").decode("utf-8")
        license_text = archive.read("provider/LICENSE").decode("utf-8")
    except KeyError as error:
        raise SystemExit(f"Expected MovieBox source file is missing: {error}") from None

SOURCE_FILES["engine.py"] = patch_engine_source(engine_source)
SOURCE_FILES["UPSTREAM-LICENSE.txt"] = license_text
for filename, source in SOURCE_FILES.items():
    if filename.endswith(".py"):
        compile(source, filename, "exec")
    if "apimovie.runflix.name.ng" in source:
        raise SystemExit("Refusing to bundle an ApiMovie relay URL.")

files_json = json.dumps(SOURCE_FILES, ensure_ascii=False, separators=(",", ":"))
bootstrap = f"""
import json
import os
from pathlib import Path
import subprocess
import sys

files = json.loads({files_json!r})
root = Path("/tmp/movieapi-python-origin")
root.mkdir(parents=True, exist_ok=True)
for name, content in files.items():
    (root / name).write_text(content, encoding="utf-8")
subprocess.run(
    [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
     "--no-cache-dir", "-r", str(root / "requirements.txt")],
    check=True,
)
os.chdir(root)
os.execv(sys.executable, [
    sys.executable, "-m", "uvicorn", "server:app", "--host", "0.0.0.0",
    "--port", os.environ.get("PORT", "3000"), "--no-access-log",
])
"""

encoded = base64.b64encode(zlib.compress(bootstrap.encode("utf-8"), level=9)).decode("ascii")
if len(encoded) > 100_000:
    raise SystemExit(f"Bundle too large for a Railway variable: {len(encoded)} bytes")
sys.stdout.write(encoded)
