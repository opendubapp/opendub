# OpenDub

**Your video, in any language, in your own voice.**

Upload a video and get it back dubbed into another language. The dub uses a
clone of the speaker's own voice, each line is timed to their lips and said in
the tone they used, and subtitles in the new language are burned in.

- **Open source.** Every step is plain Python and JavaScript you can read, run
  and replace. AGPL-3.0.
- **Local-first.** Voice separation, speech detection, word timing, mixing and
  rendering run on your machine, and the video file never leaves it. With a
  free voice engine on your computer, nothing leaves it at all.
- **Powerful.** It clones the voice, reads the tone of each line, times every
  line to the speaker, and lets you edit, re-tone or drag any line and re-dub
  it in about 10 seconds.

The demo dubs English into Simplified Chinese. The spoken language is detected
automatically, and there are 17 languages to dub into.

## Three ways to run it

| | Where it runs | Voice | What you need |
|---|---|---|---|
| **The app on your computer** | your machine | a free engine on your machine, or Higgs Audio | Python and ffmpeg |
| **opendub.app in your browser** | your browser tab | your own Higgs Audio or ElevenLabs key, or the app on your computer | a browser with WebCodecs |
| **Headless** | your machine | either | Python and ffmpeg |

The video file itself never leaves your device in any of them.

## Quick start

```bash
git clone https://github.com/opendubapp/opendub && cd opendub
echo "BOSON_API_KEY=bai-your-key" > .env     # from boson.ai; not needed for a free engine
./run.sh                                     # http://127.0.0.1:8910
```

`run.sh` creates a virtualenv and installs `requirements.txt` on first run.

Requirements:
- Python 3.12
- ffmpeg with **libass** (to burn in subtitles) and **rubberband** (for
  time-stretching). Homebrew's `ffmpeg` has both.

The first run downloads the Demucs model (about 80 MB) and Whisper `small`
(about 480 MB).

Headless:

```bash
.venv/bin/python -m opendub.pipeline video.mp4 --to zh-Hans           # source auto-detected
.venv/bin/python -m opendub.pipeline video.mp4 --from en --to ja --mode voiceover
```

## What the app does

| Screen | Functions |
|---|---|
| **New dub** | Drop a video. Choose *Spoken in* (auto-detect or a language) and *Dub into* (17 languages). Choose *Replace the voice* (music kept, speech swapped) or *Voice-over* (original faintly underneath), and whether to burn in subtitles. |
| **Other settings** | Voice: clone the speaker, or a Higgs preset (Chloe, Eleanor, Jake, Marcus, Nora, Oliver). Tone: match the speaker line by line, or one of 20 emotions throughout. Expressiveness, pitch, delivery (whisper or shout). Whether numbers are read as words. Whether every line is checked by ear. |
| **Progress** | Seven stages with timings and a plain-language log. |
| **Result** | Original and dub side by side, with *Play side by side* and *Stop both*. A timeline of speech regions, original sentences and dubbed lines. Summary numbers. |
| **Lines** | Every line with its source text, editable translation, tone picker and quality chips (how well it was heard back, stretch, re-said, placed by hand). |
| **Timeline editing** | Drag a dubbed block to move it, drag its edges to resize it, double-click to snap it back. Then *Apply changes*: only the touched lines are re-spoken, and a moved block is only re-timed. |
| **Files** | Dubbed MP4 (H.264), dub audio WAV, SRT subtitles in both languages, and the clip the voice was cloned from. |

## Pipeline

| Step | Runs | What happens |
|---|---|---|
| 1. Separate | local | **Demucs** (htdemucs, Apple GPU) splits the voice from the music and effects. The music survives the dub, and every later step hears a clean voice. |
| 2. Find speech | local | **Silero VAD** marks the spoken regions, and those regions decide how audio is chunked for transcription. |
| 3. Transcribe | Higgs + local | **higgs-stt-3.1** writes the words. **faster-whisper** supplies only the word timing, aligned onto the Higgs words with a sequence diff. |
| 4. Translate | Higgs | **higgs-realtime** translates whole sentences, exactly one line out per line in (checked by count). Each line gets a character budget sized to how long the speaker took. |
| 5. Tone | Higgs + local | Each line's loudness and pace, measured against the speaker's average, go with its words to **higgs-realtime** acting as a voice director. It picks a Higgs emotion tag, an expressiveness level, and whisper or shout. |
| 6. Speak | Higgs | **higgs-tts-3** clones the voice from the densest 6–12 s of whole sentences, with their transcript as `ref_text`. Tags lead each line. |
| 7. Check and fit | Higgs + local | Each clip is transcribed back, and regenerated if it matches less than 72%. A line more than 15% off the speaker's length is re-said (up to 3 times), then re-paced with a Higgs `speed` tag. The rest is stretched 0.75–1.3× with rubberband, so every line starts and ends with the speaker. |
| 8. Mix and render | local | New voice over the music stem, loudness matched to the original. Subtitles are timed to the dubbed voice and burned in with libass. |

