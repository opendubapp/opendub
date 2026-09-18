#!/usr/bin/env bash
# Start OpenVoice at http://127.0.0.1:${PORT:-8910}
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
[ -f .env ] || { echo "Put BOSON_API_KEY=... in .env first"; exit 1; }
exec .venv/bin/uvicorn openvoice.server:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8910}"
