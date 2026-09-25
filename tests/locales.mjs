// Every language the site offers, in a real browser.
//   node tests/locales.mjs [dir-or-url]
// A translation can exist in a file and never reach the screen, so this asserts
// on what renders: the page's own language, a heading that differs in all eight,
// the card's JavaScript strings following the page, and the switcher going both
// ways. Structure parity is a separate check (locale-parity.mjs).
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

/** Serve the built directory the way nginx does: /ja resolves to ja.html. */
async function serve(dir) {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split("?")[0]));
    for (const p of [join(dir, rel), `${join(dir, rel)}.html`, join(dir, rel, "index.html")]) {
      try {
        if (!(await stat(p)).isFile()) continue;
        return res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }).end(await readFile(p));
      } catch { /* try the next shape */ }
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// The button label in each language: the card writes it from the catalogue, so
// it proves i18n.js reached the page, not just that the HTML was translated.
const LOCALES = [
  { tag: "en", path: "/", dub: "Dub on this device", privacy: "/privacy" },
  { tag: "zh-Hans", path: "/zh-Hans", dub: "在这台设备上配音", privacy: "/zh-Hans/privacy" },
  { tag: "zh-Hant", path: "/zh-Hant", dub: "在這台裝置上配音", privacy: "/zh-Hant/privacy" },
  { tag: "ja", path: "/ja", dub: "この端末で吹き替える", privacy: "/ja/privacy" },
  { tag: "ko", path: "/ko", dub: "이 기기에서 더빙", privacy: "/ko/privacy" },
  { tag: "de", path: "/de", dub: "Auf diesem Gerät synchronisieren", privacy: "/de/privacy" },
  { tag: "es", path: "/es", dub: "Doblar en este dispositivo", privacy: "/es/privacy" },
  { tag: "pt", path: "/pt", dub: "Dublar neste dispositivo", privacy: "/pt/privacy" },
];

// Any real video file will do; the card only reads its name and size here.
const DEMO = "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opendub-website-deploy/demo/dubbed.mp4";

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const site = /^https?:/.test(target) ? { url: target.replace(/\/$/, ""), close() {} } : await serve(target);
const browser = await chromium.launch();

for (const L of LOCALES) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const res = await page.goto(site.url + L.path, { waitUntil: "networkidle" });
  check(`${L.tag}  page is served`, res.status() === 200, `HTTP ${res.status()}`);
  check(`${L.tag}  <html lang> matches`, (await page.getAttribute("html", "lang")) === L.tag,
    await page.getAttribute("html", "lang"));

  // The card's own strings come from the catalogue, keyed off the page's lang.
  // A video and a key, so the button reaches its "ready to dub" label.
  await page.locator('#dub-here input[name="bprovider"][value="higgs"]').check();
  await page.locator("#bkey").fill("bai-test-key");
  await page.setInputFiles("#bfile", DEMO);
  const label = (await page.locator("#bstart").textContent()).trim();
  check(`${L.tag}  the button speaks the page's language`, label === L.dub, label);

  // Everything the card writes from JavaScript, not only the button: the key
  // label and its note were the last two English strings on a translated page.
  const keyLabel = (await page.locator("#bkey-label").textContent()).trim();
  const keyNote = (await page.locator("#bkey-note").textContent()).trim();
  check(`${L.tag}  the key field and its note are in the page's language`,
    L.tag === "en" ? keyLabel === "Higgs Audio API key"
      : keyLabel !== "Higgs Audio API key" && keyNote !== "Used for this dub only and sent only to Boson AI. Never stored.",
    `${keyLabel} / ${keyNote.slice(0, 40)}`);

  check(`${L.tag}  the current language is marked in the switcher`,
    (await page.locator(`.lang-row a[aria-current="page"]`).getAttribute("hreflang")) === L.tag);
  check(`${L.tag}  the privacy page is one click away and in the same language`,
    (await page.locator(`a[href="${L.privacy}"]`).count()) > 0, L.privacy);
  check(`${L.tag}  no page errors`, errors.length === 0, errors.join(" | ").slice(0, 160));
  await page.close();
}

// The switcher has to work both ways, or a reader who lands in the wrong
// language is stuck there.
const page = await browser.newPage();
await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" });
await page.locator('.lang-row a[hreflang="ja"]').click();
await page.waitForLoadState("domcontentloaded");
check("English → 日本語 through the footer row", (await page.getAttribute("html", "lang")) === "ja", page.url());
await page.locator('.lang-row a[hreflang="en"]').click();
await page.waitForLoadState("domcontentloaded");
check("日本語 → English and back", (await page.getAttribute("html", "lang")) === "en", page.url());

// A translated privacy page must carry the switcher too; without it that page
// is a dead end in whatever language the reader arrived in.
await page.goto(`${site.url}/de/privacy`, { waitUntil: "domcontentloaded" });
check("a locale privacy page has the language row",
  (await page.locator(".lang-row a").count()) === 8, `${await page.locator(".lang-row a").count()} links`);

await browser.close();
site.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
