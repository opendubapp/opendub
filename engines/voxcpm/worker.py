"""VoxCPM2 (OpenBMB, Apache-2.0) as an OpenDub voice engine.

2B parameters, 30 languages, cloning without a transcript, and style
instructions. Needs an NVIDIA GPU with 8 GB+ (CUDA): it is offered only where
setup.sh's smoke test passed, which it cannot on a Mac. UNVERIFIED by us.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from worker_base import serve  # noqa: E402


def load():
    from voxcpm import VoxCPM
    return VoxCPM.from_pretrained("openbmb/VoxCPM2")


def speak(model, text, ref, ref_text, duration, language):
    wav = model.generate(text=text, prompt_wav_path=ref, prompt_text=ref_text, cfg_value=2.0, inference_timesteps=10)
    sr = getattr(getattr(model, "tts_model", None), "sample_rate", 16000)
    return wav, sr


if __name__ == "__main__":
    serve(load, speak, lambda: {"engine": "voxcpm", "exact_duration": False})
