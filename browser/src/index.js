// OpenDub in the browser. Loaded by the page only when it has no backend.
export { dub, STAGES } from "./pipeline.js";
export { LANGUAGES } from "./core.js";
export { localAppStatus, LOCAL_APP } from "./providers.js";

/**
 * Load the models before anything needs them, and say where they came from.
 *
 * The installer carries Whisper and the voice separator, so on a copy served
 * by the app this is a disk read rather than a download — and doing it on
 * start would take the one minute out of a first dub that has nothing to do
 * with the video. Nothing calls it on start yet; what it is used for today is
 * checking that an installed copy really did get its weights, which is what
 * tests/models-offline.mjs asserts with the network refused.
 *
 * On the website there is no mirror, so this is the ordinary download from
 * the CDN and callers should not do it uninvited.
 */
export async function warmModels({ onProgress } = {}) {
  const [{ mirror }, whisper] = await Promise.all([import("./models.js"), import("./whisper.js")]);
  const where = (await mirror()) ? "this computer" : "the network";
  const { from, model } = await whisper.load(await whisper.gpu(), onProgress);
  // Run it once, on a second of silence. A truncated weight file opens
  // perfectly well and only fails when something is asked of it, which
  // would otherwise be minutes into somebody's first dub.
  await model(new Float32Array(16000), { return_timestamps: true });
  return { from: from || where };
}

/** What this browser can do, so the page offers only what will work. */
export async function capabilities() {
  let webgpu = false;
  try { webgpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch {}
  const encode = typeof VideoEncoder === "function";
  return { webgpu, encode, translator: "Translator" in self };
}

// Translation in the tab, for browsers with none of their own. The table is
// cheap to ask; the model arrives only when it is used.
export { localTranslator } from "./translate-pairs.js";
export const translateLocally = async (...a) => (await import("./translate-local.js")).translateLocally(...a);

/**
 * Run the ONNX runtime without worker threads.
 *
 * Its threaded build starts workers from blob: URLs, and a Chrome extension
 * page may not: MV3 rejects "blob:" in the manifest's CSP outright, so the
 * extension will not even install with it. Slower on the processor, and the
 * only way the same pipeline runs in both places.
 */
/**
 * Settings for a page that may not build a worker from a blob: URL.
 *
 * An extension is one — MV3 refuses blob: in its policy, and the runtime's
 * "proxy" mode builds its worker that way, so that stays off. Threads are a
 * different thing and were switched off with it by mistake: the runtime makes
 * those from its own file, which an extension page is allowed to do, and
 * SharedArrayBuffer is there even though the page is not cross-origin
 * isolated. Listening to a 41-second video took 70 seconds on one thread.
 */
export async function singleThreaded() {
  const { env } = await import("@huggingface/transformers");
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads =
    typeof SharedArrayBuffer === "undefined" ? 1
      : Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
}
