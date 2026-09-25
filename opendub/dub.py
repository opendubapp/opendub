"""The new voice: clone, speak, check, fit, place, mix."""

from __future__ import annotations

import math
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

from . import boson, media, tone, translate
from .asr import Segment
from .config import Language

TOLERANCE = 1.15     # a take this far off the speaker's length is re-said, not stretched
MIN_TEMPO = 0.75     # slowest we stretch a take to end with the speaker (below this it drawls)
MAX_TEMPO = 1.3      # fastest we stretch a take to end with the speaker
MANUAL_MIN, MANUAL_MAX = 0.6, 1.8  # a dragged block is stretched this far, no further
QA_MIN_SIMILARITY = 0.72


@dataclass
class Line:
    seg: Segment
    slot: float                  # seconds available before the next line starts
    text: str                    # the translation
    tone: dict | None = None     # {emotion, expressive, style}, see tone.py
    manual: list[float] | None = None  # [start, end] a person dragged the block to
    take: Path | None = None     # TTS output, silence trimmed, before any speed-up
    raw: Path | None = None      # what gets mixed: `take`, fitted to its slot
    duration: float = 0.0
    similarity: float | None = None   # back-transcription vs text, 0..1
    shortened: bool = False
    attempts: int = 0
    # placement, filled by place()
    start: float = 0.0
    end: float = 0.0
    tempo: float = 1.0
    notes: list[str] = field(default_factory=list)


def slots(segs: list[Segment], total: float) -> list[float]:
    """Each line may use its own time plus the pause after it."""
    out = []
    for i, s in enumerate(segs):
        nxt = segs[i + 1].start if i + 1 < len(segs) else min(total, s.end + 1.5)
        out.append(max(s.duration, nxt - s.start - 0.08))
    return out


# ---------------------------------------------------------------- the reference voice

def reference(segs: list[Segment], vocals: Path, work: Path, *, lo: float = 6.0,
              hi: float = 12.0) -> tuple[Path, str, tuple[float, float]]:
    """Pick the densest run of whole sentences 6–12 s long to clone from.

    Whole sentences, so `ref_text` matches the audio exactly — Higgs clones
    measurably better with an accurate transcript. Taken from the Demucs vocal
    stem, so the clone learns the voice and not the soundtrack.
    """
    best, best_score = None, -1.0
    for i in range(len(segs)):
        for j in range(i, len(segs)):
            span = segs[j].end - segs[i].start
            if span > hi:
                break
            if span < lo:
                continue
            speech = sum(w.end - w.start for s in segs[i:j + 1] for w in s.words)
            score = speech / span - 0.01 * i  # dense, and early (the intro is usually cleanest)
            if score > best_score:
                best, best_score = (i, j), score
    if best is None:  # a short video: take whatever there is
        best = (0, len(segs) - 1)
        while best[1] > 0 and segs[best[1]].end - segs[0].start > hi:
            best = (0, best[1] - 1)
    i, j = best
    start, end = max(0.0, segs[i].start - 0.05), segs[j].end + 0.1
    ref = media.resample(vocals, work / "ref_voice.wav", sr=24000, start=start, dur=end - start)
    a = media.load(ref, sr=24000)
    peak = float(np.abs(a).max() or 1.0)
    media.save(ref, a * (0.9 / peak), sr=24000)
    return ref, " ".join(s.text for s in segs[i:j + 1]), (start, end)


# ---------------------------------------------------------------- speak + check

def _squash(s: str) -> str:
    return re.sub(r"[\W_]+", "", s.lower())


