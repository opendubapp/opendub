// Whisper in the tab (transformers.js), for timing and for the free route's
// words. Segment timestamps only: the ONNX exports have no cross-attentions,
// so word times are spread by character share (opensubs does the same).
import { env, pipeline } from "@huggingface/transformers";
import { collapseLoops } from "./core.js";

// ONNX Runtime's wasm is served from our own origin, beside this bundle.
env.backends.onnx.wasm.wasmPaths = new URL("/browser/ort/", location.href).href;
env.allowLocalModels = false;

let cache = null;

export async function gpu() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

export async function transcribe(mono16k, { language, onProgress } = {}) {
  const webgpu = await gpu();
  if (!cache) {
    const files = new Map();
    // small, not base. Base loses whole passages of Mandarin: on jerry's video
    // it returned nothing at all for the first eight seconds and looped for
    // the last seventeen, and the dub was of what it invented. small hears the
    // same file from 0.00 and gets the opening sentence right.
    //
    // q8 on both backends. "q8 fails on the WASM backend" was true when
    // opensubs found it and is not true of this runtime — measured here on
    // both models, same output as fp32 — and it is what makes small
    // affordable: 237 MB against the 277 MB base cost in fp32. The cost is
    // time, 72 s against 21 s for a 41 s video on the processor, which is
    // small beside the minutes the free voice takes.
    cache = pipeline("automatic-speech-recognition", "onnx-community/whisper-small", {
      device: webgpu ? "webgpu" : "wasm",
      dtype: "q8",
      progress_callback: (p) => {
        if (p.status === "progress" && p.total) {
          files.set(p.file, [p.loaded, p.total]);
          const [l, t] = [...files.values()].reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0]);
          onProgress?.(l / t, "Downloading Whisper (once)");
        }
      },
    });
  }
  const asr = await cache;
  onProgress?.(0, "Listening");
  const out = await asr(mono16k, {
    return_timestamps: true, chunk_length_s: 30, stride_length_s: 5,
    // Whisper falls into repeating itself, and base does it readily: on a
    // Mandarin video it returned 更多的推出 fifty times over and filled the
    // last seventeen seconds with 共同 — 999 characters, 79 seconds of
    // generation. A mild penalty is the standard remedy and it is a large
    // one here: 18 segments, 171 characters, 19 seconds, measured on that
    // same file. Higher, or no_repeat_ngram_size, starts bending real words
    // (从每一层 became 从每一层的美丽的美丹).
    repetition_penalty: 1.15,
    ...(language ? { language, task: "transcribe" } : {}),
  });
  const dur = mono16k.length / 16000;
  // Collapsed here, not only in clean(): a loop left in place is spread into
  // one phantom word per character, and those characters decide where the
  // lines fall before clean() ever sees them.
  return (out.chunks || []).map((c) => ({ text: collapseLoops(c.text), start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? dur }))
    .filter((c) => c.text);
}
