#!/usr/bin/env bash
# Install Chatterbox into its own environment, then prove it speaks before marking it ready.
set -euo pipefail
cd "$(dirname "$0")"
UV=../../.venv/bin/uv
$UV venv --python 3.11 .venv
UV_HTTP_TIMEOUT=300 $UV pip install --python .venv/bin/python chatterbox-tts numpy
# The model, fetched with curl so a stalled download resumes rather than restarts.
../fetch_hf.sh ResembleAI/chatterbox models ve.pt t3_mtl23ls_v2.safetensors s3gen.pt grapheme_mtl_merged_expanded_v1.json conds.pt Cangjie5_TC.json
../smoke.sh chatterbox
