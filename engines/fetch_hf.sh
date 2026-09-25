#!/usr/bin/env bash
# fetch_hf.sh <repo> <dest> [file...]: download a Hugging Face model with curl,
# resuming every file where it stopped. The Hub's own downloader stalls on this
# connection and restarts from zero, which never finishes a multi-GB model.
set -uo pipefail
repo=$1 dest=$2; shift 2
mkdir -p "$dest"
files=("$@")
if [ ${#files[@]} -eq 0 ]; then
  while IFS= read -r f; do files+=("$f"); done < <(curl -sSL --retry 10 "https://huggingface.co/api/models/$repo" | python3 -c "import json,sys; [print(s['rfilename']) for s in json.load(sys.stdin)['siblings']]")
fi
for f in "${files[@]}"; do
  mkdir -p "$dest/$(dirname "$f")"
  for i in $(seq 1 30); do
    curl -sSL --retry 10 --retry-all-errors --speed-limit 1000 --speed-time 60 -C - -o "$dest/$f" "https://huggingface.co/$repo/resolve/main/$f" && break
    echo "retry $i: $f" >&2; sleep 3
  done || exit 1
  echo "got $f ($(du -h "$dest/$f" | cut -f1))"
done
