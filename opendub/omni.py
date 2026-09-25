"""OmniVoice: the free voice, running on this computer.

k2-fsa/OmniVoice (code Apache-2.0, weights CC-BY-NC — non-commercial use only).
Zero-shot cloning in 600+ languages, and a `duration=` argument that generates
speech of an exact length, so a dubbed line lands on the speaker's span
without stretching.

Measured on an M1 Max: about 15–35 s per line on the CPU, and slower on the
Apple GPU (MPS), so CPU is the default. The model (~1.2 GB) downloads once
from Hugging Face and then loads in about a second.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np

SR = 24000
_model = None
_lock = threading.Lock()
_DEVICE = os.environ.get("OPENDUB_OMNI_DEVICE", "cpu")
_STEPS = int(os.environ.get("OPENDUB_OMNI_STEPS", "32"))


def available() -> bool:
    try:
        import omnivoice  # noqa: F401
        return True
    except ImportError:
        return False


def _load():
    global _model
    if _model is None:
        from omnivoice import OmniVoice
        _model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=_DEVICE)
    return _model


def speak(texts: list[str], ref_audio: Path, ref_text: str | None,
          durations: list[float | None] | None = None, language: str | None = None) -> list[np.ndarray]:
    """One clip per text, cloned from `ref_audio`, each `durations[i]` seconds long when given."""
    with _lock:  # one generation at a time: the model wants the whole machine
        m = _load()
        prompt = m.create_voice_clone_prompt(str(ref_audio), ref_text=ref_text or None)
        kw = {"voice_clone_prompt": prompt, "num_step": _STEPS}
        if durations and any(d for d in durations):
            kw["duration"] = [d if d else None for d in durations]
        if language:
            kw["language"] = language
        out = m.generate(text=texts, **kw)
    return [np.asarray(a, dtype=np.float32).squeeze() for a in out]
