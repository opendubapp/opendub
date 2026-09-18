"""Higgs Audio on the Boson AI API: speech-to-text, the chat model, and TTS.

Every call goes through `_request`, which retries 429 and 5xx with backoff —
the hackathon keys rate-limit hard, and a dub makes dozens of calls.
"""

from __future__ import annotations

import base64
import json
import random
import re
import threading
import time
from pathlib import Path

import httpx

from . import config

# Measured on the hackathon key: about ONE request per second, shared across
# every endpoint; anything faster is a 429 that still costs a slot. So request
# *starts* are paced (not just capped in number), while up to three can be in
# flight at once — a TTS call takes ~3 s, so overlap is where the speed is.
_SLOTS = threading.BoundedSemaphore(3)
_MIN_GAP = 1.0 / float(__import__("os").environ.get("OPENVOICE_RPS", "0.95"))
_next_start = [0.0]
_pace_lock = threading.Lock()
calls = {"ok": 0, "429": 0}  # for the job log


def _pace(extra: float = 0.0) -> None:
    """Block until this thread may start a request; `extra` pushes everyone back."""
    with _pace_lock:
        now = time.time()
        start = max(now, _next_start[0]) + extra
        _next_start[0] = start + _MIN_GAP
    if start > now:
        time.sleep(start - now)
_client = httpx.Client(timeout=httpx.Timeout(180.0, connect=15.0))


class BosonError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    if not config.BOSON_API_KEY:
        raise BosonError("BOSON_API_KEY is not set (put it in .env)")
    return {"Authorization": f"Bearer {config.BOSON_API_KEY}"}


def _request(path: str, *, attempts: int = 12, **kwargs) -> httpx.Response:
    """POST at the key's pace, retrying 429/5xx; a 429 pushes every thread back."""
    url = f"{config.BOSON_BASE_URL}{path}"
    last = ""
    backoff = 0.0
    for attempt in range(attempts):
        with _SLOTS:
            _pace(backoff)
            try:
                r = _client.post(url, headers=_headers(), **kwargs)
            except httpx.TransportError as e:
                last = f"{type(e).__name__}: {e}"
                r = None
        if r is not None:
            if r.status_code < 400:
                calls["ok"] += 1
                return r
            if r.status_code == 429:
                calls["429"] += 1
            last = f"{r.status_code} {r.text[:300]}"
            body = r.text
            # Out of credit is not transient — retrying only burns time.
            if "insufficient_quota" in body:
                raise BosonError(f"Boson account is out of credit: {body[:200]}")
            if r.status_code not in (408, 409, 429) and r.status_code < 500:
                raise BosonError(f"{path} failed: {last}")
        backoff = min(8.0, 1.0 + attempt) + random.uniform(0, 0.5)
    raise BosonError(f"{path} failed after {attempts} attempts: {last}")


# ---------------------------------------------------------------- speech-to-text

def transcribe(wav: Path, language: str | None = None) -> str:
    """Plain transcript. higgs-stt-3.1 has no timestamps (verbose_json is refused)."""
    data = {"model": config.STT_MODEL, "response_format": "json"}
    if language:
        data["language"] = language
    with open(wav, "rb") as f:
        r = _request("/audio/transcriptions", data=data,
                     files={"file": (wav.name, f, "audio/wav")})
    return (r.json().get("text") or "").strip()


# ---------------------------------------------------------------- chat model

def chat_json(system: str, user: str, *, max_tokens: int = 4000,
              temperature: float = 0.2) -> dict:
    """Ask the chat model for a JSON object, tolerating fences and preamble."""
    body = {
        "model": config.LLM_MODEL,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    r = _request("/chat/completions", json=body)
    text = r.json()["choices"][0]["message"].get("content") or ""
    return parse_json_object(text)


def parse_json_object(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise BosonError(f"model did not return JSON: {text[:200]!r}")
    return json.loads(text[start:end + 1])


# ---------------------------------------------------------------- text-to-speech

def speak(text: str, out: Path, *, ref_audio: Path | None = None,
          ref_text: str | None = None, voice: str | None = None,
          tn_language: str | None = None, enable_tn: bool = True) -> Path:
    """Synthesise `text` to a WAV: cloning `ref_audio` if given, else preset `voice`."""
    data: dict[str, str] = {"model": config.TTS_MODEL, "input": text,
                            "response_format": "wav",
                            "enable_tn": "true" if enable_tn else "false"}
    if tn_language:
        data["tn_language"] = tn_language
    if voice and ref_audio is None:
        data["voice"] = voice
    files = None
    if ref_audio is not None:
        if ref_text:
            data["ref_text"] = ref_text
        files = {"ref_audio": (ref_audio.name, ref_audio.read_bytes(), "audio/wav")}
    r = _request("/audio/speech", data=data, files=files)
    payload = r.content
    if r.headers.get("content-type", "").startswith("application/json"):
        payload = base64.b64decode(r.json()["audio"])
    out.write_bytes(payload)
    return out
