// The extension, loaded into Chrome and driven the way a person drives it.
//   node tests/extension.mjs
//
// It loads the built extension, opens its popup, asks the content script what
// is on two pages — one with a plain video file, one that builds its video in
// JavaScript — and then opens the dubbing page against a real file.
//
// This exists because the first version of the manifest would not install at
// all: Chrome rejects "blob:" in an extension page's CSP, and the only sign
// was the extension silently not being there. A test that loads it for real
// is the one that would have caught that (APP-190).
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const EXT = "/Users/dariuskohsg/Downloads/sharing_folder/openvoice/extension/build/chrome";
const DEMO = "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opendub-website-deploy/demo/dubbed.mp4";
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".wasm": "application/wasm", ".mp4": "video/mp4", ".png": "image/png", ".woff2": "font/woff2" };

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ ok }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

// The extension's files, plus two pages: one with a real video file, one that
// builds its video in the page the way a streaming site does.
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0]));
  if (path === "/video.mp4") {
    const body = await readFile(DEMO);
    return res.writeHead(200, { "content-type": "video/mp4", "content-length": body.length }).end(body);
  }
  if (path === "/page") {
    return res.writeHead(200, { "content-type": "text/html" }).end(
      `<title>A plain video page</title><video id="v" src="/video.mp4" controls preload="metadata"></video>`);
  }
  if (path === "/streamed") {
    return res.writeHead(200, { "content-type": "text/html" }).end(
      `<title>Streamed page</title><video id="v" controls></video>
       <script>fetch("/video.mp4").then(r => r.blob()).then(b => { v.src = URL.createObjectURL(b); });</script>`);
  }
  for (const p of [join(EXT, path)]) {
    try {
      if (!(await stat(p)).isFile()) continue;
      return res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }).end(await readFile(p));
    } catch { /* fall through */ }
  }
  res.writeHead(404).end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const { mkdtemp } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { createHash } = await import("node:crypto");

const profile = await mkdtemp(join(tmpdir(), "opendub-ext-"));
const browser = await chromium.launchPersistentContext(profile, {
  channel: "chromium",                 // the headless that loads extensions
  timeout: 120000,                     // 41 MB of wasm to verify first
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// An unpacked extension's id comes from the path it was loaded from: the
// first 16 bytes of the SHA-256, each nibble mapped onto a…p.
const id = [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 15]).map((n) => "abcdefghijklmnop"[n]).join("");

// If the manifest is refused there is no popup page, which is exactly how
// APP-190 showed up: the extension was simply not there.
const popup = await browser.newPage();
const loaded = await popup.goto(`chrome-extension://${id}/popup.html`).catch(() => null);
check("Chrome accepts the manifest and loads the extension", loaded?.status() === 200,
  loaded ? `popup ${loaded.status()}` : "no extension at its own id");
const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
check("its background script runs", !!worker, worker ? "service worker running" : "none");

/** Ask the real content script, through Chrome, what it sees on a tab.
    Querying by URL needs the "tabs" permission, which this extension does
    not ask for — so do what the popup does and go by the tab itself. */
const askContentScript = async (page) => {
  const url = page.url();
  return await popup.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      const answer = await chrome.tabs.sendMessage(tab.id, { type: "list" }).catch(() => null);
      if (answer?.page === u) return answer;
    }
    return { videos: [], page: null };
  }, url);
};

// --- a page with a real file ------------------------------------------------
{
  const page = await browser.newPage();
  await page.goto(`${origin}/page`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("video")?.readyState > 0, { timeout: 15000 }).catch(() => {});
  const listed = await askContentScript(page);
  check("it finds the video on a page", listed.videos.length === 1, `${listed.videos.length} found`);
  check("and sees a file it can take", /video\.mp4$/.test(listed.videos[0]?.src || ""), listed.videos[0]?.src || "no src");
  check("with its length and size", listed.videos[0]?.seconds > 0 && listed.videos[0]?.width > 0,
    `${listed.videos[0]?.seconds}s ${listed.videos[0]?.width}×${listed.videos[0]?.height}`);
  await page.close();
}

