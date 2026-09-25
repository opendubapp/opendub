// Dub a real video in a real browser tab, end to end, with production's CSP.
//   BOSON_API_KEY=… node tests/browser-dub.mjs video.mp4 [--remove-voice] [--url https://opendub.app/]
// Without --url it serves dist/ itself on :8912 with the same headers as nginx.
// Spends real provider credit.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const video = resolve(args.find((a, i) => !a.startsWith("--") && !["--url", "--provider"].includes(args[i - 1])));
const remove = args.includes("--remove-voice");
const urlArg = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;
const key = process.env.BOSON_API_KEY;
const providerArg = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : "higgs";
if (!key && providerArg !== "omnivoice") throw new Error("BOSON_API_KEY is required");

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self' data: blob:; connect-src 'self' blob: data: https://auth.opendub.app https://api.boson.ai https://api.elevenlabs.io http://127.0.0.1:8910 http://localhost:8910 https://huggingface.co https://*.huggingface.co https://*.hf.co; frame-ancestors 'none'; base-uri 'self'";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".wasm": "application/wasm", ".mp4": "video/mp4", ".vtt": "text/vtt", ".srt": "text/plain", ".wav": "audio/wav", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };

let base = urlArg, server = null;
if (!base) {
  const root = new URL("../dist/", import.meta.url).pathname;
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = join(root, p);
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
    if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
    if (!existsSync(f)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream", "Content-Security-Policy": CSP });
    res.end(readFileSync(f));
  }).listen(8912);
  base = "http://127.0.0.1:8912/";
}

const b = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal"] });
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
const csp = [], errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/Content Security Policy|violates/.test(t)) csp.push(t);
  else if (m.type() === "error") errors.push(t);
});
page.on("pageerror", (e) => errors.push(String(e)));
const failed = [];
// 429s are retried by design, and a player switching sources aborts its old load.
page.on("response", (r) => r.status() >= 400 && r.status() !== 429 && !/huggingface|hf\.co/.test(r.url()) && failed.push(`${r.status()} ${r.url()}`));
page.on("requestfailed", (r) => r.failure()?.errorText !== "net::ERR_ABORTED" && failed.push(`failed ${r.url()} ${r.failure()?.errorText}`));

await page.goto(base);
await page.waitForSelector("#dub-here:not([hidden])");
console.log("webgpu:", await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter())));
await page.setInputFiles("#bfile", video);
await page.selectOption("#bsource", "en");
if (providerArg === "omnivoice" || providerArg.startsWith("local")) {
  await page.check('input[value="local"]');
  await page.waitForFunction(() => /Connected/.test(document.querySelector("#bomni-status")?.textContent || ""), null, { timeout: 15000 });
  if (process.env.ENGINE) await page.selectOption("#bengine", process.env.ENGINE);
  if (process.env.TRANSLATE_WITH_HIGGS && key) await page.fill("#btkey", key);
  console.log("ok   the card found the OpenDub app on this computer");
} else {
  if (providerArg === "elevenlabs") await page.check('input[value="elevenlabs"]');
  await page.fill("#bkey", key);
}
if (remove) await page.check("#bremove");
const t0 = Date.now();
await page.click("#bstart");
let last = "";
const poll = setInterval(async () => {
  const s = await page.evaluate(() => [...document.querySelectorAll(".stage.is-running .stage-label")].map((e) => e.textContent).join(" ")).catch(() => "");
  if (s && s !== last) { last = s; console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${s}`); }
}, 2000);
await page.waitForFunction(() => {
  const eb = document.querySelector("#res-eyebrow")?.textContent || "";
  return (/on this device/.test(eb) && !document.querySelector("#view-result").hidden) || document.querySelector("#view-run .error-box");
}, null, { timeout: 30 * 60_000 });
clearInterval(poll);
const err = await page.locator("#view-run .error-box").count() ? await page.locator("#view-run .error-box").innerText() : null;
if (err) { console.error("FAIL dub:", err, "\n", failed.join("\n")); console.error((await page.locator("#log").innerText()).slice(-1500)); process.exit(1); }
console.log(`ok   dubbed in ${((Date.now() - t0) / 1000).toFixed(0)} s, in the tab`);

const r = await page.evaluate(async () => {
  const v = document.querySelector("#v-dub");
  await new Promise((res) => (v.readyState >= 1 ? res() : v.addEventListener("loadedmetadata", res, { once: true })));
  const lines = [...document.querySelectorAll(".line")].length;
  const blocks = [...document.querySelectorAll(".tl-dub span")].length;
  const res = await fetch(v.src); const blob = await res.blob();
  return { dur: v.duration, lines, blocks, size: blob.size, type: blob.type, src: v.src.slice(0, 5), downloads: [...document.querySelectorAll("#downloads a")].map((a) => a.getAttribute("download")) };
});
console.log(JSON.stringify(r));
r.src === "blob:" ? console.log("ok   the demo section now shows the visitor's own dub") : console.error("FAIL the demo was not replaced");
r.dur > 5 ? console.log(`ok   dubbed video plays (${r.dur.toFixed(1)} s, ${(r.size / 1e6).toFixed(1)} MB)`) : console.error("FAIL video");
csp.length ? console.error("FAIL CSP violations:\n" + csp.join("\n")) : console.log("ok   no CSP violations under production's policy");
failed.length ? console.error("FAIL requests:\n" + failed.join("\n")) : console.log("ok   every request succeeded");
errors.length ? console.error("WARN console errors: " + errors.slice(0, 5).join(" / ")) : console.log("ok   no console errors");
await page.screenshot({ path: new URL("../work/browser-dub-result.png", import.meta.url).pathname });
const b64 = await page.evaluate(async () => {
  const blob = await (await fetch(document.querySelector("#v-dub").src)).blob();
  return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(blob); });
});
(await import("node:fs")).writeFileSync(new URL("../work/browser-dub.mp4", import.meta.url).pathname, Buffer.from(b64, "base64"));
console.log("saved work/browser-dub.mp4");
console.log((await page.locator("#log").innerText().catch(() => "")).split("\n").slice(-6).join("\n"));
await b.close();
server?.close();
