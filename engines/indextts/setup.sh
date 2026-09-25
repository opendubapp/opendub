#!/usr/bin/env bash
# IndexTTS-2: the repository, its uv environment, and the checkpoints (several GB).
# Deferred until there is disk space; see engines/README.md.
set -euo pipefail
cd "$(dirname "$0")"
UV=../../.venv/bin/uv
[ -d repo ] || git clone --depth 1 https://github.com/index-tts/index-tts.git repo
$UV venv --python 3.11 .venv
UV_HTTP_TIMEOUT=600 $UV pip install --python .venv/bin/python -e repo huggingface_hub
.venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('IndexTeam/IndexTTS-2', local_dir='repo/checkpoints')"
../smoke.sh indextts
