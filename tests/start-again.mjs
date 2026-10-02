// "Start again" must come back to the route that made the dub.
//   node tests/start-again.mjs [web-dir]
//
// The copy on someone's computer usually has no Higgs key, so the page hides
// the panel whose pipeline needs one and offers the card at the top instead.
// resetNew() revealed that hidden panel anyway, so finishing a dub and asking
// for another handed back a form whose only button was permanently grey —
// reported as "start again brings me to the same page but dub is greyed out".
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || join(here, "..", "web");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".mp4": "video/mp4", ".wav": "audio/wav", ".woff2": "font/woff2", ".wasm": "application/wasm" };

// The app on a computer, with no key: the shape /api/config answers with.
const CONFIG = {
  languages: [{ code: "en", name: "English", endonym: "English" },
              { code: "zh-Hans", name: "Chinese (Simplified)", endonym: "简体中文" }],
  default_target: "zh-Hans",
  stages: [{ key: "probe", label: "Read the video" }, { key: "speak", label: "Speak" }],
  has_key: false, emotions: ["neutral"], engines: [],
  voices: [{ id: "chloe", label: "Chloe" }],
  models: { stt: "higgs-stt-3.1", tts: "higgs-tts-3", llm: "higgs-realtime" },
};

async function serve() {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split("?")[0]));
    if (rel === "/api/config") {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(CONFIG));
    }
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

const site = await serve();
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${site.url}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const start = await page.evaluate(() => ({
  card: !document.getElementById("dub-here").hidden,
  panel: !document.getElementById("view-new").hidden,
}));
check("without a key the page offers the card, not the panel",
  start.card && !start.panel, `card=${start.card} panel=${start.panel}`);

// Put the page where a finished in-tab dub leaves it, then ask for another.
await page.evaluate(async () => {
  const blob = (b, t) => URL.createObjectURL(new Blob([new Uint8Array(b)], { type: t }));
  await window.opendub.saveDub({
    id: "browser", status: "done", filename: "holiday.mp4", created: Date.now() / 1000,
    options: { target: "zh-Hans", source: "en" },
    source_file: blob([1, 2, 3, 4], "video/mp4"),
    result: { target: "zh-Hans", target_name: "Chinese (Simplified)", target_endonym: "简体中文",
      source: "en", source_endonym: "English", local: true, duration: 12, width: 1280, height: 720,
      version: 1, extension: "mp4", lines: [], stats: {}, vad: [], sentences: [],
      files: { video: blob([5, 6, 7, 8], "video/mp4") } },
  });
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
check("the finished dub is on screen", await page.evaluate(() => !document.getElementById("view-result").hidden));

await page.click("#new-dub");
await page.waitForTimeout(400);

const after = await page.evaluate(() => {
  const b = document.getElementById("bstart");
  return {
    panel: !document.getElementById("view-new").hidden,
    result: !document.getElementById("view-result").hidden,
    card: !document.getElementById("dub-here").hidden,
    label: b.textContent.trim(), disabled: b.disabled,
    drop: document.getElementById("bdrop-title").textContent.trim(),
    hasFile: document.getElementById("bdrop").classList.contains("has-file"),
  };
});
check("it does not reveal the panel that needs a key", !after.panel, `panel=${after.panel}`);
check("the finished dub is cleared away", !after.result, `result=${after.result}`);
check("the card is where it lands", after.card, `card=${after.card}`);
check("the card's button is not a dead one", !after.disabled || after.label !== "Dub on this device",
  `"${after.label}" disabled=${after.disabled}`);
check("the last video is let go", !after.hasFile && /Choose a video/i.test(after.drop), after.drop);

// With a key the panel is the route, and its button says what it is waiting for.
CONFIG.has_key = true;
await page.goto(`${site.url}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);
const keyed = await page.evaluate(() => {
  const b = document.getElementById("start");
  return { panel: !document.getElementById("view-new").hidden, label: b.textContent.trim(), disabled: b.disabled };
});
check("with a key the panel is offered", keyed.panel, `panel=${keyed.panel}`);
check("and its button names the step it is waiting for",
  keyed.disabled && /choose a video/i.test(keyed.label), `"${keyed.label}" disabled=${keyed.disabled}`);

check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
site.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