def similarity(a: str, b: str) -> float:
    a, b = _squash(a), _squash(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


@dataclass
class Speaker:
    """Who speaks the dub: a clone of the original (`ref`) or a Higgs preset (`voice`)."""
    ref: Path | None = None
    ref_text: str = ""
    voice: str | None = None
    normalize: bool = True      # Higgs text normalisation: "10,000" is read as words
    engine: str = "higgs"       # higgs, or a free engine on this computer (engines.CATALOG)


def _speak_checked(line: Line, i: int, work: Path, lang: Language, spk: Speaker,
                   qa: bool) -> None:
    """TTS, then transcribe it back; a mismatch means a skipped or garbled phrase."""
    best = None
    for attempt in range(2 if qa else 1):
        line.attempts += 1
        raw = work / f"tts_{i:03d}_{line.attempts}.wav"
        if spk.engine != "higgs":
            # A free engine on this computer. Those with length control are asked
            # for the speaker's own length; tone tags are Higgs-only.
            from . import engines
            clips, sr = engines.speak(spk.engine, [line.text], spk.ref, spk.ref_text,
                                      [line.seg.duration], lang.iso)
            media.save(raw, clips[0], sr=sr)
        else:
            boson.speak(tone.tags(line.tone) + line.text, raw, ref_audio=spk.ref,
                        ref_text=spk.ref_text, voice=spk.voice, tn_language=lang.iso,
                        enable_tn=spk.normalize)
        a = media.trim_silence(media.load(raw))
        trimmed = media.save(work / f"tts_{i:03d}_{line.attempts}_trim.wav", a)
        sim = None
        if qa:
            try:
                sim = similarity(line.text, boson.transcribe(trimmed, language=lang.iso))
            except Exception:
                sim = None
        cand = (sim if sim is not None else 1.0, trimmed, a.size / media.SR, sim)
        if best is None or cand[0] > best[0]:
            best = cand
        if sim is None or sim >= QA_MIN_SIMILARITY:
            break
        line.notes.append(f"take {line.attempts} back-transcribed at {sim:.0%}; regenerating")
    _, line.take, line.duration, line.similarity = best
    line.raw = line.take


def _off(line: Line) -> float:
    """How far a take's length is from the speaker's, as a ratio (1.0 = same)."""
    return line.duration / max(0.3, line.seg.duration)


def synthesise(lines: list[Line], work: Path, lang: Language, spk: Speaker,
               *, qa: bool = True, only: set[int] | None = None, allow_resize: bool = True,
               log=print, progress=None) -> None:
    """Speak every line (or just the indices in `only`, for a re-dub).

    The goal is each line lasting as long as the speaker took to say it, so the
    dub starts and ends with their mouth. A take more than ~15 % off gets up to
    three more tries, each kept only if it lands closer:

    1. and 2. the translator re-says it longer or shorter;
    3. Higgs's own pacing tag (`<|prosody:speed_fast|>` ≈1.2×, `speed_slow`
       ≈0.85×) — a voice that talks faster sounds far more natural than one
       stretched afterwards.

    `place` closes whatever is left with a gentle stretch. A re-dub of a line a
    person wrote (`allow_resize=False`) skips the rewording but still paces.
    """
    todo = [i for i in range(len(lines)) if only is None or i in only]
    done = [0]

    def job(i: int) -> None:
        line = lines[i]
        _speak_checked(line, i, work, lang, spk, qa)
        first = line.duration
        # Engines with length control already generated the right length. Other
        # free engines can be re-worded but have no Higgs speed tag.
        from . import engines
        exact = spk.engine != "higgs" and engines.CATALOG[spk.engine].exact_duration
        steps = [] if exact else (["resize", "resize", "resize"] if allow_resize else []) + ([] if spk.engine != "higgs" else ["speed"])
        for step in steps:
            r = _off(line)
            if line.seg.duration < 1.0 or 1 / TOLERANCE <= r <= TOLERANCE:
                break
            old = (line.text, line.tone, line.take, line.duration, line.similarity,
                   list(line.notes), line.shortened)
            if step == "resize":
                n = translate.count_chars(line.text, lang)
                ctx = " / ".join(l.seg.text for l in lines[max(0, i - 1):i + 2])
                resaid = translate.resize(line.seg.text, line.text, lang, max(2, round(n / r)), ctx)
                m = translate.count_chars(resaid, lang)
                if resaid == line.text or not (m < n if r > 1 else m > n):
                    continue
                line.text, line.shortened = resaid, True
                note = f"re-said in {m} chars (was {n})"
            else:
                line.tone = {**(line.tone or {}), "speed": "fast" if r > 1 else "slow"}
                note = f"asked Higgs to speak {'faster' if r > 1 else 'slower'}"
            try:
                _speak_checked(line, i, work, lang, spk, qa)
            except Exception as e:  # a failed retry keeps the take we already have
                (line.text, line.tone, line.take, line.duration, line.similarity,
                 line.notes, line.shortened) = old
                line.raw = line.take
                log(f"line {i + 1}: a pacing retry failed ({str(e)[:80]}); keeping the take we have")
                break
            if abs(math.log(_off(line))) < abs(math.log(r)):
                line.notes.append(f"{note}: {first:.1f}s → {line.duration:.1f}s "
                                  f"against the speaker's {line.seg.duration:.1f}s")
            else:  # landed no closer; keep what we had
                (line.text, line.tone, line.take, line.duration, line.similarity,
                 line.notes, line.shortened) = old
                line.raw = line.take
        done[0] += 1
        if progress:
            progress(done[0] / len(todo))
        log(f"line {i + 1}/{len(lines)}: {line.duration:.1f}s against the speaker's "
            f"{line.seg.duration:.1f}s" + (f", heard back at {line.similarity:.0%}"
                                           if line.similarity is not None else ""))

    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(job, todo))


