"""Settings, and the languages we dub into."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK_DIR = Path(os.environ.get("OPENDUB_WORK_DIR", ROOT / "work"))


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

BOSON_API_KEY = os.environ.get("BOSON_API_KEY", "").strip()
BOSON_BASE_URL = os.environ.get("BOSON_BASE_URL", "https://api.boson.ai/v1").rstrip("/")
STT_MODEL = os.environ.get("OPENDUB_STT_MODEL", "higgs-stt-3.1")
TTS_MODEL = os.environ.get("OPENDUB_TTS_MODEL", "higgs-tts-3")
LLM_MODEL = os.environ.get("OPENDUB_LLM_MODEL", "higgs-realtime")
# Local Whisper supplies word timing only; Higgs supplies the words.
WHISPER_MODEL = os.environ.get("OPENDUB_WHISPER_MODEL", "small")


@dataclass(frozen=True)
class Language:
    code: str        # BCP-47-ish, as opensubs uses (zh-Hans, not zh-CN)
    name: str        # English name, sent to the LLM — models follow names better than codes
    endonym: str
    iso: str         # ISO 639-1, for STT `language` and TTS `tn_language`
    cps: float       # comfortable spoken characters per second for the dub budget
    cjk: bool = False  # no spaces between words; subtitle budget counted in characters


# cps is what a natural voice says per second, in characters of the written
# language without punctuation (zh measured on higgs-tts-3 clones). It sets how
# much text we ask the translator for, so the dub lasts as long as the speaker.
LANGUAGES: dict[str, Language] = {
    l.code: l
    for l in [
        Language("en", "English", "English", "en", 15.0),
        Language("zh-Hans", "Chinese (Simplified)", "简体中文", "zh", 5.2, cjk=True),
        Language("zh-Hant", "Chinese (Traditional)", "繁體中文", "zh", 5.2, cjk=True),
        Language("ja", "Japanese", "日本語", "ja", 7.5, cjk=True),
        Language("ko", "Korean", "한국어", "ko", 6.5, cjk=True),
        Language("es", "Spanish", "Español", "es", 15.0),
        Language("fr", "French", "Français", "fr", 15.0),
        Language("de", "German", "Deutsch", "de", 14.5),
        Language("pt", "Portuguese", "Português", "pt", 15.0),
        Language("it", "Italian", "Italiano", "it", 15.0),
        Language("ru", "Russian", "Русский", "ru", 14.0),
        Language("hi", "Hindi", "हिन्दी", "hi", 13.0),
        Language("id", "Indonesian", "Bahasa Indonesia", "id", 15.0),
        Language("ms", "Malay", "Bahasa Melayu", "ms", 15.0),
        Language("vi", "Vietnamese", "Tiếng Việt", "vi", 13.0),
        Language("th", "Thai", "ไทย", "th", 11.0, cjk=True),
        Language("ar", "Arabic", "العربية", "ar", 13.0),
    ]
}
DEFAULT_TARGET = "zh-Hans"


def language_for(code: str | None) -> Language:
    """A Language for a target code or a bare ISO code ("en", "zh")."""
    if code in LANGUAGES:
        return LANGUAGES[code]
    for l in LANGUAGES.values():
        if l.iso == code:
            return l
    if code == "en":
        return Language("en", "English", "English", "en", 15.0)
    return Language(code or "und", code or "the original language", code or "", code or "", 14.0)
