# MovieAPI Python origin on Railway

Convert the existing `moviebox-proxy` service in the existing MovieAPI Railway
project; do not create another project or service. Its public Railway domain and
the Cloudflare Worker's `ENGINE_RELAY_URL` stay the same.

- Use the official `python:3.13-bookworm` image.
- From the workspace root, build the source bundle with
  `python3 movieapi/python-origin/bundle.py` and set its output as the Railway
  variable `MOVIEAPI_SOURCE_BUNDLE`. From inside `movieapi/`, the equivalent is
  `python3 python-origin/bundle.py`.
- Start command: `python -c 'import os,base64,zlib;exec(zlib.decompress(base64.b64decode(os.environ["MOVIEAPI_SOURCE_BUNDLE"])))'`
- The start command installs the pinned Python requirements, then runs the
  Python FastAPI origin on `0.0.0.0:$PORT`.
- Configure a strong `RELAY_SECRET` securely on Railway. On Cloudflare, use the
  same secret value as `RELAY_SECRET` or the existing `MOVIE_RELAY_SECRET`
  binding; the Worker accepts either name.
- MovieBox metadata uses the Python MovieBox engine. Media uses the supplied
  Chrome-impersonating HTTP/2 transport, with host allowlisting, bounded
  concurrency, short-lived tickets and byte-range support.
- The media relay admits at most eight concurrent transfers and bounds each
  transfer's queue to eight chunks; requests above capacity receive HTTP 503
  instead of risking another process-wide memory exhaustion.
- Do not configure an ApiMovie/Replit proxy URL. The media path runs on this
  MovieAPI service and never rewrites manifests to the second API's domain.

Cloudflare continues to serve docs, admin and public API routes. Its SQLite
Durable Object is the only production key/quota store. Railway stores no API
keys or quota counters, so restarting or redeploying it cannot reset quotas.
No volume or database is needed on Railway.

`GET /health` verifies the origin process, not MovieBox availability. The live
MP4 stream and download routes were checked with full 1 KiB ranges at byte zero
and a nonzero seek offset. DASH sources are probed and omitted when MovieBox
rejects the manifest. Both internal routes require `x-relay-secret`:

- `POST /internal/moviebox`: whitelisted MovieBox operation and parameters.
- `POST /internal/moviebox-media`: short-lived authenticated encrypted media
  ticket, optional Range header. Streams the response without buffering video.

Do not put secrets into railway.toml, source control or browser JavaScript.
Do not expose a public arbitrary URL proxy. Recheck real byte ranges when the
upstream provider or Railway region changes; healthy metadata alone does not
establish that media egress is accepted.
