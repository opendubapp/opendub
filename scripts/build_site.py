"""Build the public site: the web app plus one finished demo dub, as static files.

    .venv/bin/python scripts/build_site.py work/<demo-job-dir>

Writes dist/. With no backend to answer /api/config, app.js falls back to
demo/config.json and shows the demo job read-only (see STATIC in app.js).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from opendub import config, tone  # noqa: E402
from opendub.pipeline import STAGES  # noqa: E402

DIST = ROOT / "dist"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    job_dir = Path(sys.argv[1]).resolve()
    state = json.loads((job_dir / "job.json").read_text())
    if state.get("status") != "done" or not state.get("result"):
        raise SystemExit(f"{job_dir} is not a finished dub")

    if DIST.exists():
        shutil.rmtree(DIST)
    # Not web/models: that is 437 MB of weights for the installers to carry,
    # and the public site deliberately does not serve them. A visitor has
    # installed nothing, and this box cannot hand a gigabyte to each of them.
    shutil.copytree(ROOT / "web", DIST, ignore=shutil.ignore_patterns("models"))
    index = DIST / "index.html"
    index.write_text(index.read_text().replace(
        "<head>", '<head>\n<meta name="opendub-static" content="demo" />', 1))
    demo = DIST / "demo"
    demo.mkdir()

    # The job as the API would serve it: no server-side paths, plus the source name.
    res = {k: v for k, v in state["result"].items() if not k.startswith("_")}
    source = next(job_dir.glob("source.*"))
    state.update(result=res, source_file=source.name, queue_position=None,
                 filename="opendub-demo-en.mp4")
    (demo / "job.json").write_text(json.dumps(state, ensure_ascii=False))

    shutil.copy(source, demo / source.name)
    for name in res["files"].values():
        if (job_dir / name).exists():
            shutil.copy(job_dir / name, demo / name)
    # The WAV of the mix is large and nobody needs it from a demo page.
    res["files"].pop("audio", None)
    (demo / "dub_mix.wav").unlink(missing_ok=True)
    (demo / "job.json").write_text(json.dumps(state, ensure_ascii=False))

    (demo / "config.json").write_text(json.dumps({
        "languages": [{"code": l.code, "name": l.name, "endonym": l.endonym}
                      for l in config.LANGUAGES.values()],
        "default_target": config.DEFAULT_TARGET,
        "stages": [{"key": k, "label": v} for k, v in STAGES],
        "has_key": False,
        "emotions": tone.EMOTIONS,
        "voices": [{"id": k, "label": v} for k, v in tone.PRESET_VOICES.items()],
        "models": {"stt": config.STT_MODEL, "tts": config.TTS_MODEL, "llm": config.LLM_MODEL},
    }, ensure_ascii=False))

    subprocess.run(["node", str(ROOT / "scripts" / "make_assets.mjs"), str(DIST)], check=True)
    size = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"dist/ ready: {sum(1 for _ in DIST.rglob('*') if _.is_file())} files, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
