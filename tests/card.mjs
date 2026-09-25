// The dub card and the result's file row, in a real browser against the built site.
//   node tests/card.mjs [dir-or-url]
// Covers APP-170 (the button said nothing when it could not run) and APP-167
// (a missing file printed a bare "null" between the download buttons).
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const target = process.argv[2] || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opendub-website-deploy";
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".mp4": "video/mp4", ".wav": "audio/wav", ".srt": "text/plain", ".vtt": "text/vtt", ".wasm": "application/wasm" };

/** Serve the built site, so the test runs against what is deployed rather than a dev server. */
async function serve(dir) {
  const server = createServer(async (req, res) => {
    let p = join(dir, normalize(decodeURIComponent(req.url.split("?")[0])));
    try {
      if ((await stat(p)).isDirectory()) p = join(p, "index.html");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await readFile(p);
      res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end("not found"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const site = /^https?:/.test(target) ? { url: target, close() {} } : await serve(target);
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(site.url, { waitUntil: "networkidle" });

const start = page.locator("#bstart");

// APP-170 — every state of the button names the step that is missing.
check("with no key, the button says which key to enter",
  /Enter your .* key/.test(await start.textContent()), await start.textContent());

await page.locator('#dub-here input[name="bprovider"][value="higgs"]').check();
await page.locator("#bkey").fill("bai-test-key");
check("with a key but no video, the button asks for the video",
  (await start.textContent()).includes("Choose a video first"), await start.textContent());

// The free route needs the app on this computer, which is not running here.
await page.locator("#dub-here .provider#bomni input").check();
await page.waitForTimeout(400);
const freeLabel = await start.textContent();
check("the free route offers to look for the app, and the button is live",
  /Look for the app/.test(freeLabel) && !(await start.isDisabled()), `${freeLabel}, disabled=${await start.isDisabled()}`);

// The click must do something visible — that is the whole of APP-170.
const statusBefore = await page.locator("#bomni-status").textContent();
await start.click();
await page.waitForTimeout(2500);
const statusAfter = await page.locator("#bomni-status").textContent();
check("pressing it changes the status instead of doing nothing",
  statusAfter !== statusBefore || /Looking|Start the OpenDub app/.test(statusAfter), statusAfter.trim().slice(0, 80));

// APP-167 — the demo result has no separate audio file; that must not print "null".
await page.goto(`${site.url}#demo`, { waitUntil: "networkidle" });
await page.waitForSelector("#downloads a", { timeout: 15000 });
const filesText = (await page.locator("#downloads").innerText()).trim();
check("the files row has no bare null", !/(^|\s)null(\s|$)/.test(filesText), filesText.replace(/\s+/g, " "));
check("the files row still lists the video and both subtitle files",
  (await page.locator("#downloads a").count()) >= 4, `${await page.locator("#downloads a").count()} buttons`);

check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
site.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
