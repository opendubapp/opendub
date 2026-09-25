"""Translation for dubbing, on the Higgs chat model.

The rules are opensubs' (crates/subs-translate), with one addition dubbing
needs and subtitling does not: a **character budget per line**, computed from
how long the speaker took to say it. A subtitle can run long and the reader
copes; a dub that runs long has to be sped up or it walks over the next line.
"""

from __future__ import annotations

import json
import re

from . import boson
from .asr import Segment
from .config import Language

MAX_BATCH = 40

SYSTEM = """You translate a video's spoken lines for a voice-over dub.

Rules:
- Return exactly one translation per input line, in the same order. Never merge, split, reorder, drop or add entries: entry N of your output is spoken at the timestamp of entry N.
- Each line has "chars": about how many characters a native speaker says in the time the original took. Aim for it — within about 15 %. Much shorter and the voice finishes while the speaker is still talking; much longer and it has to be rushed.
- Write natural spoken {target}, the way a native presenter would say it on camera — not written or formal prose.
- Keep who is speaking to whom: "I/me" stays the speaker and "you" stays the listener. Never swap pronouns.
- Keep product and proper names as written (e.g. Claude, ElevenLabs, MCP). Write numbers the way a speaker would say them in {target}.
- Use the surrounding lines as context: a line may finish a sentence the previous one began.
- A line already in another language (e.g. a quoted French phrase) is translated into {target} too.
{script_rule}
Reply with JSON only: {{"translations": ["...", "..."]}}"""

SCRIPT_RULES = {
    "zh-Hans": "- Use Simplified Chinese characters only (简体字), with Chinese punctuation (，。？！).",
    "zh-Hant": "- Use Traditional Chinese characters only (繁體字), with Chinese punctuation (，。？！).",
    "ja": "- Use natural Japanese with kanji and kana, Japanese punctuation (、。).",
}


def budget(seg_duration: float, lang: Language, slack: float = 1.0) -> int:
    return max(4, int(round(seg_duration * lang.cps * slack)))


def translate(segments: list[Segment], target: Language, *, source_name: str = "English",
              log=print) -> list[str]:
    """One translation per segment, each sized to how long the speaker took."""
    slots = [s.duration for s in segments]
    out: list[str] = []
    for b in range(0, len(segments), MAX_BATCH):
        batch = segments[b:b + MAX_BATCH]
        out += _batch(batch, slots[b:b + MAX_BATCH], target, source_name, log)
    return [to_script(t, target) for t in out]


def _batch(segs, slots, target: Language, source_name: str, log) -> list[str]:
    lines = [{"id": i + 1, "text": s.text, "seconds": round(slot, 1),
              "chars": budget(slot, target)}
             for i, (s, slot) in enumerate(zip(segs, slots))]
    system = SYSTEM.format(target=target.name,
                           script_rule=SCRIPT_RULES.get(target.code, ""))
    user = (f"Translate these {len(lines)} lines from {source_name} into {target.name}.\n\n"
            + json.dumps({"lines": lines}, ensure_ascii=False))
    for attempt in range(3):
        try:
            res = boson.chat_json(system, user, max_tokens=200 + 120 * len(lines))
            got = [str(t).strip() for t in res.get("translations", [])]
            # A count mismatch is a failure, not something to pad: every entry
            # after the first dropped line would play at the wrong time.
            if len(got) == len(lines) and all(got):
                return got
            log(f"translator returned {len(got)} of {len(lines)} lines; retrying")
        except Exception as e:
            log(f"translation attempt {attempt + 1} failed: {e}")
    log("batch translation failed three times; translating line by line")
    return [_one(s.text, target, budget(slot, target), source_name) for s, slot in zip(segs, slots)]


def _one(text: str, target: Language, max_chars: int, source_name: str) -> str:
    system = SYSTEM.format(target=target.name, script_rule=SCRIPT_RULES.get(target.code, ""))
    user = json.dumps({"lines": [{"id": 1, "text": text, "chars": max_chars}]},
                      ensure_ascii=False)
    res = boson.chat_json(system, f"Translate from {source_name} into {target.name}.\n\n{user}")
    return str((res.get("translations") or [text])[0]).strip()


def resize(source: str, current: str, target: Language, want_chars: int,
           context: str = "") -> str:
    """Re-say a line so it takes about as long as the original did.

    Shorter: cut filler and redundancy. Longer: say it the way a person would
    at the speaker's own pace — the fuller natural phrasing, the connective
    words the speaker actually used — never new facts.
    """
    n = count_chars(current, target)
    longer = want_chars > n
    how = ("It is too SHORT: the speaker took longer to say this. Rephrase it more fully "
           "and naturally — restore interjections, connectives and emphasis the speaker "
           "actually used — but add no new information."
           if longer else
           "It is too LONG to say in the time. Say the same thing more compactly — cut "
           "filler and redundancy first, never the meaning.")
    system = (f"You adjust the length of {target.name} voice-over lines so each one takes as "
              f"long to say as the original. {how} Keep the natural spoken register and "
              "proper names. Reply with JSON only: {\"text\": \"...\"}"
              + ("\n" + SCRIPT_RULES[target.code] if target.code in SCRIPT_RULES else ""))
    user = json.dumps({"original": source, "current_translation": current,
                       "current_chars": n, "target_chars": want_chars,
                       "context": context}, ensure_ascii=False)
    try:
        res = boson.chat_json(system, user, max_tokens=400, temperature=0.4)
        text = str(res.get("text") or "").strip()
        return to_script(text, target) if text else current
    except Exception:
        return current


def count_chars(text: str, lang: Language) -> int:
    """Spoken length in the budget's units: characters, minus punctuation and spaces."""
    return len(re.sub(r"[\s\W_]+", "", text))


def to_script(text: str, lang: Language) -> str:
    """Force the requested Chinese script: models drift between the two."""
    if lang.code not in ("zh-Hans", "zh-Hant"):
        return text
    try:
        import zhconv
    except ImportError:
        return text
    return zhconv.convert(text, "zh-cn" if lang.code == "zh-Hans" else "zh-tw")
