"""ffmpeg and demucs, and the few audio operations we do in numpy."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100  # the mix and the render run at this rate


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({p.returncode}): {p.stderr[-1200:]}")
    return p


def probe(path: Path) -> dict:
    p = run(["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(path)])
    info = json.loads(p.stdout)
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if audio is None:
        raise RuntimeError("this video has no audio track to dub")
    w, h = (int(video["width"]), int(video["height"])) if video else (1280, 720)
    # A phone video recorded sideways carries a rotation, not rotated pixels.
    rot = 0
    for sd in (video or {}).get("side_data_list", []):
        if "rotation" in sd:
            rot = abs(int(sd["rotation"]))
    if rot in (90, 270):
        w, h = h, w
    return {"duration": float(info["format"]["duration"]), "width": w, "height": h,
            "has_video": video is not None}


def extract_audio(video: Path, out: Path, *, sr: int = SR, channels: int = 2) -> Path:
    run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vn", "-map", "0:a:0",
         "-ac", str(channels), "-ar", str(sr), "-c:a", "pcm_s16le", str(out)])
    return out


def resample(src: Path, out: Path, *, sr: int, channels: int = 1,
             start: float | None = None, dur: float | None = None) -> Path:
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(src)]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-ac", str(channels), "-ar", str(sr), "-c:a", "pcm_s16le", str(out)]
    run(cmd)
    return out


def separate(audio: Path, out_dir: Path) -> tuple[Path, Path]:
    """Split speech from music and effects with Demucs (htdemucs, two stems).

    Returns (vocals, background). The background is what lets the dub keep the
    original music under the new voice rather than ducking the old voice.
    """
    import torch  # imported late: 2 s of startup nobody needs for --help

    device = "mps" if torch.backends.mps.is_available() else (
        "cuda" if torch.cuda.is_available() else "cpu")
    run([sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs",
         "-d", device, "-o", str(out_dir), str(audio)])
    stem = out_dir / "htdemucs" / audio.stem
    return stem / "vocals.wav", stem / "no_vocals.wav"


def load(path: Path, *, sr: int = SR, mono: bool = True) -> np.ndarray:
    """Decode anything ffmpeg reads to float32 at `sr`."""
    ch = 1 if mono else 2
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le",
                        "-ac", str(ch), "-ar", str(sr), "-"],
                       capture_output=True, check=True)
    a = np.frombuffer(p.stdout, dtype=np.float32).copy()
    return a if mono else a.reshape(-1, 2)


def save(path: Path, audio: np.ndarray, sr: int = SR) -> Path:
    sf.write(str(path), np.clip(audio, -1, 1), sr, subtype="PCM_16")
    return path


def trim_silence(a: np.ndarray, sr: int = SR, *, floor_db: float = -42,
                 pad: float = 0.04) -> np.ndarray:
    """Cut TTS lead-in and tail so a clip's length is its speech, not its padding."""
    if a.size == 0:
        return a
    win = int(sr * 0.01)
    n = a.size // win
    if n == 0:
        return a
    rms = np.sqrt(np.mean(a[: n * win].reshape(n, win) ** 2, axis=1) + 1e-12)
    loud = np.where(20 * np.log10(rms / (rms.max() + 1e-12)) > floor_db)[0]
    if loud.size == 0:
        return a
    s = max(0, loud[0] * win - int(pad * sr))
    e = min(a.size, (loud[-1] + 1) * win + int(pad * sr))
    return a[s:e]


def stretch(src: Path, out: Path, tempo: float) -> Path:
    """Speed speech up without the chipmunk: rubberband if ffmpeg has it, else atempo."""
    if abs(tempo - 1.0) < 0.01:
        shutil.copy(src, out)
        return out
    if _has_filter("rubberband"):
        af = f"rubberband=tempo={tempo:.4f}:pitchq=quality:window=short"
    else:
        af = f"atempo={tempo:.4f}"
    run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", af, str(out)])
    return out


_FILTERS: set[str] | None = None


def _has_filter(name: str) -> bool:
    global _FILTERS
    if _FILTERS is None:
        p = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True)
        _FILTERS = {ln.split()[1] for ln in p.stdout.splitlines()
                    if len(ln.split()) > 2 and ln.startswith(" ")}
    return name in _FILTERS


def has_libass() -> bool:
    return _has_filter("ass")


def render(video: Path, audio: Path, out: Path, *, ass: Path | None,
           fonts_dir: Path | None = None, progress=None, duration: float = 0) -> Path:
    """Mux the dubbed mix under the original picture, burning subtitles if given.

    Re-encodes to H.264 either way: sources arrive as AV1/VP9 more and more,
    and a demo that will not play in Safari is not a demo.
    """
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(video), "-i", str(audio)]
    if ass is not None:
        esc = str(ass).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
        vf = f"ass='{esc}'"
        if fonts_dir:
            fd = str(fonts_dir).replace(":", "\\:")
            vf = f"ass='{esc}':fontsdir='{fd}':shaping=complex"
        cmd += ["-filter_complex", f"[0:v]{vf}[v]", "-map", "[v]"]
    else:
        cmd += ["-map", "0:v:0"]
    cmd += ["-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", "-shortest",
            "-progress", "pipe:1", "-nostats", str(out)]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert p.stdout is not None
    for line in p.stdout:
        if progress and line.startswith("out_time_us=") and duration > 0:
            try:
                progress(max(0.0, min(1.0, int(line.split("=")[1]) / 1e6 / duration)))
            except ValueError:
                pass
    err = p.stderr.read() if p.stderr else ""
    if p.wait() != 0:
        raise RuntimeError(f"ffmpeg render failed: {err[-1200:]}")
    return out
