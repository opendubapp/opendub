# Source and build instructions for review (Firefox / AMO)

Everything below reproduces the uploaded add-on from source on a clean machine.

## There is no Rust in this add-on

No Rust, no `cargo`, no `wasm-bindgen`. There is no `Cargo.toml` anywhere in
the project. If you were told otherwise, that is a different application.

The add-on does contain three `.wasm` files. None of them are built here —
they are shipped, prebuilt, inside two public npm packages, and are copied in
unchanged:

| file | comes from | version |
|---|---|---|
| `browser/ort/ort-wasm-simd-threaded.wasm` | `onnxruntime-web` (via `@huggingface/transformers`) | 1.31.0-dev.20260914-8d85527a0 |
| `browser/ort/ort-wasm-simd-threaded.jsep.wasm` | same | same |
| `browser/ort/ort-wasm-simd-threaded.asyncify.wasm` | same | same |
| `browser/assets/jassub-worker-*.wasm` | `jassub` | 1.8.8 |

Both are Emscripten builds of C/C++ projects (ONNX Runtime; libass). Their own
sources are at https://github.com/microsoft/onnxruntime and
https://github.com/ThaUnknown/jassub. We do not compile them; `npm ci`
downloads them and the build copies them.

## Toolchain

| | version used for the upload |
|---|---|
| Node.js | 26.8.1 |
| npm | 11.19.0 |
| vite | 6.4.3 (from `package-lock.json`) |
| TypeScript | 5.7.3 (type-checking only; not needed to build) |

Any Node 20+ should work. `npm ci` pins every dependency from
`package-lock.json`, which is included.

## Build

From the root of this source archive:

```sh
# 1. the dubbing pipeline — the bundle the add-on carries
cd browser
npm ci
npm run build          # vite build, then scripts/sync-assets.mjs
cd ..

# 2. the add-on itself
./extension/build.sh
```

`npm run build` writes to **`web/browser/`** (set by `build.outDir` in
`browser/vite.config.js`). `sync-assets.mjs` then copies the ONNX Runtime
files into `web/browser/ort/`.

`extension/build.sh` assembles both targets and writes:

- **`extension/build/firefox/`** — the unpacked add-on, and what to compare against
- **`extension/build/firefox/manifest.json`** — `manifest.firefox.json`, renamed
- **`extension/build/opendub-firefox.zip`** — the uploaded package

It copies `extension/src/*.{js,html,css}`, `extension/icons/`, and the whole
of `web/browser/` into the target, then zips it. No other transformation.

## One modification to a third-party file, disclosed

`extension/build.sh` edits one line of JASSUB's worker after it is copied in:

```
catch(e){console.warn(e),eval(read_(data.legacyWasmUrl))}   ->   catch(e){console.warn(e)}
```

JASSUB probes for WebAssembly support in a way an extension's content security
policy refuses, and its fallback for "no WebAssembly" is `eval()`, which is
also refused. The probe is harmless; the `eval()` fallback can never run under
MV3 and is removed so the failure path cannot be reached. The build fails
loudly if that line is not found, so the patch cannot silently miss.

## What is in this archive

`browser/` (source, `package.json`, `package-lock.json`, `vite.config.js`,
`scripts/`), `extension/` (source, icons, `build.sh`, manifests), and the
licence. `node_modules/`, build output and local configuration are excluded;
`npm ci` restores the first from the lockfile.

## Licence

AGPL-3.0. Source: https://github.com/opendubapp/opendub
