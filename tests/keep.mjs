// A dub made in the tab must survive a reload.
//   node tests/keep.mjs [dir-or-url]
// The pipeline itself takes minutes and a provider, so this drives the page's
// own store with a dub-shaped job: save it, reload the page, and check the
// result view comes back with playable files instead of the demo.
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

async function serve(dir) {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split("?")[0]));
    for (const p of [join(dir, rel), `${join(dir, rel)}.html`, join(dir, rel, "index.html")]) {
      try {
        if (!(await stat(p)).isFile()) continue;
        return res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }).end(await readFile(p));
      } catch { /* next shape */ }
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ ok }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const site = /^https?:/.test(target) ? { url: target.replace(/\/$/, ""), close() {} } : await serve(target);
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${site.url}/`, { waitUntil: "networkidle" });

// A job shaped like one the in-tab pipeline returns: real blobs, blob: URLs.
const saved = await page.evaluate(async () => {
  const blob = (bytes, type) => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  const job = {
    id: "browser", status: "done", filename: "holiday.mp4", created: Date.now() / 1000,
    options: { target: "zh-Hans", source: "en" },
    source_file: blob([1, 2, 3, 4], "video/mp4"),
    result: {
      target: "zh-Hans", target_name: "Chinese (Simplified)", target_endonym: "简体中文",
      source: "en", source_endonym: "English", local: true, duration: 12, width: 1280, height: 720,
      version: 1, extension: "mp4", lines: [], stats: {}, vad: [], sentences: [],
      files: { video: blob([5, 6, 7, 8], "video/mp4"), subtitles: blob([9], "text/plain") },
    },
  };
  return { ok: await window.opendub.saveDub(job), video: job.result.files.video };
});
check("a finished dub is kept", saved.ok === true, `saveDub → ${saved.ok}`);

// The blob URLs die with the page; only what was written can bring it back.
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

const after = await page.evaluate(() => {
  const dl = document.getElementById("dl-video");
  return {
    title: document.getElementById("res-title")?.textContent || "",
    href: dl?.getAttribute("href") || "",
    download: dl?.getAttribute("download") || "",
    eyebrow: document.getElementById("res-eyebrow")?.textContent || "",
    resultShown: !document.getElementById("view-result")?.hidden,
  };
});
check("after a reload the page shows the dub, not the demo", after.title === "holiday.mp4", after.title);
check("the result view is the one on screen", after.resultShown, `shown=${after.resultShown}`);
check("its video is playable again", /^blob:/.test(after.href), after.href.slice(0, 32));
check("and it still saves under its own name", /^holiday\.zh-Hans\.mp4$/.test(after.download), after.download);
check("the page says it was kept", /Kept on this device/i.test(after.eyebrow), after.eyebrow.trim().slice(0, 60));

// The bytes must be the ones written, not an empty placeholder.
const size = await page.evaluate(async () => {
  const r = await fetch(document.getElementById("dl-video").getAttribute("href"));
  return (await r.blob()).size;
});
check("the video that came back has its bytes", size === 4, `${size} bytes`);

// Removing it puts the demo back, which is what the page shows without one.
await page.evaluate(() => window.opendub.clearDub());
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
const demo = await page.evaluate(() => document.getElementById("res-title")?.textContent || "");
check("removing it brings the demo back", demo !== "holiday.mp4", demo);

check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 160));

await browser.close();
site.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
