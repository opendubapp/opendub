// ONNX Runtime's wasm, beside the bundle: the site's CSP allows no CDN for code.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
const from = new URL("../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/", import.meta.url);
const to = new URL("../../web/browser/ort/", import.meta.url);
mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((f) => /^ort-wasm-simd-threaded\.(jsep\.|asyncify\.)?(wasm|mjs)$/.test(f));
for (const f of files) cpSync(new URL(f, from), new URL(f, to));
console.log(`ort: ${files.length} files → web/browser/ort/`);
