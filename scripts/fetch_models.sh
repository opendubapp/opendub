#!/usr/bin/env bash
# Mirror the model weights the page runs into web/models/, so an installer can
# carry them and a dub never reaches the network.
#
#   scripts/fetch_models.sh [dest]        default: web/models
#
# About 414 MB. Already-correct files are left alone, so running it again is
# cheap. The directory is git-ignored: these are other people's weights and
# they do not belong in the history.
#
# Whisper's file names are the ones transformers.js asks for with
# dtype: "q8" — the "_quantized" exports — and the two of them come to the
# 237 MB that whisper.js quotes. The small JSON and text files beside them
# are the tokenizer and the configs; leaving one out fails the load with a
# 404 rather than anything that names the missing file, which is why the
# build checks the manifest and a dub is run with the CDN blocked.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${1:-web/models}
HF=https://huggingface.co

WHISPER=onnx-community/whisper-small
WHISPER_FILES=(
  config.json generation_config.json preprocessor_config.json
  tokenizer.json tokenizer_config.json added_tokens.json
  special_tokens_map.json normalizer.json merges.txt vocab.json
  quantize_config.json
  onnx/encoder_model_quantized.onnx
  onnx/decoder_model_merged_quantized.onnx
)
DEMUCS_URL=$HF/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx

get() {   # get <url> <path>
  local url=$1 out=$2
  mkdir -p "$(dirname "$out")"
  if [ -s "$out" ]; then
    local have want
    have=$(wc -c < "$out" | tr -d ' ')
    want=$(curl -sIL "$url" | awk 'BEGIN{IGNORECASE=1}/^content-length:/{v=$2}END{gsub(/\r/,"",v);print v}')
    [ -n "$want" ] && [ "$have" = "$want" ] && { printf '  have  %s\n' "$out"; return; }
  fi
  printf '  get   %s\n' "$out"
  curl -fsSL "$url" -o "$out.part"
  mv "$out.part" "$out"
}

for f in "${WHISPER_FILES[@]}"; do
  get "$HF/$WHISPER/resolve/main/$f" "$DEST/hf/$WHISPER/$f"
done
get "$DEMUCS_URL" "$DEST/htdemucs_embedded.onnx"

# What the page checks for before it points itself here. Written last, so an
# interrupted run leaves no manifest and the page quietly uses the CDN rather
# than asking this origin for files it does not have.
cat > "$DEST/manifest.json" <<JSON
{
  "models": {
    "whisper": "$WHISPER (q8)",
    "separator": "htdemucs_embedded"
  }
}
JSON
du -sh "$DEST" | awk '{print "\n  " $1 "  in " $2}'
