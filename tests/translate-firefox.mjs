// Firefox has no translator of its own, so OpenDub brings one.
//   node tests/translate-firefox.mjs [dir-or-url]
// This really downloads the model and really translates — about 250 MB the
// first time, cached by the browser profile afterwards. Chrome is checked too,
// to be sure it still uses its own and does not fetch ours.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { firefox, chromium } = require("playwright");

const target = process.argv[2] || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opendub-website-deploy";
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png",
  ".svg": "image/svg+xml", ".mp4": "video/mp4", ".wav": "audio/wav", ".woff2": "font/woff2", ".srt": "text/plain", ".vtt": "text/vtt" };

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

// --- Firefox: no translator of its own, so ours must do the work ------------
{
  const b = await firefox.launch();
  const page = await b.newPage();
  await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });

  const has = await page.evaluate(() => "Translator" in self);
  check("Firefox still has no translator of its own", has === false, `Translator in self = ${has}`);

  const out = await page.evaluate(async () => {
    const m = await import("/browser/opendub-browser.js");
    const pick = m.localTranslator("en", "zh");
    if (!pick) return { error: "no model offered for en→zh" };
    const texts = await m.translateLocally(["Privacy is not just about keeping information hidden."], "en", "zh");
    return { repo: pick.repo, text: texts[0] };
  });
  check("a model is offered for en→zh", !out.error, out.error || out.repo);
  check("it translates into Chinese", /[一-鿿]/.test(out.text || ""), out.text || "");

  // A pair with no model must say so, rather than failing deep in a dub.
  const none = await page.evaluate(async () => {
    const m = await import("/browser/opendub-browser.js");
    return m.localTranslator("th", "ko");   // neither direct nor via en-mul
  });
  check("an unsupported pair is declined up front", none === null, JSON.stringify(none));
  await b.close();
}

// --- Chrome: keeps its own, and must not pull ours in -----------------------
{
  const b = await chromium.launch();
  const page = await b.newPage();
  const fetched = [];
  page.on("request", (r) => { if (/huggingface|hf\.co/.test(r.url())) fetched.push(r.url()); });
  await page.goto(`${site.url}/`, { waitUntil: "networkidle" });
  const has = await page.evaluate(() => "Translator" in self);
  check("Chrome still reports its own translator", has === true, `Translator in self = ${has}`);
  check("and the page fetches no model to start with", fetched.length === 0, fetched.join(" ").slice(0, 80));
  await b.close();
}

site.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
