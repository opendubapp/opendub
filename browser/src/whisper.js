// Whisper in the tab (transformers.js), for timing and for the free route's
// words. Segment timestamps only: the ONNX exports have no cross-attentions,
// so word times are spread by character share (opensubs does the same).
import { env, pipeline } from "@huggingface/transformers";
import { collapseLoops } from "./core.js";
import { mirror } from "./models.js";

// ONNX Runtime's wasm is served from our own origin, beside this bundle.
env.backends.onnx.wasm.wasmPaths = new URL("/browser/ort/", location.href).href;
env.allowLocalModels = false;

let cache = null;
let cachedOn = null;
let cachedFrom = null;

export async function gpu() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

// The decoder is a 150 MB buffer. WebGPU only promises 128 MB for one binding
// and 256 MB for one buffer, and plenty of adapters report exactly that; this
// machine reports 4096 MB, which is why choosing the larger model here looked
// safe and was not. On an adapter with the standard limits the run spent
// twenty-three minutes and then died inside the runtime's buffer manager —
// "Mapping WebGPU buffer failed: Invalid buffer". So ask the adapter first,
// and where it cannot hold the model use the processor, which is slower and
// right, rather than the smaller model, which is quicker and invents words.
const NEEDS_BINDING = 200 * 1024 * 1024;
const NEEDS_BUFFER = 300 * 1024 * 1024;

async function gpuCanHoldIt() {
  try {
    const a = navigator.gpu && (await navigator.gpu.requestAdapter());
    if (!a) return false;
    return a.limits.maxStorageBufferBindingSize >= NEEDS_BINDING && a.limits.maxBufferSize >= NEEDS_BUFFER;
  } catch { return false; }
}

export async function transcribe(mono16k, { language, onProgress } = {}) {
  const webgpu = await gpuCanHoldIt();
  try {
    return await listen(mono16k, webgpu, language, onProgress);
  } catch (e) {
    if (!webgpu) throw e;
    // The adapter said it had room and the runtime still could not use it.
    // Losing the dub over that is worse than being slow.
    cache = null; cachedOn = null;
    onProgress?.(0, "The GPU could not run the model; using the processor instead");
    return await listen(mono16k, false, language, onProgress);
  }
}

/**
 * Load the model, from this computer where the installer carried it.
 * Separate from listen() so the app can do it on start: it is the one minute
 * of a first dub that has nothing to do with the video.
 */
export async function load(webgpu, onProgress) {
  if (!cache || cachedOn !== webgpu) {
    cachedOn = webgpu;
    // The installer carries these; when it does, they come from the app on
    // this computer and nothing is downloaded. Everywhere else this is null
    // and the CDN defaults stand. Set before the pipeline is created, since
    // that is when the files are asked for.
    const local = await mirror();
    if (local) {
      env.remoteHost = `${local}hf/`;
      env.remotePathTemplate = "{model}/";
    }
    const files = new Map();
    // small, not base. Base loses whole passages of Mandarin: on one reported video
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
          onProgress?.(l / t, local ? "Loading Whisper from this computer" : "Downloading Whisper (once)");
        }
      },
    });
    cachedFrom = local ? "this computer" : "the network";
  }
  return { from: cachedFrom, model: await cache };
}

async function listen(mono16k, webgpu, language, onProgress) {
  const { model: asr } = await load(webgpu, onProgress);
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
