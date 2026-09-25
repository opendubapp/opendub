"""The protocol every voice engine speaks. Standard library + numpy only, so it
runs inside any engine's own environment (each engine pins its own torch).

The app starts `engines/<name>/.venv/bin/python engines/<name>/worker.py`, then
writes one JSON request per line on stdin and reads one JSON reply per line on
stdout. Anything else the model prints goes to stderr.

Request:  {"id": 1, "op": "speak", "texts": [...], "ref": "/abs/ref.wav",
           "ref_text": "...", "durations": [3.2, null, ...], "language": "zh",
           "out_dir": "/abs/dir"}
          {"id": 2, "op": "info"}
Reply:    {"id": 1, "clips": ["/abs/dir/clip_0.wav", ...], "sample_rate": 24000}
          {"id": 2, "ready": true, "device": "mps", "exact_duration": false}
          {"id": n, "error": "..."}
"""

from __future__ import annotations

import json
import sys
import traceback
import wave
from pathlib import Path

import numpy as np


def write_wav(path: Path, audio, sr: int) -> Path:
    a = np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((a * 32767).astype("<i2").tobytes())
    return path


def serve(load, speak, info=None):
    """load() -> model; speak(model, text, ref, ref_text, duration, language) -> (audio, sr)."""
    out = sys.stdout
    sys.stdout = sys.stderr  # stray prints from a model must not corrupt the protocol
    model = None
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            if req.get("op") == "info":
                reply = {"id": rid, "ready": True, **(info() if info else {})}
            else:
                if model is None:
                    model = load()
                out_dir = Path(req["out_dir"])
                out_dir.mkdir(parents=True, exist_ok=True)
                clips, sr = [], None
                durations = req.get("durations") or [None] * len(req["texts"])
                for i, (text, dur) in enumerate(zip(req["texts"], durations)):
                    audio, sr = speak(model, text, req["ref"], req.get("ref_text") or None, dur, req.get("language"))
                    clips.append(str(write_wav(out_dir / f"clip_{rid}_{i}.wav", audio, sr)))
                reply = {"id": rid, "clips": clips, "sample_rate": sr}
        except Exception as e:  # report, keep serving
            traceback.print_exc(file=sys.stderr)
            reply = {"id": rid, "error": f"{type(e).__name__}: {e}"}
        out.write(json.dumps(reply) + "\n")
        out.flush()
