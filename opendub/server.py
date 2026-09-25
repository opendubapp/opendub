"""The web app: upload, watch the stages, compare, fix a line, download.

    .venv/bin/uvicorn opendub.server:app --port 8000
"""

from __future__ import annotations

import json
import queue
import re
import shutil
import threading
import time
import uuid
from dataclasses import asdict
from pathlib import Path

import base64
import io
import tempfile

import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from . import tone as tone_mod
from .pipeline import STAGES, Job, Options, State

WEB = config.ROOT / "web"
config.WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="OpenDub")

# opendub.app dubs in the visitor's tab and, for the free voice, asks this app
# (on the visitor's own computer) to speak. Only that origin may call it, and
# Chrome's private-network preflight needs the extra header to reach localhost.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://opendub.app", "http://127.0.0.1:8911", "http://127.0.0.1:8912"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    allow_private_network=True,
)

_jobs: dict[str, Job] = {}
_queue: "queue.Queue[tuple[str, callable]]" = queue.Queue()
_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
_FILES = re.compile(r"^(dubbed\.mp4|dub_mix\.wav|ref_voice\.wav|subtitles\.[A-Za-z-]+\.(srt|vtt)|source\.[a-z0-9]+)$")


def _worker() -> None:
    # One job at a time: Demucs and Whisper each want the whole machine, and
    # two at once finish later than one after the other.
    while True:
        _, fn = _queue.get()
        try:
            fn()
        finally:
            _queue.task_done()


threading.Thread(target=_worker, daemon=True).start()


def _load_existing() -> None:
    for jf in sorted(config.WORK_DIR.glob("*/job.json")):
        try:
            st = State(**json.loads(jf.read_text()))
        except Exception:
            continue
        if st.status in ("queued", "running"):  # the server died under it
            st.status, st.error = "error", "interrupted by a server restart"
        _jobs[st.id] = Job(jf.parent, st)


_load_existing()


def _public(st: State) -> dict:
    d = asdict(st)
    if d.get("result"):
        d["result"] = {k: v for k, v in d["result"].items() if not k.startswith("_")}
    src = next(_jobs[st.id].work.glob("source.*"), None) if st.id in _jobs else None
    d["source_file"] = src.name if src else None
    d["queue_position"] = None
    return d


def _job(job_id: str) -> Job:
    if not _JOB_ID.match(job_id) or job_id not in _jobs:
        raise HTTPException(404, "no such job")
    return _jobs[job_id]


# ---------------------------------------------------------------- API

@app.get("/api/config")
def get_config():
    return {
        "languages": [{"code": l.code, "name": l.name, "endonym": l.endonym}
                      for l in config.LANGUAGES.values()],
        "default_target": config.DEFAULT_TARGET,
        "stages": [{"key": k, "label": v} for k, v in STAGES],
        "has_key": bool(config.BOSON_API_KEY),
        "emotions": tone_mod.EMOTIONS,
        "engines": __import__("opendub.engines", fromlist=["catalog"]).catalog(),
        "voices": [{"id": k, "label": v} for k, v in tone_mod.PRESET_VOICES.items()],
        "models": {"stt": config.STT_MODEL, "tts": config.TTS_MODEL, "llm": config.LLM_MODEL},
    }


@app.get("/api/jobs")
def list_jobs():
    jobs = sorted(_jobs.values(), key=lambda j: j.state.created, reverse=True)
    return [{"id": j.state.id, "filename": j.state.filename, "status": j.state.status,
             "created": j.state.created, "target": j.state.options.get("target")}
            for j in jobs[:20]]


@app.post("/api/jobs")
def create_job(file: UploadFile = File(...), target: str = Form(config.DEFAULT_TARGET),
               source: str = Form("auto"),
               mode: str = Form("replace"), burn_subtitles: bool = Form(True),
               qa: bool = Form(True), voice: str = Form("clone"), tone: str = Form("auto"),
               expressive: str = Form("auto"), style: str = Form("auto"),
               pitch: str = Form("natural"), normalize: bool = Form(True)):
    if target not in config.LANGUAGES:
        raise HTTPException(400, f"unsupported language {target}")
    if source != "auto" and source not in config.LANGUAGES:
        raise HTTPException(400, f"unsupported source language {source}")
    from . import engines as eng
    if voice != "clone" and voice not in eng.CATALOG and voice not in tone_mod.PRESET_VOICES:
        raise HTTPException(400, "unknown voice")
    if tone != "auto" and tone not in tone_mod.EMOTIONS:
        raise HTTPException(400, "unknown tone")
    if expressive != "auto" and expressive not in tone_mod.EXPRESSIVE:
        raise HTTPException(400, "unknown expressiveness")
    if style != "auto" and style not in tone_mod.STYLES:
        raise HTTPException(400, "unknown style")
    if pitch not in tone_mod.PITCHES:
        raise HTTPException(400, "unknown pitch")
    if mode not in ("replace", "voiceover"):
        raise HTTPException(400, "mode must be replace or voiceover")
    if not config.BOSON_API_KEY:
        raise HTTPException(500, "BOSON_API_KEY is not set on the server")
    suffix = Path(file.filename or "video.mp4").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{2,5}", suffix):
        suffix = ".mp4"
    job_id = time.strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    work = config.WORK_DIR / job_id
    work.mkdir(parents=True)
    src = work / f"source{suffix}"
    with open(src, "wb") as f:
        shutil.copyfileobj(file.file, f, length=4 << 20)
    opts = Options(target=target, source=source, mode=mode, burn_subtitles=burn_subtitles, qa=qa,
                   voice=voice, tone=tone, expressive=expressive, style=style, pitch=pitch,
                   normalize=normalize)
    job = Job(work, State(id=job_id, filename=Path(file.filename or "video").name,
                          options=asdict(opts)))
    job.save()
    _jobs[job_id] = job
    _queue.put((job_id, lambda: job.run(src)))
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return JSONResponse(_public(_job(job_id).state), headers={"Cache-Control": "no-store"})


