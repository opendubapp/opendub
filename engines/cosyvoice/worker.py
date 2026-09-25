"""CosyVoice 2 (Alibaba FunAudioLLM, Apache-2.0) as an OpenDub voice engine.

The strongest Mandarin of the free engines, and it clones across languages:
an English reference voice speaking Chinese is its "cross-lingual" mode, which
is exactly a dub. No length control: lines are fitted by the app afterwards.
Code comes from the official Hugging Face Space (FunAudioLLM/Fun-CosyVoice3-0.5B),
which carries the same cosyvoice package and Matcha-TTS as the GitHub repository.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE / "repo"))
sys.path.insert(0, str(HERE / "repo" / "third_party" / "Matcha-TTS"))
from worker_base import serve  # noqa: E402


def load():
    from cosyvoice.cli.cosyvoice import CosyVoice2
    return CosyVoice2(str(HERE / "models" / "CosyVoice2-0.5B"), load_jit=False, load_trt=False, fp16=False)


def speak(model, text, ref, ref_text, duration, language):
    import torch
    # Cross-lingual when the reference is in another language than the line: no
    # prompt text, so the model borrows only the voice, not the words.
    chunks = [c["tts_speech"] for c in model.inference_cross_lingual(text, ref, stream=False)]
    return torch.cat(chunks, dim=1).squeeze().cpu().numpy(), model.sample_rate


if __name__ == "__main__":
    serve(load, speak, lambda: {"engine": "cosyvoice", "exact_duration": False})
