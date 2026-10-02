#!/usr/bin/env python3
"""Does this payload actually carry everything the program calls?

    python3 installer/check_payload.py <payload-dir> macos|windows

An installer that promises no first run has one way to break its promise:
something the program reaches for at runtime was never put inside it. That
failure is invisible on the machine that built it, because the developer's own
Homebrew ffmpeg, or a package in some other environment, quietly stands in.
It is only visible to the person who downloaded it, as a dub that stops on the
first step.

So the build asks the payload the question instead of assuming the answer. On
macOS the payload is native and every check is executed for real. A Windows
payload is cross-built here and cannot be run, so its binaries and packages
are checked by presence; the capability checks are the macOS build's job.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# Every module opendub imports that does not come with Python. Grown from the
# imports themselves rather than from the requirements files: a requirement can
# be present and still be the wrong one, and a module can be imported that
# nobody remembered to require.
MODULES = [
    "fastapi", "uvicorn", "multipart", "numpy", "soundfile", "httpx",
    "torch", "faster_whisper", "demucs", "zhconv", "jieba", "omnivoice",
]

# What ffmpeg is actually asked to do. A build missing any of these produces a
# dub that runs for minutes and fails at the end.
ENCODERS = ["libx264", "aac", "pcm_s16le"]
FILTERS = ["subtitles", "atempo"]      # subtitles is libass; rubberband is optional

fails: list[str] = []
notes: list[str] = []


def need(ok: bool, what: str) -> None:
    (notes if ok else fails).append(what)


def main() -> int:
    payload = Path(sys.argv[1]).resolve()
    target = sys.argv[2]
    windows = target == "windows"
    exe = ".exe" if windows else ""

    for tool in ("ffmpeg", "ffprobe"):
        need((payload / "ffmpeg" / f"{tool}{exe}").exists(), f"{tool}{exe}")

    python = payload / "python" / ("python.exe" if windows else "bin/python3")
    need(python.exists(), "a Python to run it")

    site = payload / "site-packages"
    need((payload / "app" / "opendub" / "server.py").exists(), "the program")
    need((payload / "app" / "web" / "browser").is_dir(), "the in-page pipeline")

    # The weights, by name and by size. A truncated download leaves a file that
    # exists and loads as nothing, so the two large ones are measured.
    models = payload / "app" / "web" / "models"
    need((models / "manifest.json").exists(), "the model manifest")
    whisper = models / "hf" / "onnx-community" / "whisper-small"
    for rel, least in (("onnx/encoder_model_quantized.onnx", 80_000_000),
                       ("onnx/decoder_model_merged_quantized.onnx", 140_000_000),
                       ("tokenizer.json", 1_000_000),
                       ("config.json", 100),
                       ("preprocessor_config.json", 100)):
        f = whisper / rel
        need(f.exists() and f.stat().st_size >= least, f"whisper {rel}")
    sep = models / "htdemucs_embedded.onnx"
    need(sep.exists() and sep.stat().st_size >= 160_000_000, "the voice separator")

    if windows:
        # Cannot be executed from here. A wheel unpacks either to a directory
        # or to a single module file, and a few land under a different name
        # than the import — check both shapes.
        for m in MODULES:
            hit = (site / m).is_dir() or (site / f"{m}.py").exists() \
                or any(site.glob(f"{m}-*.dist-info")) or any(site.glob(f"{m.replace('_', '-')}-*.dist-info"))
            need(hit, m)
    else:
        if python.exists():
            for m in MODULES:
                r = subprocess.run([str(python), "-c", f"import {m}"],
                                   env={"PYTHONPATH": str(site), "PATH": "/usr/bin:/bin"},
                                   capture_output=True, text=True)
                need(r.returncode == 0, m)
        ff = payload / "ffmpeg" / "ffmpeg"
        if ff.exists():
            enc = subprocess.run([str(ff), "-hide_banner", "-encoders"],
                                 capture_output=True, text=True).stdout
            for e in ENCODERS:
                need(any(line.split()[1:2] == [e] for line in enc.splitlines()), f"ffmpeg -c {e}")
            flt = subprocess.run([str(ff), "-hide_banner", "-filters"],
                                 capture_output=True, text=True).stdout
            for f in FILTERS:
                need(any(line.split()[1:2] == [f] for line in flt.splitlines()), f"ffmpeg -vf {f}")
        fp = payload / "ffmpeg" / "ffprobe"
        if fp.exists():
            need(subprocess.run([str(fp), "-version"], capture_output=True).returncode == 0,
                 "ffprobe runs")

    print(f"  {len(notes)} present: {', '.join(notes)}")
    if fails:
        print(f"\n  MISSING ({len(fails)}): {', '.join(fails)}")
        print("  This payload would fail on someone else's machine.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
