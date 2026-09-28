// The extension's own logic, tested without Chrome's extension machinery.
//   node tests/extension.mjs
//
// Playwright will not load an unpacked extension here: its headless Chrome
// refuses, and a windowed one needs a desktop session this shell does not
// have. So each piece is exercised where it actually lives instead:
//
//   content.js  — plain DOM work, run against a real page with a real video
//   popup.js    — a page, run with chrome.tabs stubbed the way Chrome calls it
//   dub.html    — needs no extension API at all, so it is served and driven
//                 for real, fetching a real file
//
// What this cannot prove is that Chrome grants the host permission and wires
// the popup to the tab. That is checked by hand, and the report says so.
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

const browser = await chromium.launch();
const contentScript = await readFile(join(EXT, "content.js"), "utf8");

/** Run content.js against the page in front of us and ask it what it sees. */
const askContentScript = (page) => page.evaluate(async (src) => {
  let handler;
  globalThis.chrome = { runtime: { onMessage: { addListener: (f) => { handler = f; } } } };
  eval(src);
  return await new Promise((done) => handler({ type: "list" }, null, done));
}, contentScript);

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

// --- the popup, with Chrome's tab API stubbed --------------------------------
{
  const page = await browser.newPage();
  await page.addInitScript(() => {
    globalThis.chrome = {
      tabs: {
        query: (_q, cb) => cb([{ id: 1 }]),
        sendMessage: (_id, _msg, cb) => cb({
          videos: [
            { index: 0, seconds: 95, width: 1280, height: 720, src: "https://example.test/a.mp4", title: "A film" },
            { index: 1, seconds: 42, width: 640, height: 360, src: null, title: "A streamed one" },
          ],
        }),
      },
      runtime: { lastError: null, sendMessage: (m, cb) => { globalThis.__sent = m; if (cb) cb(); } },
    };
  });
  await page.goto(`${origin}/popup.html`, { waitUntil: "load" });
  await page.waitForSelector(".item", { timeout: 5000 });
  const buttons = await page.locator(".item button").evaluateAll((bs) => bs.map((b) => ({ text: b.textContent, off: b.disabled })));
  check("the popup offers the video it can take", buttons[0]?.text === "Dub this video" && !buttons[0]?.off, JSON.stringify(buttons[0]));
  check("and declines the other rather than offering a dead button", buttons[1]?.off === true, JSON.stringify(buttons[1]));
  const why = await page.locator(".item.cant .meta").last().textContent();
  check("the reason names what the site does", /pieces|builds/i.test(why), why.slice(0, 60));
  await page.close();
}

// --- the dubbing page, doing the real thing ----------------------------------
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
  await page.goto(`${origin}/dub.html?src=${encodeURIComponent(`${origin}/video.mp4`)}&name=holiday`, { waitUntil: "domcontentloaded" });
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
