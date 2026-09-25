import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// One ONNX Runtime for everything: demucs-web accepts any ort, so it is pointed
// at the copy transformers.js was built against, and only one runtime (and one
// set of wasm files, served from web/browser/ort/) ships.
const ORT = fileURLToPath(new URL("./node_modules/@huggingface/transformers/node_modules/onnxruntime-web", import.meta.url));

export default defineConfig({
  // Assets are served from /browser/ (web/browser/ on disk), on the site and in the local app alike.
  base: "/browser/",
  // ...and the build of it that fetches its wasm at runtime (from ort/) instead
  // of inlining it: the default "bundle" build embeds ~20 MB of wasm per chunk.
  resolve: {
    alias: [{ find: /^onnxruntime-web(\/webgpu)?$/, replacement: `${ORT}/dist/ort.webgpu.min.mjs` }],
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },
  build: {
    outDir: "../web/browser",
    emptyOutDir: true,
    modulePreload: false,
    target: "es2022",
    assetsInlineLimit: 0,
    // Not library mode: that inlines every asset (fonts, libass wasm) as base64.
    // An app build emits them as files the browser caches separately.
    rollupOptions: {
      input: { "opendub-browser": "src/index.js" },
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
  worker: { format: "es" },
});
