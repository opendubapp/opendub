// The models come from the app on this computer, with the network refused.
//   node tests/models-offline.mjs [http://127.0.0.1:8910/]
//
// The installers carry Whisper and the voice separator so that a first dub
// downloads nothing. The only way to know that is true is to take the CDN
// away: every request to huggingface.co is aborted here, and the load must
// still finish. Without the mirror this test cannot pass.
import { createRequire } from "node:module";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const base = (process.argv[2] || "http://127.0.0.1:8910/").replace(/\/?$/, "/");
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ ok }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch();
const page = await browser.newPage();
const blocked = [];
await page.route("**://*.huggingface.co/**", (r) => { blocked.push(r.request().url()); return r.abort(); });
await page.route("**://huggingface.co/**", (r) => { blocked.push(r.request().url()); return r.abort(); });
await page.route("**://*.hf.co/**", (r) => { blocked.push(r.request().url()); return r.abort(); });

await page.goto(base, { waitUntil: "domcontentloaded" });

const manifest = await page.evaluate(async (b) => {
  const r = await fetch(`${b}models/manifest.json`);
  return r.ok ? await r.json() : null;
}, base);
check("the app serves a model manifest", !!manifest?.models, JSON.stringify(manifest?.models || null));

const t0 = Date.now();
const got = await page.evaluate(async () => {
  const m = await import("/browser/opendub-browser.js");
  try { return { ok: true, ...(await m.warmModels()) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);
check("Whisper loads with the network refused", got.ok, got.ok ? `${secs}s` : got.error);
check("and it says it came from this computer", got.from === "this computer", String(got.from));

// The separator is the other 172 MB, and it is fetched by a different path.
const sep = await page.evaluate(async (b) => {
  const r = await fetch(`${b}models/htdemucs_embedded.onnx`, { method: "HEAD" });
  return { ok: r.ok, size: Number(r.headers.get("content-length") || 0) };
}, base);
check("the voice separator is served too", sep.ok && sep.size > 160e6, `${(sep.size / 1048576).toFixed(0)} MB`);

check("nothing was asked of the CDN", blocked.length === 0,
  blocked.slice(0, 3).join(" | "));

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
