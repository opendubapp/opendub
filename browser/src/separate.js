// Voice removal on the visitor's device: HTDemucs through ONNX Runtime Web
// (demucs-web, MIT). 172 MB of weights, downloaded once and cached by the
// browser. WebGPU when present; single-threaded WASM otherwise (slow).
import * as ort from "onnxruntime-web";
import { DemucsProcessor, CONSTANTS } from "demucs-web";

ort.env.wasm.wasmPaths = new URL("/browser/ort/", location.href).href;

export async function separate(L, R, { onProgress } = {}) {
  const processor = new DemucsProcessor({
    ort,
    onDownloadProgress: (loaded, total) => total && onProgress?.(loaded / total, "Downloading the voice separator (once, 172 MB)"),
    onProgress: (p) => onProgress?.(typeof p === "number" ? p : (p?.progress ?? 0), "Separating the voice from the music"),
  });
  await processor.loadModel(CONSTANTS.DEFAULT_MODEL_URL);
  const out = await processor.separate(L, R);
  const n = L.length, bl = new Float32Array(n), br = new Float32Array(n);
  for (const stem of ["drums", "bass", "other"]) {
    const s = out[stem]; if (!s) continue;
    for (let i = 0; i < n; i++) { bl[i] += s.left[i] ?? 0; br[i] += s.right[i] ?? 0; }
  }
  return { vocals: [out.vocals.left, out.vocals.right], background: [bl, br] };
}
