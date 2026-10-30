"""Run the Python Railway origin locally using the uploaded MovieBox engine."""

import os
from pathlib import Path
import sys
import types
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ZIP = ROOT / "attached_assets" / "provider_(1)_1792978236105.zip"
MEDIA_SOURCE = ROOT / "movieapi" / "media-transport"
sys.path.insert(0, str(MEDIA_SOURCE))

if not os.environ.get("RELAY_SECRET"):
    raise SystemExit("Set RELAY_SECRET before starting the private MovieAPI origin.")
if not SOURCE_ZIP.is_file():
    raise SystemExit("The supplied MovieBox provider ZIP is missing from attached_assets.")

engine_module = types.ModuleType("engine")
with zipfile.ZipFile(SOURCE_ZIP) as archive:
    source = archive.read("provider/engine.py").decode("utf-8")
exec(compile(source, "engine.py", "exec"), engine_module.__dict__)
sys.modules["engine"] = engine_module

import uvicorn  # noqa: E402

uvicorn.run(
    "server:app",
    host="0.0.0.0",
    port=int(os.environ.get("PORT", "3000")),
    app_dir=str(Path(__file__).resolve().parent),
    access_log=False,
)