# ---------------------------------------------------------------- place + mix

def place(lines: list[Line], total: float, work: Path) -> None:
    """Lay each line exactly over its original: same start, same end.

    `synthesise` has already brought each take within ~15 % of the speaker's
    length by rewording and by Higgs's own pacing, so what is left here is a
    small stretch either way. Past MIN_TEMPO/MAX_TEMPO the voice sounds drugged
    or hurried, so a take that far off keeps its own length instead; the one
    exception is speeding up further (to OVERRUN_TEMPO) to stay off the next line.
    """
    cursor = 0.0
    for i, line in enumerate(lines):
        take_len = media.load(line.take).size / media.SR
        if line.manual:  # a person placed this block: honour it, within reason
            start = max(0.0, line.manual[0])
            want = max(0.3, line.manual[1] - start)
            tempo = min(MANUAL_MAX, max(MANUAL_MIN, take_len / want))
            limit = total
        else:
            # Always exactly the speaker's span. `synthesise` has already
            # re-said and re-paced the take until it is close, so this is
            # normally a small stretch; a big one is flagged, not avoided.
            start, limit = line.seg.start, line.seg.end
            want = max(0.3, line.seg.duration)
            tempo = take_len / want
            if not MIN_TEMPO <= tempo <= MAX_TEMPO:
                line.notes.append(f"stretched {tempo:.2f}× to end with the speaker")
        fitted = work / f"fit_{i:03d}.wav"
        media.stretch(line.take, fitted, tempo)
        a = media.load(fitted)
        # The stretcher lands within a few tens of ms; square it off so the
        # block ends on the speaker's last word, not near it.
        n_want = int(round(want * media.SR))
        if a.size != n_want:
            a = a[:n_want] if a.size > n_want else np.pad(a, (0, n_want - a.size))
            media.save(fitted, a)
        line.raw, line.tempo = fitted, tempo
        line.duration = a.size / media.SR
        line.start, line.end = start, start + line.duration
        cursor = line.end


def mix(lines: list[Line], vocals: Path, background: Path, total: float, out: Path,
        *, mode: str = "replace", original_level: float = 0.15) -> Path:
    """Background stem + new voice (+ a trace of the original in voice-over mode)."""
    n = int(total * media.SR) + media.SR
    voice = np.zeros(n, dtype=np.float32)
    for line in lines:
        a = media.load(line.raw)
        s = int(line.start * media.SR)
        e = min(n, s + a.size)
        voice[s:e] += a[: e - s]

    orig = media.load(vocals)
    bg = media.load(background, mono=False)

    # Match the new voice to the speaker's loudness, measured where they speak.
    def speech_rms(x: np.ndarray) -> float:
        win = media.SR // 20
        m = x.size // win
        r = np.sqrt(np.mean(x[: m * win].reshape(m, win) ** 2, axis=1))
        loud = r[r > r.max() * 0.1] if r.size else r
        return float(np.sqrt(np.mean(loud ** 2))) if loud.size else 0.0

    target, have = speech_rms(orig), speech_rms(voice)
    if have > 0 and target > 0:
        voice *= float(np.clip(target / have, 0.25, 4.0))

    stereo = np.zeros((n, 2), dtype=np.float32)
    stereo[: bg.shape[0]] += bg[:n]
    stereo += voice[:, None]
    if mode == "voiceover":
        k = min(n, orig.size)
        stereo[:k] += original_level * orig[:k, None]
    peak = float(np.abs(stereo).max())
    if peak > 0.97:
        stereo *= 0.97 / peak
    return media.save(out, stereo[: int(total * media.SR)])
