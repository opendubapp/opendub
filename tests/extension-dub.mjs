// A whole dub, inside the extension. Slow on purpose.
//   node tests/extension-dub.mjs [seconds]
//
// The file checks in tests/extension.mjs would not have caught what the
// real fault was: the runtime asks for a file by name when it starts a model,
// and the dub died at step three with "no available backend found". The only
// test that settles that is one that starts a model — so this loads the
// extension, hands it a real video, and waits for a dubbed file to come out.
//
// It needs the OpenDub app running on 127.0.0.1:8910 for the free voice, and
// it downloads Whisper on the first run. Minutes, not seconds.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const EXT = "/Users/dariuskohsg/Downloads/sharing_folder/openvoice/extension/build/chrome";
const CLIP = process.argv[3] || "/tmp/clip8s.mp4";
const BUDGET = Number(process.argv[2] || 900) * 1000;   // a dub on the processor is slow

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ ok }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0]));
  if (path === "/clip.mp4") {
    const body = await readFile(CLIP);
    return res.writeHead(200, { "content-type": "video/mp4", "content-length": body.length }).end(body);
  }
  res.writeHead(404).end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), "opendub-dub-"));
const browser = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  timeout: 120000,
  // With WebGPU on, because that is the path a person gets and the path
  // that broke: "no available backend found" came from the WebGPU runtime,
  // and it was twice reported as impossible to check here. It is not.
  // Headless Chromium simply does not enable WebGPU unless asked, and
  // without these the run quietly used the wasm build instead. Drop them
  // to exercise that one.
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal"],
});
const id = [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 15]).map((n) => "abcdefghijklmnop"[n]).join("");

const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

// --- the modules the WebGPU backend loads by name ---------------------------
// This machine has no GPU, so the WebGPU path cannot run here — but the
// failure was a module that could not be imported, and that can be proven.
await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "load" });
const onGpu = await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter()));
check("WebGPU is available to the extension's own pages", onGpu, onGpu ? "the dub below runs on it" : "falling back to wasm");

for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.mjs"]) {
  const ok = await page.evaluate(async (file) => {
    try { return !!(await import(chrome.runtime.getURL(`browser/ort/${file}`))); } catch { return false; }
  }, f);
  check(`the runtime module ${f.replace("ort-wasm-simd-threaded.", "")} imports inside the extension`, ok);
}

// --- a real dub -------------------------------------------------------------
await page.goto(`chrome-extension://${id}/dub.html?src=${encodeURIComponent(`${origin}/clip.mp4`)}&name=clip`,
  { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !document.querySelector("#start").disabled, { timeout: 60000 });

const voices = await page.locator("#voice option").evaluateAll((os) => os.map((o) => ({ v: o.value, off: o.disabled })));
const free = voices.find((v) => v.v === "local");
check("the free voice is offered, so the app on this computer was found", free && !free.off, JSON.stringify(free));

await page.selectOption("#voice", "local");
await page.selectOption("#to", "zh-Hans");
await page.selectOption("#from", "en");
await page.click("#start");

// Watch the stages rather than a spinner: a failure names the step it died on.
const started = Date.now();
let last = "";
// A step that says nothing for minutes reads as a step that has died. The
// model download alone is 240 MB, and the page used to show only a bold
// heading while it ran — which is how it was reported: "stuck on step 3".
let sawNote = false;
while (Date.now() - started < BUDGET) {
  await page.waitForTimeout(4000);
  const state = await page.evaluate(() => ({
    done: !document.querySelector("#done").hidden,
    doing: document.querySelector("#stages li.doing")?.textContent || "",
    log: document.querySelector("#log")?.textContent || "",
  }));
  if (state.doing && state.doing !== last) { last = state.doing; console.log(`      … ${last} (${Math.round((Date.now() - started) / 1000)}s)`); }
  if (/—/.test(state.doing)) sawNote = true;
  if (state.done) break;
  if (/no available backend|Failed to fetch dynamically|did not finish|Failed:/i.test(state.log)) {
    check("the dub ran without a backend error", false, state.log.split("\n").slice(-2).join(" ").slice(0, 150));
    break;
  }
}

const result = await page.evaluate(() => ({
  done: !document.querySelector("#done").hidden,
  src: document.querySelector("#player")?.getAttribute("src") || "",
  save: document.querySelector("#save")?.getAttribute("download") || "",
  log: document.querySelector("#log")?.textContent || "",
}));
check("the step being worked on says what it is doing", sawNote,
  sawNote ? "" : "the page showed only a bold heading for the whole run");
check("a dub finishes inside the extension", result.done, result.done ? "" : result.log.split("\n").slice(-2).join(" ").slice(0, 150));
check("it produced a playable file", /^blob:/.test(result.src), result.src.slice(0, 40));
check("saved under the video's own name", /^clip\.zh-Hans\.mp4$/.test(result.save), result.save);

if (result.done) {
  const bytes = await page.evaluate(async () => (await (await fetch(document.querySelector("#player").src)).blob()).size);
  check("and the file has real bytes in it", bytes > 20000, `${(bytes / 1024).toFixed(0)} KB`);
}
check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 160));

await browser.close();
server.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
