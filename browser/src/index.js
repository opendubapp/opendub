// OpenDub in the browser. Loaded by the page only when it has no backend.
export { dub, STAGES } from "./pipeline.js";
export { LANGUAGES } from "./core.js";
export { localAppStatus, LOCAL_APP } from "./providers.js";

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
