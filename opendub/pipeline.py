"""Video in, dubbed video out. Usable from the web server or the command line:

    python -m opendub.pipeline input.mp4 --to zh-Hans
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

from . import asr, boson, config, dub, media, subtitles, tone, translate
from . import engines as _engines

STAGES = [
    ("probe", "Read the video"),
    ("separate", "Separate voice from music"),
    ("recognise", "Find speech and transcribe"),
    ("translate", "Translate and read the tone"),
    ("voice", "Clone the voice and speak"),
    ("mix", "Fit and mix the new voice"),
    ("render", "Subtitle and render"),
]


@dataclass
class Options:
    target: str = config.DEFAULT_TARGET
    source: str = "auto"           # a language code, or auto-detect
    mode: str = "replace"          # replace | voiceover
    burn_subtitles: bool = True
    qa: bool = True                # transcribe each clip back and retry mismatches
    # Voice settings — everything Higgs TTS lets us set.
    voice: str = "clone"           # clone the speaker, or a Higgs preset voice
    tone: str = "auto"             # auto (read per line) | neutral | one emotion for all
    expressive: str = "auto"       # auto | low | normal | high
    style: str = "auto"            # auto | none | whispering | shouting
    pitch: str = "natural"         # natural | low | high
    normalize: bool = True         # read numbers and symbols as words

    def __post_init__(self):
        if self.tone is True:      # jobs saved before tone became a choice
            self.tone = "auto"
        elif self.tone is False:
            self.tone = "neutral"


@dataclass
class State:
    id: str
    filename: str
    options: dict
    status: str = "queued"         # queued | running | done | error
    stage: str = ""
    stage_progress: float = 0.0
    stages: dict = field(default_factory=dict)   # key -> {status, seconds}
    log: list = field(default_factory=list)
    error: str | None = None
    result: dict | None = None
    created: float = field(default_factory=time.time)


class Job:
    def __init__(self, work: Path, state: State, on_change: Callable[[State], None] | None = None):
        self.work = work
        self.state = state
        self._on_change = on_change or (lambda s: None)
        self._stage_t0 = 0.0

    # -- reporting
    def save(self) -> None:
        (self.work / "job.json").write_text(json.dumps(asdict(self.state), ensure_ascii=False, indent=1))
        self._on_change(self.state)

    def log(self, msg: str) -> None:
        self.state.log.append({"t": round(time.time() - self.state.created, 1), "msg": msg})
        print(f"[{self.state.id}] {msg}", flush=True)
        self.save()

    def begin(self, key: str) -> None:
        self.state.stage, self.state.stage_progress = key, 0.0
        self.state.stages[key] = {"status": "running"}
        self._stage_t0 = time.time()
        self.save()

    def progress(self, frac: float) -> None:
        self.state.stage_progress = round(frac, 3)
        self._on_change(self.state)

    def end(self, key: str) -> None:
        self.state.stages[key] = {"status": "done", "seconds": round(time.time() - self._stage_t0, 1)}
        self.save()

    # -- the work
    def run(self, video: Path) -> None:
        st = self.state
        st.status = "running"
        try:
            before = dict(boson.calls)
            self._run(video, Options(**st.options))
            st.status, st.stage = "done", ""
            self.log(f"Done. {boson.calls['ok'] - before['ok']} Higgs calls, "
                     f"{boson.calls['429'] - before['429']} rate-limited and retried.")
        except Exception as e:
            st.status, st.error = "error", str(e)
            if st.stage:
                st.stages[st.stage] = {"status": "error"}
            self.log(f"Failed: {e}")
            traceback.print_exc()
        self.save()

    def _run(self, video: Path, opt: Options) -> None:
        w = self.work
        lang = config.LANGUAGES[opt.target]

        self.begin("probe")
        info = media.probe(video)
        total = info["duration"]
        self.log(f"{info['width']}×{info['height']}, {total:.1f}s")
        audio = media.extract_audio(video, w / "audio.wav")
        self.end("probe")

        self.begin("separate")
        try:
            vocals, background = media.separate(audio, w / "stems")
            self.log("Demucs split the voice from the music and effects")
        except Exception as e:  # without stems: dub over the original, ducked
            self.log(f"Voice separation unavailable ({e}); the original will be ducked instead")
            vocals, background = audio, w / "bg_ducked.wav"
            a = media.load(audio, mono=False)
            media.save(background, a * 0.12)
        self.end("separate")

        self.begin("recognise")
        hint = None if opt.source == "auto" else config.language_for(opt.source).iso
        segs, meta = asr.recognise(vocals, w, language=hint, log=self.log)
        if not segs:
            raise RuntimeError("no speech found in this video")
        self.end("recognise")

        self.begin("translate")
        sl = dub.slots(segs, total)
        src_lang = config.language_for(meta["language"])
        texts = translate.translate(segs, lang, source_name=src_lang.name, log=self.log)
        lines_n = len(texts)
        self.log(f"Translated {lines_n} lines from {src_lang.name} into {lang.name}")
        if opt.tone == "auto":
            tones = tone.direct(segs, vocals, log=self.log)
        else:
            fixed = opt.tone if opt.tone in tone.EMOTIONS else "neutral"
            tones = [{"emotion": fixed, "expressive": "normal", "style": "none"} for _ in segs]
        tones = tone.apply_settings(tones, expressive=opt.expressive, style=opt.style, pitch=opt.pitch)
        if opt.tone == "auto":
            moods = sorted({t["emotion"] for t in tones if t["emotion"] != "neutral"})
            self.log(f"Tone: {sum(t['emotion'] != 'neutral' for t in tones)} of {lines_n} lines "
                     f"carry a feeling" + (f" ({', '.join(moods)})" if moods else ""))
        lines = [dub.Line(seg=s, slot=slot, text=t, tone=tn)
                 for s, slot, t, tn in zip(segs, sl, texts, tones)]
        self.end("translate")

        self.begin("voice")
        from . import engines as free_engines
        local = opt.voice in free_engines.CATALOG
        if opt.voice == "clone" or local:
            ref, ref_text, ref_span = dub.reference(segs, vocals, w)
            who = f"{free_engines.CATALOG[opt.voice].name} on this computer (free)" if local else "Higgs"
            self.log(f"Cloning with {who} from {ref_span[0]:.1f}–{ref_span[1]:.1f}s: “{ref_text[:80]}…”")
        else:
            ref, ref_text, ref_span = None, "", None
            self.log(f"Speaking with the Higgs preset voice “{opt.voice}”")
        spk = dub.Speaker(ref=ref, ref_text=ref_text,
                          voice=None if opt.voice == "clone" or opt.voice in _engines.CATALOG else opt.voice,
                          normalize=opt.normalize, engine=opt.voice if opt.voice in _engines.CATALOG else "higgs")
        dub.synthesise(lines, w, lang, spk, qa=opt.qa, log=self.log,
                       progress=self.progress)
        self.end("voice")

        self._finish(video, opt, info, segs, lines, meta, vocals, background, ref, ref_text, ref_span)

    def _finish(self, video, opt, info, segs, lines, meta, vocals, background, ref, ref_text,
                ref_span) -> None:
        """Place, mix, subtitle, render — shared by the first dub and every re-dub."""
        w = self.work
        lang = config.LANGUAGES[opt.target]
        total = info["duration"]

        self.begin("mix")
        for l in lines:
            l.notes = [n for n in l.notes if not n.startswith("overruns")]
        dub.place(lines, total, w)
        mix = dub.mix(lines, vocals, background, total, w / "dub_mix.wav", mode=opt.mode)
        fast = [l for l in lines if l.tempo > 1.01]
        self.log(f"Placed {len(lines)} lines; {len(fast)} sped up (max {max([l.tempo for l in lines] + [1]):.2f}×)")
        self.end("mix")

        self.begin("render")
        lay = subtitles.layout(info["width"], info["height"], lang)
        src = meta.get("language") or "und"
        src_lang = config.language_for(src)
        tgt_cues = subtitles.cues_for([(l.start, l.end, l.text) for l in lines], lang, lay["per_line"])
        src_cues = subtitles.cues_for([(s.start, s.end, s.text) for s in segs], src_lang,
                                     20 if src_lang.cjk else 42)
        subtitles.write_srt(tgt_cues, w / f"subtitles.{opt.target}.srt")
        subtitles.write_vtt(tgt_cues, w / f"subtitles.{opt.target}.vtt")
        subtitles.write_srt(src_cues, w / f"subtitles.{src}.srt")
        subtitles.write_vtt(src_cues, w / f"subtitles.{src}.vtt")
        ass = None
        if opt.burn_subtitles:
            if media.has_libass():
                ass = subtitles.write_ass(tgt_cues, w / "subtitles.ass", info["width"], info["height"], lay)
            else:
                self.log("This ffmpeg has no libass; subtitles are delivered as files only")
        # Render beside the old file and swap, so a player never reads half a video.
        media.render(video, mix, w / "dubbed.tmp.mp4", ass=ass, progress=self.progress, duration=total)
        (w / "dubbed.tmp.mp4").replace(w / "dubbed.mp4")
        self.end("render")

        self.state.result = {
            "duration": total, "width": info["width"], "height": info["height"],
            "target": opt.target, "target_name": lang.name, "target_endonym": lang.endonym,
            "source": src, "source_name": src_lang.name, "source_endonym": src_lang.endonym,
            "transcript_source": meta["source"],
            "vad": [[round(s, 2), round(e, 2)] for s, e in meta["vad"]],
            "removed": meta["removed"],
            "reference": None if ref_span is None else
                {"start": round(ref_span[0], 2), "end": round(ref_span[1], 2), "text": ref_text},
            "voice": opt.voice,
            "version": int(time.time()),
            "lines": [{
                "id": i, "src_start": round(l.seg.start, 2), "src_end": round(l.seg.end, 2),
                "start": round(l.start, 2), "end": round(l.end, 2), "slot": round(l.slot, 2),
                "source": l.seg.text, "text": l.text, "tone": l.tone, "manual": l.manual,
                "tempo": round(l.tempo, 2),
                "similarity": None if l.similarity is None else round(l.similarity, 2),
                "shortened": l.shortened, "attempts": l.attempts, "notes": l.notes,
                "take": l.take.name if l.take else None,
            } for i, l in enumerate(lines)],
            "files": {
                "video": "dubbed.mp4", "audio": "dub_mix.wav",
                "subtitles": f"subtitles.{opt.target}.srt",
                "subtitles_vtt": f"subtitles.{opt.target}.vtt",
                "source_subtitles": f"subtitles.{src}.srt",
                "source_subtitles_vtt": f"subtitles.{src}.vtt",
                **({"reference": "ref_voice.wav"} if ref is not None else {}),
            },
            "_internal": {"vocals": str(vocals), "background": str(background),
                          "ref": str(ref) if ref else None, "video": str(video), "info": info},
        }
        (w / "transcript.json").write_text(json.dumps(self.state.result, ensure_ascii=False, indent=1))

    def redub(self, edits: dict[int, str], tones: dict[int, dict] | None = None,
              timings: dict[int, list[float] | None] | None = None) -> None:
        """Re-speak the edited lines only, then re-place, re-mix and re-render.

        `timings` are blocks a person dragged: [start, end], or None to snap a
        block back onto its original. They need no new speech, only a re-mix.
        """
        st = self.state
        st.status, st.error = "running", None
        try:
            res = st.result or json.loads((self.work / "transcript.json").read_text())
            opt = Options(**st.options)
            lang = config.LANGUAGES[opt.target]
            it = res["_internal"]
            segs, lines = [], []
            for d in res["lines"]:
                seg = asr.Segment(d["id"], d["src_start"], d["src_end"], d["source"])
                segs.append(seg)
                line = dub.Line(seg=seg, slot=d["slot"], text=d["text"], tone=d.get("tone"),
                                manual=d.get("manual"),
                                take=self.work / d["take"], similarity=d["similarity"],
                                shortened=d["shortened"], attempts=d["attempts"],
                                notes=list(d["notes"]))
                line.raw = line.take
                lines.append(line)
            changed = set()
            for i, text in edits.items():
                text = translate.to_script(text.strip(), lang)
                if 0 <= i < len(lines) and text and text != lines[i].text:
                    lines[i].text, lines[i].notes, lines[i].shortened = text, ["edited by hand"], False
                    changed.add(i)
            for i, t in (tones or {}).items():
                if 0 <= i < len(lines) and t != lines[i].tone:
                    lines[i].tone = t
                    if i not in changed:
                        lines[i].notes = ["tone changed by hand"]
                    changed.add(i)
            moved = set()
            for i, span in (timings or {}).items():
                if 0 <= i < len(lines):
                    span = [round(float(span[0]), 3), round(float(span[1]), 3)] if span else None
                    if span != lines[i].manual:
                        lines[i].manual = span
                        moved.add(i)
            if not changed and not moved:
                st.status = "done"
                self.save()
                return
            if moved:
                self.log(f"Re-timing {len(moved)} dragged line(s)")
            for k in ("voice", "mix", "render"):
                st.stages.pop(k, None)
            if not changed:
                meta = {"source": res["transcript_source"], "vad": res["vad"], "removed": res["removed"],
                        "language": res["source"]}
                r0 = res.get("reference")
                ref = Path(it["ref"]) if it.get("ref") else None  # also OmniVoice's reference
                self._finish(Path(it["video"]), opt, it["info"], segs, lines, meta,
                             Path(it["vocals"]), Path(it["background"]), ref,
                             (r0 or {}).get("text", ""), (r0["start"], r0["end"]) if r0 else None)
                st.status, st.stage = "done", ""
                self.log("Re-timed.")
                self.save()
                return
            self.log(f"Re-dubbing {len(changed)} edited line(s)")
            self.begin("voice")
            # A person chose these words: time-stretch if needed, never re-say them.
            ref = Path(it["ref"]) if it.get("ref") else None  # also OmniVoice's reference
            ref_text = (res.get("reference") or {}).get("text", "")
            spk = dub.Speaker(ref=ref, ref_text=ref_text,
                              voice=None if opt.voice == "clone" or opt.voice in _engines.CATALOG else opt.voice,
                          normalize=opt.normalize, engine=opt.voice if opt.voice in _engines.CATALOG else "higgs")
            dub.synthesise(lines, self.work, lang, spk,
                           qa=opt.qa, only=changed, allow_resize=False, log=self.log,
                           progress=self.progress)
            self.end("voice")
            meta = {"source": res["transcript_source"], "vad": res["vad"], "removed": res["removed"],
                    "language": res["source"]}
            r0 = res.get("reference")
            ref_span = (r0["start"], r0["end"]) if r0 else None
            self._finish(Path(it["video"]), opt, it["info"], segs, lines, meta,
                         Path(it["vocals"]), Path(it["background"]), ref, ref_text, ref_span)
            st.status, st.stage = "done", ""
            self.log("Re-dub done.")
        except Exception as e:
            st.status, st.error = "error", str(e)
            self.log(f"Re-dub failed: {e}")
            traceback.print_exc()
        self.save()


def main() -> None:
    ap = argparse.ArgumentParser(description="Dub a video with Higgs Audio.")
    ap.add_argument("video", type=Path)
    ap.add_argument("--to", default=config.DEFAULT_TARGET, choices=sorted(config.LANGUAGES))
    ap.add_argument("--from", dest="source", default="auto", help="language code, or auto")
    ap.add_argument("--mode", default="replace", choices=["replace", "voiceover"])
    ap.add_argument("--no-burn", action="store_true")
    ap.add_argument("--no-qa", action="store_true")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    job_id = time.strftime("cli-%Y%m%d-%H%M%S")
    work = config.WORK_DIR / job_id
    work.mkdir(parents=True, exist_ok=True)
    src = work / f"source{a.video.suffix.lower()}"
    shutil.copy(a.video, src)
    opts = Options(target=a.to, source=a.source, mode=a.mode,
                   burn_subtitles=not a.no_burn, qa=not a.no_qa)
    job = Job(work, State(id=job_id, filename=a.video.name, options=asdict(opts)))
    job.run(src)
    if job.state.status != "done":
        raise SystemExit(1)
    out = work / "dubbed.mp4"
    if a.out:
        shutil.copy(out, a.out)
        out = a.out
    print(f"\n{out}")


if __name__ == "__main__":
    main()
