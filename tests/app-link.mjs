// The line at the top of the dub card that says whether the OpenDub app on
// this computer is there, and the page connecting by itself once it is.
//   node tests/app-link.mjs [web-dir]
//
// The page is served as https://opendub.app (so it behaves as the public
// site, not as a page the app serves), and the app's health check is played
// by this script: absent at first, present a few seconds later. That is the
// case the page used to leave to the reader -- "when it finishes, press the
// button below" -- and the one this checks it now handles alone.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const WEB = process.argv[2] || new URL("../web/", import.meta.url).pathname;
// demo/config.json is produced by build_site.py from a demo job; the deployed
// copy is the one every other test reads too.
const FALLBACK = "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opendub-website-deploy";
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };

const checks = [];
const check = (name, ok, detail = "") => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.route("https://opendub.app/**", async (route) => {
  let p = decodeURIComponent(new URL(route.request().url()).pathname);
  if (p.endsWith("/")) p += "index.html";
  for (const dir of [WEB, FALLBACK]) {
    try {
      const body = await readFile(join(dir, p));
      return route.fulfill({ status: 200, headers: { "content-type": TYPES[extname(p)] || "application/octet-stream" }, body });
    } catch { /* next */ }
  }
  return route.fulfill({ status: 404, body: "" });
});

let appUp = false;
await page.route("http://127.0.0.1:8910/**", (route) => appUp
  ? route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true, app: "opendub", omnivoice: true,
        engines: [{ id: "omnivoice", name: "OmniVoice", ready: true, commercial: false, exact_duration: true, note: "", licence: "x" }] }) })
  : route.abort("connectionrefused"));

await page.goto("https://opendub.app/");
await page.waitForSelector("#applink");
const state = () => page.$eval("#applink", (e) => ({ state: e.dataset.state, text: e.innerText.replace(/\s+/g, " ").trim() }));

let s = await state();
check("the card opens by saying the free voices need the app, with one button", s.state === "idle" && /Connect to OpenDub/.test(s.text), JSON.stringify(s));
const box = await page.$eval("#applink", (e) => e.getBoundingClientRect().top);
const option = await page.$eval("#bomni", (e) => e.getBoundingClientRect().top);
check("and says it above the options, not inside one", box < option);

await page.click("#applink-btn");
await page.waitForFunction(() => document.querySelector("#applink").dataset.state === "missing", null, { timeout: 15000 });
s = await state();
check("with nothing running it says so at the top", /not running/.test(s.text), JSON.stringify(s));
check("the install panel no longer asks for a button press afterwards",
  await page.$eval("#bomni", (e) => /connects by itself/.test(e.innerText) && !/press the button below/.test(e.innerText)));

appUp = true;
await page.waitForFunction(() => document.querySelector("#applink").dataset.state === "ready", null, { timeout: 15000 })
  .catch(() => {});
s = await state();
check("once the app answers, the page connects without a click", s.state === "ready", JSON.stringify(s));
check("and the free voice is selected", await page.$eval('input[value="local"]', (e) => e.checked));

await page.goto("https://opendub.app/zh-Hans.html").catch(() => {});
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
