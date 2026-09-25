# Free voice engines

Each engine lives in its own folder with its own Python environment, because
they pin conflicting versions of torch and transformers. The app talks to each
one through `worker_base.py`'s line-delimited JSON protocol, and offers an
engine only after its `setup.sh` has made it speak (`.ready`).

| Engine | Licence | Commercial use | Hardware | Status |
|---|---|---|---|---|
| OmniVoice | code Apache-2.0, weights CC-BY-NC | no | CPU / Apple GPU | runs in the app itself (`pip install omnivoice`) |
| Chatterbox Multilingual | MIT | yes (clips are watermarked) | Apple GPU, NVIDIA or CPU | `chatterbox/setup.sh` |
| CosyVoice 2 | Apache-2.0 | yes | NVIDIA recommended, CPU slow | `cosyvoice/setup.sh` (needs `repo/` fetched first) |
| VoxCPM2 | Apache-2.0 | yes | NVIDIA 8 GB+ only | `voxcpm/setup.sh` — untested, refuses without `nvidia-smi` |
| IndexTTS-2 | to be confirmed | not until confirmed | NVIDIA recommended | `indextts/setup.sh` — deferred for disk space, untested |

Only OmniVoice sets each line's exact length; the others are fitted to the
speaker's span afterwards (resize the translation, then a gentle stretch).

`smoke.sh <engine>` sends one Chinese line through the worker and marks the
engine ready if a clip comes back.