// --- a page that builds its video in JavaScript ------------------------------
{
  const page = await browser.newPage();
  await page.goto(`${origin}/streamed`, { waitUntil: "load" });
  await page.waitForFunction(() => /^blob:/.test(document.querySelector("video")?.currentSrc || ""), { timeout: 15000 }).catch(() => {});
  const listed = await askContentScript(page);
  check("a video built in the page is reported as untakeable, not missed",
    listed.videos.length === 1 && listed.videos[0].src === null, JSON.stringify(listed.videos[0]?.src));
  await page.close();
}

// --- the popup's own page, with the tab it asks about held steady ------------
// A real popup is not a tab, so "the active tab" is the page behind it. Opened
// here it would find itself, which says nothing about the popup — so the two
// calls it makes are answered with what a content script really returns.
{
  const view = await browser.newPage();
  await view.addInitScript(() => {
    const answer = {
      videos: [
        { index: 0, seconds: 95, width: 1280, height: 720, src: "https://example.test/a.mp4", title: "A film" },
        { index: 1, seconds: 42, width: 640, height: 360, src: null, title: "A streamed one" },
      ],
    };
    Object.defineProperty(chrome, "tabs", {
      value: { query: (_q, cb) => cb([{ id: 1 }]), sendMessage: (_id, _m, cb) => cb(answer) },
    });
  });
  await view.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "load" });
  await view.waitForSelector(".item", { timeout: 8000 });
  const buttons = await view.locator(".item button").evaluateAll((bs) => bs.map((b) => ({ text: b.textContent, off: b.disabled })));
  check("the popup offers the video it can take", buttons[0]?.text === "Dub this video" && !buttons[0]?.off, JSON.stringify(buttons[0]));
  check("and declines the other rather than offering a dead button", buttons[1]?.off === true, JSON.stringify(buttons[1]));
  const why = await view.locator(".item.cant .meta").last().textContent();
  check("the reason names what the site does", /pieces|builds/i.test(why), why.slice(0, 58));
  await view.close();
}

// --- the runtime is whole ----------------------------------------------------
// A dub asked for ort-wasm-simd-threaded.asyncify.mjs at its third step and
// stopped, because the build had left it out to save 26 MB (APP-191). The
// runtime picks a file by name at that moment, so every one it might name has
// to be there — and reachable from inside the extension, not merely on disk.
{
  const { readdir } = await import("node:fs/promises");
  const site = (await readdir(join(EXT, "..", "..", "..", "web", "browser", "ort"))).sort();
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "load" });
  const missing = await page.evaluate(async (files) => {
    const out = [];
    for (const f of files) {
      const r = await fetch(chrome.runtime.getURL(`browser/ort/${f}`)).catch(() => null);
      if (!r?.ok) out.push(f);
    }
    return out;
  }, site);
  check(`every runtime file the site ships is in the extension (${site.length})`,
    missing.length === 0, missing.join(", ") || "none missing");
  await page.close();
}

// --- the dubbing page, doing the real thing ----------------------------------
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
  await page.goto(`chrome-extension://${id}/dub.html?src=${encodeURIComponent(`${origin}/video.mp4`)}&name=holiday`,
    { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.querySelector("#start").disabled
    || /could not|cannot/.test(document.querySelector("#note").textContent), { timeout: 30000 }).catch(() => {});
  const state = await page.evaluate(() => ({
    button: document.querySelector("#start").textContent.trim(),
    note: document.querySelector("#note").textContent.trim(),
    languages: document.querySelectorAll("#to option").length,
    voices: [...document.querySelectorAll("#voice option")].map((o) => o.textContent),
  }));
  check("the dubbing page fetches the video it was given", state.button === "Dub it", `${state.button} — ${state.note.slice(0, 50)}`);
  check("it says the video stays on this machine", /stays on this computer/i.test(state.note), state.note.slice(0, 60));
  check("it offers every language the site does", state.languages >= 17, `${state.languages} languages`);
  check("and says whether the free voice is there", state.voices.some((v) => /not running|free/.test(v)), state.voices.join(" | "));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
server.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