class Redub(BaseModel):
    edits: dict[int, str] = {}
    tones: dict[int, dict] = {}
    timings: dict[int, list[float] | None] = {}


@app.post("/api/jobs/{job_id}/redub")
def redub(job_id: str, body: Redub):
    job = _job(job_id)
    if job.state.status in ("queued", "running"):
        raise HTTPException(409, "this job is still running")
    if not job.state.result:
        raise HTTPException(409, "this job has no finished dub to edit")
    job.state.status = "queued"
    job.save()
    for t in body.tones.values():
        if t.get("emotion") not in tone_mod.EMOTIONS:
            raise HTTPException(400, "unknown emotion")
    for span in body.timings.values():
        if span is not None and (len(span) != 2 or not 0 <= span[0] < span[1]):
            raise HTTPException(400, "a timing is [start, end] in seconds")
    _queue.put((job_id, lambda: job.redub(body.edits, body.tones, body.timings)))
    return {"ok": True}


@app.get("/api/jobs/{job_id}/files/{name}")
def get_file(job_id: str, name: str, download: int = 0):
    job = _job(job_id)
    if not _FILES.match(name):
        raise HTTPException(404, "not a deliverable")
    path = job.work / name
    if not path.exists():
        raise HTTPException(404, "not ready")
    headers = {"Cache-Control": "no-store"}
    if download:
        stem = Path(job.state.filename).stem or "video"
        tgt = job.state.options.get("target", "")
        nice = {"dubbed.mp4": f"{stem}.{tgt}.mp4", "dub_mix.wav": f"{stem}.{tgt}.wav"}.get(
            name, f"{stem}.{name.removeprefix('subtitles.')}")
        return FileResponse(path, filename=nice, headers=headers)
    return FileResponse(path, headers=headers)


# ---------------------------------------------------------------- the free voice, for opendub.app

@app.get("/api/local/health")
def local_health():
    from . import engines
    cat = engines.catalog()
    return {"ok": True, "app": "opendub", "engines": cat,
            "omnivoice": any(e["id"] == "omnivoice" and e["ready"] for e in cat)}


@app.post("/api/local/speak")
def local_speak(ref_audio: UploadFile = File(...), ref_text: str = Form(""), lines: str = Form(...),
                engine: str = Form("omnivoice"), language: str = Form("")):
    """A free engine on this computer, cloning `ref_audio`: one WAV per line."""
    from . import engines
    if engine not in engines.CATALOG:
        raise HTTPException(400, f"unknown engine {engine}")
    if not engines.installed(engine):
        raise HTTPException(501, f"{engines.CATALOG[engine].name} is not installed here: engines/{engine}/setup.sh")
    try:
        items = json.loads(lines)
        assert isinstance(items, list) and 0 < len(items) <= 16
        texts = [str(i["text"])[:400] for i in items]
        durations = [float(i["duration"]) if i.get("duration") else None for i in items]
    except Exception:
        raise HTTPException(400, "lines must be a JSON list of up to 16 {text, duration}")
    with tempfile.NamedTemporaryFile(suffix=".wav") as ref:
        ref.write(ref_audio.file.read())
        ref.flush()
        try:
            clips, sr = engines.speak(engine, texts, Path(ref.name), ref_text.strip() or None, durations,
                                      language.strip() or None)
        except RuntimeError as e:
            raise HTTPException(500, str(e))
    out = []
    for c in clips:
        buf = io.BytesIO()
        sf.write(buf, c, sr, format="WAV", subtype="PCM_16")
        out.append(base64.b64encode(buf.getvalue()).decode())
    return {"clips": out, "sample_rate": sr,
            "exact_duration": engines.CATALOG[engine].exact_duration}


# ---------------------------------------------------------------- the page

@app.get("/account")
def account_page():
    return FileResponse(WEB / "account.html")


@app.get("/privacy")
def privacy_page():
    return FileResponse(WEB / "privacy.html")


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
