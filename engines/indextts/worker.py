"""IndexTTS-2 (Bilibili) as an OpenDub voice engine.

Zero-shot cloning with separate emotion control, and a model that can set a
line's length. LICENCE TO BE CONFIRMED before it is offered to users. The API
follows the repository's IndexTTS2.infer(); length control is not wired until
we have verified its parameter. UNVERIFIED by us.
"""
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE / "repo"))
from worker_base import serve  # noqa: E402


def load():
    from indextts.infer_v2 import IndexTTS2
    return IndexTTS2(cfg_path=str(HERE / "repo" / "checkpoints" / "config.yaml"),
                     model_dir=str(HERE / "repo" / "checkpoints"), use_fp16=False)


def speak(model, text, ref, ref_text, duration, language):
    with tempfile.NamedTemporaryFile(suffix=".wav") as out:
        model.infer(spk_audio_prompt=ref, text=text, output_path=out.name, verbose=False)
        with wave.open(out.name) as w:
            sr = w.getframerate()
            a = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    return a, sr


if __name__ == "__main__":
    serve(load, speak, lambda: {"engine": "indextts", "exact_duration": False})
