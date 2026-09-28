// Translation in the tab, for browsers that have none of their own.
//
// Chrome has a built-in translator and keeps it; this is what Firefox gets
// instead of an error. The models are Helsinki-NLP's opus-mt, converted to
// ONNX and run through transformers.js — the same runtime the speech model
// already uses here, so nothing new is shipped to make it work.
//
// One model per direction, about 110–250 MB, cached by the browser after the
// first time. Where a direction has no model of its own, en-mul (one model,
// many targets, chosen with a token) stands in — poorer, but present.

import { pipeline, env } from "@huggingface/transformers";

// The same runtime settings the speech model uses: our own copy of the ONNX
// wasm, not a CDN. Without this the library reaches for jsdelivr, which the
// site's content-security-policy refuses — and the failure reads as "no
// available backend found" rather than as a blocked request.
env.backends.onnx.wasm.wasmPaths = new URL("/browser/ort/", location.href).href;
env.allowLocalModels = false;

import { localTranslator } from "./translate-pairs.js";

let loaded = null;   // one model at a time: they are hundreds of megabytes

/**
 * Translate `texts` from `source` to `target`, or throw if this pair has no
 * model. `onProgress` is called with 0…1 while the model downloads, and then
 * with the share of lines done.
 */
export async function translateLocally(texts, source, target, onProgress = () => {}) {
  const choice = localTranslator(source, target);
  if (!choice) throw new Error(`No translator on this device for ${source} → ${target}.`);

  if (!loaded || loaded.repo !== choice.repo) {
    loaded = {
      repo: choice.repo,
      task: await pipeline("translation", choice.repo, {
        dtype: "q8",
        progress_callback: (p) => {
          if (p.status === "progress" && p.total) onProgress(0.5 * (p.loaded / p.total));
        },
      }),
    };
  }

  const out = [];
  for (const [i, text] of texts.entries()) {
    const r = await loaded.task(choice.prefix + text, { max_new_tokens: 256 });
    out.push((Array.isArray(r) ? r[0] : r).translation_text.trim());
    onProgress(0.5 + 0.5 * ((i + 1) / texts.length));
  }
  return out;
}
