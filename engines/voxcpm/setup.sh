#!/usr/bin/env bash
# VoxCPM2 needs CUDA. Refuse early on a machine without an NVIDIA GPU rather
# than download gigabytes that cannot run.
set -euo pipefail
cd "$(dirname "$0")"
command -v nvidia-smi >/dev/null || { echo "VoxCPM2 needs an NVIDIA GPU (CUDA, 8 GB+). This machine has none."; exit 2; }
UV=../../.venv/bin/uv
$UV venv --python 3.11 .venv
UV_HTTP_TIMEOUT=600 $UV pip install --python .venv/bin/python voxcpm numpy
../smoke.sh voxcpm
