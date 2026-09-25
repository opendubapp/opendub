#!/usr/bin/env bash
# Start OpenDub at http://127.0.0.1:${PORT:-8910}
#
# A key is only needed for the Higgs route. Giving opendub.app a free voice
# from this machine needs none, so a missing .env is a note rather than a stop.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
[ -f .env ] || echo "No .env, so the Higgs route is off. The free voice on this computer works without one; for Higgs, put BOSON_API_KEY=... in .env."
exec .venv/bin/uvicorn opendub.server:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8910}"
