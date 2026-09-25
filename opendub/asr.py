"""Speech in, timed sentences out.

Three sources, each used for what it is good at:

- **Silero VAD** (the detector opensubs uses, shipped inside faster-whisper)
  finds where anybody is speaking. It gates everything else, and it decides
  how the audio is chunked for Higgs.
- **Higgs STT** (`higgs-stt-3.1`) supplies the words. On the demo clip it got
  "Eleven Labs" and a line of French right where Whisper wrote "11 Labs" and
  silently translated the French. It returns no timestamps.
- **Whisper** (local, faster-whisper) supplies word timing only. Its words are
  aligned to Higgs's with a sequence diff, and each Higgs word takes the time
  of the Whisper word it matched.

Everything runs on the Demucs vocal stem, never the mix: music under speech
is what makes both VAD and Whisper invent words.
"""

from __future__ import annotations

import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

from . import boson, config, media

SR16 = 16000


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Segment:
    id: int
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list, repr=False)

    @property
    def duration(self) -> float:
        return self.end - self.start


# ---------------------------------------------------------------- VAD

def speech_regions(wav16: Path) -> list[tuple[float, float]]:
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    audio = decode_audio(str(wav16), sampling_rate=SR16)
    # opensubs: speech at p >= 0.5. A 250 ms silence is a breath, not a turn.
    opts = VadOptions(threshold=0.5, min_speech_duration_ms=200,
                      min_silence_duration_ms=250, speech_pad_ms=80)
    return [(t["start"] / SR16, t["end"] / SR16)
            for t in get_speech_timestamps(audio, opts)]


def chunk_regions(regions: list[tuple[float, float]], max_len: float = 90.0
                  ) -> list[tuple[float, float]]:
    """Group VAD regions into chunks that never cut through speech."""
    chunks: list[list[float]] = []
    for s, e in regions:
        if chunks and e - chunks[-1][0] <= max_len:
            chunks[-1][1] = e
        else:
            chunks.append([s, e])
    return [(max(0.0, s - 0.15), e + 0.15) for s, e in chunks]


# ---------------------------------------------------------------- Whisper timing

_whisper = None


def whisper_words(wav16: Path, language: str | None) -> tuple[list[Word], str]:
    """Timed words, and the language Whisper heard (its guess when `language` is None)."""
    global _whisper
    from faster_whisper import WhisperModel

    if _whisper is None:
        _whisper = WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")
    segs, info = _whisper.transcribe(
        str(wav16), language=language, word_timestamps=True, vad_filter=True,
        # Previous-text conditioning is where Whisper's loops come from.
        condition_on_previous_text=False, beam_size=5)
    words = []
    for seg in segs:
        for w in seg.words or []:
            # Chinese and Japanese words become one token per character, the
            # unit the Higgs text is split into too.
            for k, tok in enumerate(sub := _tokens(w.word)):
                d = (w.end - w.start) / len(sub)
                words.append(Word(tok, w.start + k * d, w.start + (k + 1) * d))
    return words, info.language


# ---------------------------------------------------------------- alignment

def _norm(tok: str) -> str:
    tok = unicodedata.normalize("NFKC", tok).lower()
    return re.sub(r"[^\w]", "", tok)


def _seam(m: re.Match) -> str:
    nxt = m.group(2)
    return " " + (nxt if nxt == "I" or nxt.isupper() else nxt.lower())


_CJK = r"\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
_CJK_TOKEN = re.compile(rf"[{_CJK}][^\s{_CJK}\w]*|[^\s{_CJK}]+")


def is_cjk(tok: str) -> bool:
    return bool(re.match(rf"[{_CJK}]", tok))


def join_tokens(toks: list[str]) -> str:
    """Words with spaces, CJK characters without: 我们用 Claude 做的."""
    out = ""
    for t in toks:
        if out and not (is_cjk(t) and is_cjk(out[-1])) and not (is_cjk(t) and not out[-1].isalnum()) \
                and not (is_cjk(out[-1]) and not t[:1].isalnum()):
            out += " "
        out += t
    return out


def _tokens(text: str) -> list[str]:
    # Higgs joins its internal ~30 s windows as "languages.That" — a full stop
    # with no space, mid-sentence ("it does audio.And visuals"). Real sentence
    # ends always carry the space, so the unspaced one is a seam: drop it.
    text = re.sub(r"(?<=[a-z])(\.)([A-Z][a-z]*|I)\b", _seam, text)
    text = re.sub(r"([!?,;:])(?=[A-Z])", r"\1 ", text)
    return _CJK_TOKEN.findall(text)