Several rules come from our [OpenSubs](https://opensubs.app) project:
- one translation per line, with a count check
- cleanup of ASR hallucinations ("thanks for watching", `[music]`)
- merging very short cues into their neighbours
- splitting subtitle time by character count
- 20 characters per line for CJK

Chinese lines break at word boundaries (jieba), and Chinese output is forced
into the requested script (zhconv).

## Voices

Higgs Audio speaks every line by default. Free engines run on your own machine
instead, and each lives in its own environment under `engines/` because they
pin conflicting versions of torch; the app drives them as worker processes and
offers one only after its setup script has made it speak.

| Engine | Licence | Commercial use | Hardware | Sets a line's length |
|---|---|---|---|---|
| **Higgs Audio** (Boson AI) | API, your own key | per Boson's terms | none — an API | no, fitted afterwards |
| **ElevenLabs** | API, your own key | per ElevenLabs' terms | none — an API | no |
| **OmniVoice** (k2-fsa) | code Apache-2.0, weights CC-BY-NC | no | CPU or Apple GPU | **yes** |
| **Chatterbox Multilingual** (Resemble AI) | MIT | yes, clips are watermarked | Apple GPU, NVIDIA or CPU | no |
| **CosyVoice 2** (Alibaba) | Apache-2.0 | yes | NVIDIA recommended | no |
| **VoxCPM2** (OpenBMB) | Apache-2.0 | yes | NVIDIA 8 GB+ | no |
| **IndexTTS-2** (Bilibili) | to be confirmed | not until confirmed | NVIDIA recommended | not wired |

```bash
.venv/bin/pip install omnivoice        # OmniVoice runs inside the app
engines/chatterbox/setup.sh            # the others each build their own environment
```

Only OmniVoice generates a line at an exact length; the rest are fitted to the
speaker's span the same way Higgs lines are. `engines/README.md` has the
details, and the last two are written but untested by us.

## Performance

Measured on an M1 Max for the 74-second demo video:

- Separation: about 7–17 s
- Recognition: about 10 s
- A full dub: about 4 minutes, with a key limited to about 1 request per second
- Re-dubbing an edited line: about 10 s

A dub makes about 70 Higgs calls. The client paces them to the key's rate
limit, so a busy key slows a job down rather than failing it. To match a
higher limit, set `OPENDUB_RPS` in `.env`.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `BOSON_API_KEY` | — | required |
| `BOSON_BASE_URL` | `https://api.boson.ai/v1` | |
| `OPENDUB_RPS` | `0.95` | Higgs requests per second |
| `OPENDUB_STT_MODEL` / `_TTS_MODEL` / `_LLM_MODEL` | `higgs-stt-3.1` / `higgs-tts-3` / `higgs-realtime` | |
| `OPENDUB_WHISPER_MODEL` | `small` | local timing model |
| `OPENDUB_WORK_DIR` | `./work` | jobs and outputs |

## Layout

```
opendub/
  pipeline.py   stages, job state, re-dub, CLI
  server.py     FastAPI: upload, status, files, re-dub
  boson.py      Higgs client: STT, chat, TTS, pacing and retries
  asr.py        VAD, Whisper timing, Higgs alignment, segmentation, cleanup
  translate.py  length-budgeted translation, re-saying lines to fit
  tone.py       tone reading, Higgs tags, preset voices
  dub.py        reference clip, speak, check, fit, place, mix
  subtitles.py  cues, CJK wrapping, SRT, VTT, ASS
  media.py      ffmpeg, Demucs, stretching, rendering
  engines.py    free engines on this computer, driven as worker processes
  omni.py       OmniVoice, in this app's own process
engines/        one folder per free engine: worker.py, setup.sh, its own venv
browser/        the in-browser dub (Vite): mediabunny, jassub, transformers.js
web/            the page (index.html, app.js, styles.css, design tokens)
scripts/        build and deploy opendub.app
tests/          Playwright: e2e.mjs, card.mjs, site.mjs, account.mjs, browser-dub.mjs
```

## Tests

```bash
PLAYWRIGHT_FROM=/path/to/node_modules/ node tests/e2e.mjs video.mp4   # a real dub, end to end
PLAYWRIGHT_FROM=/path/to/node_modules/ node tests/card.mjs            # the dub card and the file row
```

The test runs a real dub in a real browser. It asserts that every line starts
and ends within 20 ms of the speaker. It then edits a line, changes a tone,
drags a block and re-dubs, and checks the page has no horizontal scroll at
390 px.

## Credits

Speech, translation and voice by **Higgs Audio** (Boson AI), with free
alternatives listed under *Voices*. Voice separation
by [Demucs](https://github.com/facebookresearch/demucs), speech detection by
[Silero VAD](https://github.com/snakers4/silero-vad), and word timing by
[faster-whisper](https://github.com/SYSTRAN/faster-whisper). Rendering uses
ffmpeg with libass and rubberband.

Only clone voices you have the rights to use.

## Licence

AGPL-3.0. See `LICENSE`.
