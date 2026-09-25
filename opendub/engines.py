"""Free voice engines that run on this computer.

OmniVoice runs in-process (it shares this app's torch). The others each live in
their own environment under engines/<name>/ — they pin conflicting versions of
torch and transformers — and are driven through engines/worker_base.py's
line-delimited JSON protocol. An engine is offered only once its setup script
has proved it can speak (engines/<name>/.ready).
"""

from __future__ import annotations

import itertools
import json
import subprocess
import sys
import tempfile
import threading
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from . import config, media

ENGINES_DIR = config.ROOT / "engines"


@dataclass(frozen=True)
class Engine:
    id: str
    name: str
    maker: str
    licence: str
    commercial: bool
    exact_duration: bool      # can generate a line at a set length
    emotion: str              # how delivery can be steered, in a phrase
    hardware: str             # what it needs to run
    languages: str
    note: str


CATALOG: dict[str, Engine] = {e.id: e for e in [
    Engine("omnivoice", "OmniVoice", "k2-fsa", "Code Apache-2.0, weights CC-BY-NC", False, True,
           "none (voice design by description only)", "CPU or Apple GPU", "600+",
           "Sets each line's exact length, so dubs need no stretching."),
    Engine("chatterbox", "Chatterbox Multilingual", "Resemble AI", "MIT", True, False,
           "exaggeration (calm ↔ dramatic)", "Apple GPU, NVIDIA GPU or CPU", "23, including Chinese",
           "Commercial use allowed. Every clip carries an inaudible watermark."),
    Engine("cosyvoice", "CosyVoice 2", "Alibaba (FunAudioLLM)", "Apache-2.0", True, False,
           "instructions (emotion, speed, dialect)", "NVIDIA GPU recommended; CPU works slowly", "9, plus 18 Chinese dialects",
           "Strongest Mandarin of the free engines; clones across languages."),
    Engine("voxcpm", "VoxCPM2", "OpenBMB", "Apache-2.0", True, False,
           "style instructions (emotion, pace)", "NVIDIA GPU with 8 GB+ (CUDA) — not Macs", "30, including Chinese dialects",
           "Untested by us: needs an NVIDIA GPU."),
    Engine("indextts", "IndexTTS-2", "Bilibili", "to be confirmed", False, False,
           "emotion by reference clip, vector or text", "NVIDIA GPU recommended", "Chinese, English",
           "Controls each line's length. Not installed yet: needs more disk space."),
]}


def installed(engine_id: str) -> bool:
    if engine_id == "omnivoice":
        from . import omni
        return omni.available()
    return (ENGINES_DIR / engine_id / ".ready").exists()


def catalog() -> list[dict]:
    return [{**asdict(e), "ready": installed(e.id)} for e in CATALOG.values()]


class _Worker:
    """One long-lived process per engine; requests are serialised (one model, one machine)."""

    def __init__(self, engine_id: str):
        py = ENGINES_DIR / engine_id / ".venv" / "bin" / "python"
        self.proc = subprocess.Popen([str(py), str(ENGINES_DIR / engine_id / "worker.py")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
                                     text=True, bufsize=1)
        self.lock = threading.Lock()
        self.ids = itertools.count(1)

    def call(self, req: dict) -> dict:
        with self.lock:
            req["id"] = next(self.ids)
            self.proc.stdin.write(json.dumps(req) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("the engine stopped unexpectedly (see the app's log)")
        reply = json.loads(line)
        if reply.get("error"):
            raise RuntimeError(reply["error"])
        return reply


_workers: dict[str, _Worker] = {}
_start = threading.Lock()


def speak(engine_id: str, texts: list[str], ref: Path, ref_text: str | None,
          durations: list[float | None] | None = None, language: str | None = None) -> tuple[list[np.ndarray], int]:
    """Clips (mono float32) for `texts` in the cloned voice, and their sample rate."""
    if engine_id not in CATALOG:
        raise ValueError(f"unknown engine {engine_id}")
    if not installed(engine_id):
        raise RuntimeError(f"{CATALOG[engine_id].name} is not installed on this computer: engines/{engine_id}/setup.sh")
    if engine_id == "omnivoice":
        from . import omni
        return omni.speak(texts, ref, ref_text, durations), omni.SR
    with _start:
        w = _workers.get(engine_id)
        if w is None or w.proc.poll() is not None:
            w = _workers[engine_id] = _Worker(engine_id)
    with tempfile.TemporaryDirectory() as out:
        reply = w.call({"op": "speak", "texts": texts, "ref": str(ref), "ref_text": ref_text or "",
                        "durations": durations or [None] * len(texts), "language": language, "out_dir": out})
        sr = reply["sample_rate"]
        return [media.load(Path(c), sr=sr) for c in reply["clips"]], sr
