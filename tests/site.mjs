// The public site, as served: demo mode, nothing sent anywhere, every file resolves.
//   node tests/site.mjs https://opendub.app/          (or a local static server)
// Needs `playwright`; PLAYWRIGHT_FROM points at any node_modules that has it.
import { createRequire } from "node:module";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const base = process.argv[2] || "http://127.0.0.1:8911/";
const origin = new URL(base).hostname;
let failed = 0;
const ok = (m) => console.log("ok  ", m);
const fail = (m) => { console.error("FAIL", m); failed++; };

// RESOLVE="opendub.app 104.36.65.54" pins a hostname to an address, for testing
// the server itself while DNS still has another answer in it.
const b = await chromium.launch(process.env.RESOLVE
  ? { args: [`--host-resolver-rules=MAP ${process.env.RESOLVE}`] } : {});
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
const external = new Set(), bad = [], errors = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (!["data:", "blob:"].includes(u.protocol) && u.hostname !== origin) external.add(u.hostname);
});
page.on("response", (r) => r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(base);
await page.waitForSelector("#view-result:not([hidden])", { timeout: 30_000 });
await page.waitForFunction(() => document.querySelector("#v-dub").readyState >= 2
  && document.querySelector("#v-src").readyState >= 2, null, { timeout: 30_000 });

const s = await page.evaluate(() => ({
  isStatic: document.documentElement.classList.contains("is-static"),
  lines: document.querySelectorAll(".line").length,
  uploadHidden: getComputedStyle(document.querySelector("#view-new")).display === "none",
  localPanel: !document.querySelector("#view-local").hidden,
  readOnly: [...document.querySelectorAll(".line textarea")].every((t) => t.readOnly),
  toneLocked: [...document.querySelectorAll(".tone-select")].every((t) => t.disabled),
  downloads: [...document.querySelectorAll("#downloads a")].map((a) => a.getAttribute("href")),
  dur: document.querySelector("#v-dub").duration,
  aligned: [...document.querySelectorAll(".tl-dub span")].length,
}));
s.isStatic ? ok("demo mode: no backend probed, page marked static") : fail("page did not enter demo mode");
s.lines >= 5 ? ok(`${s.lines} dubbed lines listed`) : fail(`only ${s.lines} lines`);
s.uploadHidden && s.localPanel ? ok("upload replaced by the run-it-yourself panel") : fail("upload/local panels wrong");
s.readOnly && s.toneLocked ? ok("lines and tones are read-only") : fail("demo lines are editable");
s.dur > 20 ? ok(`dubbed video plays (${s.dur.toFixed(1)} s)`) : fail(`video duration ${s.dur}`);
for (const href of s.downloads) {
  const r = await page.request.get(new URL(href, base).href);
  r.ok() ? ok(`download ${href} → ${r.status()} ${r.headers()["content-type"]}`) : fail(`download ${href} → ${r.status()}`);
}

// Link preview and icons: what a chat app fetches without running the page.
const html = await (await page.request.get(base)).text();
const og = html.match(/property="og:image" content="([^"]+)"/)?.[1];
og?.startsWith("https://") ? ok(`og:image is absolute (${og})`) : fail(`og:image is ${og}`);
for (const f of ["favicon.ico", "favicon.svg", "icon-180.png", "icon-192.png", "og-image.png"]) {
  const r = await page.request.get(new URL(f, base).href);
  r.ok() ? ok(`${f} ${r.headers()["content-type"]}`) : fail(`${f} → ${r.status()}`);
}
(await page.request.get(new URL("does-not-exist", base).href)).status() === 404
  ? ok("an unknown path is a real 404") : fail("unknown path did not 404");

const phone = await b.newPage({ viewport: { width: 390, height: 844 } });
await phone.goto(base);
await phone.waitForSelector("#view-result:not([hidden])");
(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
  ? fail("page scrolls sideways at 390 px") : ok("no horizontal scroll at 390 px");

external.size ? fail(`requests left the site: ${[...external].join(", ")}`) : ok("nothing is sent anywhere else");
bad.length ? fail(`failed responses: ${bad.join(" / ")}`) : ok("no failed responses");
errors.length ? fail(`console errors: ${errors.join(" / ")}`) : ok("no console errors");
await b.close();
if (failed) { console.error(`${failed} failed`); process.exit(1); }
