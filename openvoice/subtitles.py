"""Subtitles timed to the dubbed voice, not the original one.

A viewer hears the new line and reads it at the same moment, so cues follow
the placed TTS clips. Long lines are cut into cues at punctuation and the time
is shared by character count — opensubs' `spread`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .config import Language

CJK_PUNCT_BREAK = "，。！？；：、,.!?;:"


@dataclass
class Cue:
    start: float
    end: float
    text: str


def layout(width: int, height: int, lang: Language) -> dict:
    """Font size and line budget for this frame. Portrait video gets its own."""
    fs = round(min(height * 0.045, width * 0.075))
    per_line = int(width * 0.86 / fs) if lang.cjk else int(width * 0.86 / (fs * 0.5))
    per_line = min(per_line, 20 if lang.cjk else 42)  # opensubs MAX_CHARS_CJK / LATIN
    portrait = height > width
    # Portrait shorts usually carry their own burned-in captions around 80 %
    # down the frame. An opaque band at that height covers them instead of
    # stacking a second caption on top.
    margin_v = round(height * (0.165 if portrait else 0.06))
    return {"font_size": fs, "per_line": max(8, per_line), "margin_v": margin_v,
            "portrait": portrait}


def _clauses(text: str, cjk: bool) -> list[str]:
    parts = re.split(r"(?<=[，。！？；：、,.!?;:])" + ("" if cjk else r"\s+"), text)
    return [p.strip() for p in parts if p.strip()]


def _plen(s: str) -> int:
    return len(re.sub(r"\s", "", s))


def _pieces(text: str, cap: int, cjk: bool) -> list[str]:
    out, cur = [], ""
    joiner = "" if cjk else " "
    for c in _clauses(text, cjk):
        while _plen(c) > cap:  # a clause that cannot fit anywhere: hard cut
            if cjk:
                cut = max([i for i in _word_bounds(c) if i <= cap] or [cap])
                head, c = c[:cut], c[cut:]
            else:
                words, head = c.split(), ""
                while words and _plen(head + words[0]) <= cap:
                    head = (head + " " + words.pop(0)).strip()
                if not head:
                    head = words.pop(0)
                c = " ".join(words)
            if cur:
                out.append(cur)
                cur = ""
            out.append(head)
        if cur and _plen(cur + c) > cap:
            out.append(cur)
            cur = c
        else:
            cur = (cur + joiner + c).strip() if cur else c
    if cur:
        out.append(cur)
    return out


def _display(piece: str, cjk: bool) -> str:
    """Chinese subtitles drop 。 and ， — a space reads better on screen."""
    if not cjk:
        return piece
    piece = re.sub(r"[，。、；：]+$", "", piece)
    return re.sub(r"[，。、；：]", " ", piece).strip()


def _word_bounds(text: str) -> list[int]:
    """Indices where a CJK line may break without cutting a word in half."""
    try:
        import jieba
        jieba.setLogLevel(60)
        out, i = [], 0
        for w in jieba.cut(text):
            i += len(w)
            out.append(i)
        return out[:-1]
    except ImportError:
        return list(range(1, len(text)))


def _wrap(text: str, per_line: int, cjk: bool) -> list[str]:
    if _plen(text) <= per_line:
        return [text]
    if cjk:
        mid = len(text) / 2
        spaces = [i for i, ch in enumerate(text) if ch == " "]
        if spaces:  # a clause break near the middle beats any word break
            cut = min(spaces, key=lambda i: abs(i - mid))
            if abs(cut - mid) <= max(3, len(text) / 4) and max(cut, len(text) - cut) <= per_line + 1:
                return [text[:cut].strip(), text[cut:].strip()]
        cands = [i for i in _word_bounds(text) if max(i, len(text) - i) <= per_line] or [int(mid)]
        cut = min(cands, key=lambda i: abs(i - mid))
        return [text[:cut].strip(), text[cut:].strip()]
    words, lines, cur = text.split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > per_line:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    lines.append(cur)
    if len(lines) > 2:  # rebalance into two
        half = len(words) // 2
        lines = [" ".join(words[:half]), " ".join(words[half:])]
    return lines


def cues_for(items: list[tuple[float, float, str]], lang: Language, per_line: int,
             lines_per_cue: int = 2) -> list[Cue]:
    cap = per_line * lines_per_cue
    cues: list[Cue] = []
    for start, end, text in items:
        pieces = _pieces(text, cap, lang.cjk)
        total = sum(max(1, _plen(p)) for p in pieces)
        t = start
        for p in pieces:
            d = (end - start) * max(1, _plen(p)) / total
            shown = "\n".join(_wrap(_display(p, lang.cjk), per_line, lang.cjk))
            if shown:
                cues.append(Cue(t, t + d, shown))
            t += d
    return cues


# ---------------------------------------------------------------- writers

def _ts(t: float, sep: str = ",") -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def write_srt(cues: list[Cue], path: Path) -> Path:
    path.write_text("\n".join(f"{i}\n{_ts(c.start)} --> {_ts(c.end)}\n{c.text}\n"
                              for i, c in enumerate(cues, 1)), encoding="utf-8")
    return path


def write_vtt(cues: list[Cue], path: Path) -> Path:
    body = "\n".join(f"{_ts(c.start, '.')} --> {_ts(c.end, '.')}\n{c.text}\n" for c in cues)
    path.write_text("WEBVTT\n\n" + body, encoding="utf-8")
    return path


def _ass_ts(t: float) -> str:
    cs = int(round(max(0.0, t) * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def write_ass(cues: list[Cue], path: Path, width: int, height: int, lay: dict,
              font: str = "PingFang SC") -> Path:
    fs = lay["font_size"]
    pad = max(4, round(fs * 0.28))  # BorderStyle 3: Outline is the box padding
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Dub,{font},{fs},&H00FFFFFF,&H00FFFFFF,&H14000000,&H14000000,0,0,0,0,100,100,0,0,3,{pad},0,2,{round(width * 0.05)},{round(width * 0.05)},{lay['margin_v']},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = [f"Dialogue: 0,{_ass_ts(c.start)},{_ass_ts(c.end)},Dub,,0,0,0,,"
          + c.text.replace("\n", "\\N") for c in cues]
    path.write_text(head + "\n".join(ev) + "\n", encoding="utf-8")
    return path