def align(text: str, timed: list[Word], lo: float, hi: float) -> list[Word]:
    """Give each token of `text` a time, borrowed from the matching Whisper word.

    Runs of tokens Whisper heard differently ("Eleven" vs "11", "ten thousand"
    vs "10,000") share the span of the Whisper words they replace, split by
    character length — the same proportional rule opensubs uses to re-spread.
    """
    toks = _tokens(text)
    if not toks:
        return []
    if not timed:  # nothing to borrow from: spread evenly across the chunk
        return _spread(toks, lo, hi)
    a = [_norm(t) for t in toks]
    b = [_norm(w.text) for w in timed]
    out: list[Word | None] = [None] * len(toks)
    for op, i1, i2, j1, j2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                w = timed[j1 + k]
                out[i1 + k] = Word(toks[i1 + k], w.start, w.end)
        elif op == "replace":
            for k, w in enumerate(_spread(toks[i1:i2], timed[j1].start, timed[j2 - 1].end)):
                out[i1 + k] = w
    # "insert" runs — tokens Whisper never heard — sit between their neighbours.
    i = 0
    while i < len(out):
        if out[i] is not None:
            i += 1
            continue
        j = i
        while j < len(out) and out[j] is None:
            j += 1
        s = out[i - 1].end if i > 0 else max(lo, (out[j].start - 0.3 * (j - i)) if j < len(out) else lo)
        e = out[j].start if j < len(out) else min(hi, s + 0.3 * (j - i))
        if e <= s:
            e = s + 0.05 * (j - i)
        for k, w in enumerate(_spread(toks[i:j], s, e)):
            out[i + k] = w
        i = j
    return [w for w in out if w is not None]


def _spread(toks: list[str], start: float, end: float) -> list[Word]:
    total = sum(max(1, len(t)) for t in toks)
    t, words = start, []
    for tok in toks:
        d = (end - start) * max(1, len(tok)) / total
        words.append(Word(tok, t, t + d))
        t += d
    return words


# ---------------------------------------------------------------- segmentation

SENTENCE_END = re.compile(r"[.!?…。！？]['\"”’)\]]*$")
CLAUSE_END = re.compile(r"[,;:，、；：]['\"”’)\]]*$")


def segment(words: list[Word], *, pause_split: float = 0.6, max_dur: float = 11.0,
            min_dur: float = 1.2) -> list[Segment]:
    """Sentences, cut at pauses and capped in length, short ones merged.

    A dub segment is a unit the translator sees whole and the TTS speaks in one
    breath, so full sentences beat subtitle-sized cues: splitting mid-clause
    gives Chinese word order nowhere to go.
    """
    groups: list[list[Word]] = []
    cur: list[Word] = []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        gap = (nxt.start - w.end) if nxt else 99
        if SENTENCE_END.search(w.text) or gap > pause_split or nxt is None:
            groups.extend(_cap(cur, max_dur))
            cur = []
    groups = _merge_briefs(groups, min_dur=min_dur, max_dur=max_dur)
    return [Segment(i, g[0].start, g[-1].end, join_tokens([w.text for w in g]), g)
            for i, g in enumerate(groups)]


def _cap(ws: list[Word], max_dur: float) -> list[list[Word]]:
    if ws[-1].end - ws[0].start <= max_dur or len(ws) < 4:
        return [ws]
    # Cut at the clause end nearest the middle; failing that, the widest gap.
    mid = (ws[0].start + ws[-1].end) / 2
    cands = [i for i in range(1, len(ws) - 1) if CLAUSE_END.search(ws[i].text)]
    if cands:
        k = min(cands, key=lambda i: abs(ws[i].end - mid))
    else:
        k = max(range(1, len(ws) - 1), key=lambda i: ws[i + 1].start - ws[i].end)
    return _cap(ws[: k + 1], max_dur) + _cap(ws[k + 1:], max_dur)


