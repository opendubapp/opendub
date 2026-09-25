// Whisper in the tab (transformers.js), for timing and for the free route's
// words. Segment timestamps only: the ONNX exports have no cross-attentions,
// so word times are spread by character share (opensubs does the same).
import { env, pipeline } from "@huggingface/transformers";

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
    cache = pipeline("automatic-speech-recognition", "onnx-community/whisper-base", {
      device: webgpu ? "webgpu" : "wasm",
      // q8 fails on the WASM backend (opensubs found this); fp32 is ~4x the download.
      dtype: webgpu ? "q8" : "fp32",
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
    ...(language ? { language, task: "transcribe" } : {}),
  });
  const dur = mono16k.length / 16000;
  return (out.chunks || []).map((c) => ({ text: c.text.trim(), start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? dur }))
    .filter((c) => c.text);
}
