#!/usr/bin/env bash
# CosyVoice 2: the code (from the official Hugging Face Space, which bundles
# Matcha-TTS), its own Python 3.10 environment, and the 0.5B model.
set -euo pipefail
cd "$(dirname "$0")"
UV=../../.venv/bin/uv
PY=../../.venv/bin/python
[ -f repo/requirements.txt ] || $PY -c "from huggingface_hub import snapshot_download; snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B', repo_type='space', local_dir='repo', allow_patterns=['cosyvoice/**','third_party/**','requirements.txt'])"
$UV venv --python 3.10 .venv
# Drop the extra indexes and what only a Linux/CUDA server or the training/web demo needs.
grep -vE "^(--|tensorrt|onnxruntime-gpu|grpcio|fastapi|gdown|tensorboard)" repo/requirements.txt > req.txt
UV_HTTP_TIMEOUT=600 $UV pip install --python .venv/bin/python -r req.txt huggingface_hub
../fetch_hf.sh FunAudioLLM/CosyVoice2-0.5B models/CosyVoice2-0.5B
../smoke.sh cosyvoice