def _merge_briefs(groups: list[list[Word]], *, min_dur: float, max_dur: float
                  ) -> list[list[Word]]:
    """opensubs mergeBriefs: a cue too short to dub joins a close neighbour."""
    out: list[list[Word]] = []
    for g in groups:
        if out:
            prev = out[-1]
            short = (g[-1].end - g[0].start) < min_dur or (prev[-1].end - prev[0].start) < min_dur
            close = g[0].start - prev[-1].end <= 0.4
            fits = g[-1].end - prev[0].start <= max_dur
            if short and close and fits:
                out[-1] = prev + g
                continue
        out.append(g)
    return out


# ---------------------------------------------------------------- cleanup (from opensubs)

# Stock phrases ASR invents over music and silence. Compared with case,
# spaces and punctuation stripped, as opensubs' cleanup.ts does.
SIGN_OFFS = {
    "thanksforwatching", "thankyouforwatching", "pleasesubscribe",
    "likeandsubscribe", "subtitlesbytheamaraorgcommunity", "thankyou",
    "字幕由amaraorg社群提供", "谢谢观看", "謝謝觀看", "请不吝点赞订阅转发打赏支持明镜与点点栏目",
    "ご視聴ありがとうございました", "시청해주셔서감사합니다",
}
LABEL_WORDS = {"music", "applause", "laughter", "laughs", "silence", "noise",
               "inaudible", "音乐", "掌声", "笑声"}


def _squash(s: str) -> str:
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).lower())


def _is_label(text: str) -> bool:
    words = [w for w in re.split(r"\s+", re.sub(r"[\[\]()♪♫*_\-]", " ", text).lower()) if w]
    if not words:
        return True
    return sum(_squash(w) in LABEL_WORDS for w in words) / len(words) >= 0.6


def _destutter(text: str) -> str:
    # The same word three or more times running is a decoder loop, not speech.
    return re.sub(r"\b(\w+)(?:[\s,]+\1\b){2,}", r"\1", text, flags=re.I)


def clean(segments: list[Segment]) -> tuple[list[Segment], list[dict]]:
    kept, removed = [], []
    for s in segments:
        text = _destutter(s.text).strip()
        reason = None
        if not _squash(text) or _is_label(text):
            reason = "label"
        # A lone "Thank you." inside real speech is speech; only a short
        # stand-alone sign-off is the hallucination.
        elif _squash(text) in SIGN_OFFS and s.duration < 2.5 and len(segments) > 1:
            reason = "sign-off"
        if reason:
            removed.append({"start": s.start, "end": s.end, "text": s.text, "reason": reason})
        else:
            s.text = text
            kept.append(s)
    for i, s in enumerate(kept):
        s.id = i
    return kept, removed


# ---------------------------------------------------------------- the whole step

def recognise(vocals: Path, work: Path, *, language: str | None = None, log=print
              ) -> tuple[list[Segment], dict]:
    wav16 = media.resample(vocals, work / "vocals16k.wav", sr=SR16)
    regions = speech_regions(wav16)
    log(f"VAD: {len(regions)} speech regions, "
        f"{sum(e - s for s, e in regions):.1f}s of speech")
    if not regions:
        return [], {"vad": [], "removed": [], "stt": "", "source": "none"}

    chunks = chunk_regions(regions)

    def stt(i_chunk):
        i, (s, e) = i_chunk
        clip = media.resample(vocals, work / f"stt_{i:03d}.wav", sr=SR16, start=s, dur=e - s)
        return boson.transcribe(clip, language=language)

    # Higgs runs in the background while Whisper takes the CPU.
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(stt, c) for c in enumerate(chunks)]
        timed, heard = whisper_words(wav16, language)
        try:
            texts = [f.result() for f in futures]
            source = "higgs"
        except Exception as e:  # keep dubbing on Whisper's words rather than fail
            log(f"Higgs STT failed, using Whisper's transcript: {e}")
            texts, source = None, "whisper"
    language = language or heard
    log(f"Whisper: {len(timed)} timed words" + ("" if texts is None else f", language {language}"))

    if texts is None:
        words = timed
    else:
        words = []
        for (s, e), text in zip(chunks, texts):
            inside = [w for w in timed if s - 0.2 <= (w.start + w.end) / 2 <= e + 0.2]
            words += align(text, inside, s, e)
    segs = segment(words)
    segs, removed = clean(segs)
    log(f"{len(segs)} segments ({len(removed)} removed by cleanup)")
    return segs, {"vad": regions, "removed": removed, "source": source, "language": language,
                  "stt": " ".join(texts) if texts else ""}
