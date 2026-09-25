#!/usr/bin/env bash
# Speak one Chinese line in a cloned voice through the worker protocol; on success, mark the engine ready.
set -euo pipefail
name=$1; here="$(cd "$(dirname "$0")" && pwd)"
ref="$here/../work/cli-20260919-002925/ref_voice.wav"
out="$(mktemp -d)"
reply=$(printf '{"id":1,"op":"speak","texts":["大家好，这是OpenDub的快速介绍。"],"ref":"%s","ref_text":"Hi! This is a quick look at OpenDub.","durations":[3.2],"language":"zh","out_dir":"%s"}\n' "$ref" "$out" \
  | "$here/$name/.venv/bin/python" "$here/$name/worker.py")
echo "$reply"
echo "$reply" | grep -q '"clips"' && touch "$here/$name/.ready" && echo "$name: ready"
