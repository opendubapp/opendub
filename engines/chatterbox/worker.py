"""Chatterbox Multilingual (Resemble AI, MIT) as an OpenDub voice engine.

23 languages including Chinese, zero-shot cloning from a reference clip, and an
`exaggeration` knob for delivery. No length control: lines are fitted by the
app afterwards. Every clip carries Resemble's inaudible Perth watermark.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from worker_base import serve  # noqa: E402

LANGS = set("ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh".split())


def load():
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    models = Path(__file__).resolve().parent / "models"
    if (models / "t3_mtl23ls_v2.safetensors").exists():  # fetched by setup.sh with curl
        return ChatterboxMultilingualTTS.from_local(models, device)
    return ChatterboxMultilingualTTS.from_pretrained(device=device)


def speak(model, text, ref, ref_text, duration, language):
    lang = (language or "en").split("-")[0].lower()
    wav = model.generate(text, language_id=lang if lang in LANGS else "en", audio_prompt_path=ref,
                         exaggeration=0.5, cfg_weight=0.5)
    return wav.squeeze().detach().cpu().numpy(), model.sr


if __name__ == "__main__":
    serve(load, speak, lambda: {"engine": "chatterbox", "exact_duration": False})
