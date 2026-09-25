"""How each line was said, carried into the dub with Higgs TTS tags.

Zero-shot cloning copies the *voice* from one reference clip, so every line
would otherwise come out in that clip's mood. Here each line gets its own
delivery, read from two things:

- **what was said** — the line and its neighbours, read by the Higgs chat model;
- **how it was said** — loudness and speaking rate of that line against the
  speaker's own average, measured on the Demucs vocal stem.

The result is one emotion (Higgs's own vocabulary), an expressiveness level,
and optionally a whisper or a shout, spoken as leading tags:
`<|emotion:surprise|><|prosody:expressive_high|>等等……`
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import boson, media
from .asr import Segment

# Higgs TTS 3 emotion tags, minus the one a dubbing tool has no use for.
EMOTIONS = ["neutral", "elation", "amusement", "enthusiasm", "determination", "pride",
            "contentment", "affection", "relief", "contemplation", "confusion", "surprise",
            "awe", "longing", "anger", "fear", "disgust", "bitterness", "sadness", "shame",
            "helplessness"]
EXPRESSIVE = ["low", "normal", "high"]
STYLES = ["none", "whispering", "shouting"]
PITCHES = ["natural", "low", "high"]
PRESET_VOICES = {  # Higgs TTS 3 presets (docs.boson.ai/models/higgs-tts/voices)
    "chloe": "Chloe — friendly, clear, engaging",
    "eleanor": "Eleanor — calm, articulate, professional",
    "jake": "Jake — energetic, slightly dramatic",
    "marcus": "Marcus — enthusiastic, confident",
    "nora": "Nora — calm, clear narrator",
    "oliver": "Oliver — thoughtful, reflective",
}


def apply_settings(tones: list[dict | None], *, expressive: str = "auto",
                   style: str = "auto", pitch: str = "natural") -> list[dict]:
    """Whole-video overrides from Other settings, laid over the per-line reading."""
    out = []
    for t in tones:
        t = dict(t or {"emotion": "neutral", "expressive": "normal", "style": "none"})
        if expressive in EXPRESSIVE:
            t["expressive"] = expressive
        if style in STYLES:
            t["style"] = style
        if pitch in ("low", "high"):
            t["pitch"] = pitch
        out.append(t)
    return out

SYSTEM = f"""You are a voice director preparing a dub. For each spoken line, decide how it should be DELIVERED so the dubbed voice keeps the original performance.

Each line comes with measurements of how the speaker actually said it, relative to their own average across the video:
- "loudness_db": + is louder than usual, - is quieter.
- "pace": >1 is faster than usual, <1 slower.
Use them together with the words and the surrounding lines. Most lines in ordinary talk are "neutral" or mild; pick a strong emotion only when the words or the delivery clearly carry it. Rhetorical questions, hooks and reveals are usually "surprise", "enthusiasm" or "amusement"; explanations are usually "neutral" or "contemplation".

For each line return:
- "emotion": one of {EMOTIONS}
- "expressive": one of {EXPRESSIVE} — how animated the delivery is
- "style": one of {STYLES} — "whispering"/"shouting" only if the speaker clearly does so (very quiet or very loud)

Return exactly one entry per line, in order. Reply with JSON only:
{{"lines": [{{"emotion": "...", "expressive": "...", "style": "..."}}]}}"""


def measure(segs: list[Segment], vocals: Path) -> list[dict]:
    """Loudness and pace of each line relative to the speaker's median."""
    a = media.load(vocals)
    loud, pace = [], []
    for s in segs:
        clip = a[int(s.start * media.SR):int(s.end * media.SR)]
        win = media.SR // 20
        m = clip.size // win
        if m:
            r = np.sqrt(np.mean(clip[: m * win].reshape(m, win) ** 2, axis=1))
            r = r[r > r.max() * 0.1]
            loud.append(20 * np.log10(float(np.sqrt(np.mean(r ** 2))) + 1e-9))
        else:
            loud.append(-60.0)
        pace.append(len(s.text) / max(0.3, s.duration))
    ml, mp = float(np.median(loud)), float(np.median(pace))
    return [{"loudness_db": round(float(l - ml), 1), "pace": round(float(p / mp), 2)}
            for l, p in zip(loud, pace)]


def direct(segs: list[Segment], vocals: Path, *, log=print) -> list[dict]:
    """One {emotion, expressive, style} per segment; neutral on any failure."""
    neutral = [{"emotion": "neutral", "expressive": "normal", "style": "none"} for _ in segs]
    try:
        feats = measure(segs, vocals)
    except Exception as e:
        log(f"could not measure delivery ({e}); reading tone from the words only")
        feats = [{} for _ in segs]
    lines = [{"id": i + 1, "text": s.text, **f} for i, (s, f) in enumerate(zip(segs, feats))]
    for attempt in range(2):
        try:
            res = boson.chat_json(SYSTEM, json.dumps({"lines": lines}, ensure_ascii=False),
                                  max_tokens=100 + 40 * len(lines))
            got = res.get("lines") or []
            if len(got) != len(lines):
                continue
            out = []
            for g, f in zip(got, feats):
                t = {"emotion": g.get("emotion") if g.get("emotion") in EMOTIONS else "neutral",
                     "expressive": g.get("expressive") if g.get("expressive") in EXPRESSIVE else "normal",
                     "style": g.get("style") if g.get("style") in STYLES else "none"}
                # A whisper or a shout has to be audible in the measurement, not
                # just plausible from the words.
                if t["style"] == "whispering" and f.get("loudness_db", 0) > -6:
                    t["style"] = "none"
                if t["style"] == "shouting" and f.get("loudness_db", 0) < 4:
                    t["style"] = "none"
                out.append(t)
            return out
        except Exception as e:
            log(f"tone attempt {attempt + 1} failed: {e}")
    log("could not read the tone; the dub will be delivered neutrally")
    return neutral


def tags(t: dict | None) -> str:
    """The leading Higgs TTS tags for one line's delivery."""
    if not t:
        return ""
    out = ""
    if t.get("emotion") and t["emotion"] != "neutral":
        out += f"<|emotion:{t['emotion']}|>"
    if t.get("style") in ("whispering", "shouting"):
        out += f"<|style:{t['style']}|>"
    if t.get("expressive") in ("high", "low"):
        out += f"<|prosody:expressive_{t['expressive']}|>"
    if t.get("pitch") in ("low", "high"):
        out += f"<|prosody:pitch_{t['pitch']}|>"
    if t.get("speed") in ("slow", "fast"):  # set by the pacing step, never by hand
        out += f"<|prosody:speed_{t['speed']}|>"
    return out
