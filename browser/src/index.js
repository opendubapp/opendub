// OpenDub in the browser. Loaded by the page only when it has no backend.
export { dub, STAGES } from "./pipeline.js";
export { LANGUAGES } from "./core.js";
export { localAppStatus } from "./providers.js";

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
