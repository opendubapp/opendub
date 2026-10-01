// The app on this computer going away mid-dub must not throw the dub away.
//   node tests/app-vanishes.mjs
//
// The free voice is served by the OpenDub app, and closing its window stops
// it. That happened seven minutes into a dub — after separating, listening
// and translating — and the run ended with "Lost the OpenDub app on this
// computer", losing all of it. Waiting for the app to come back costs
// nothing and saves the work.
//
// Here the app is made unreachable while the voice is being made, and put
// back a few seconds later. The dub must finish.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");
const EXT = new URL("../extension/build/chrome", import.meta.url).pathname;
const CLIP = process.argv[2] || "/tmp/clip8s.mp4";

const checks = [];
const check = (n, ok, d = "") => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

const server = createServer(async (_q, res) => {
  const b = await readFile(CLIP);
  res.writeHead(200, { "content-type": "video/mp4", "content-length": b.length }).end(b);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const ctx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "vanish-")), {
  channel: "chromium", timeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal"],
});

// The app is reachable until the voice step, then not, then is again.
let appGone = false;
await ctx.route("**://127.0.0.1:8910/api/local/speak", (r) => (appGone ? r.abort() : r.continue()));

const id = [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 15]).map((n) => "abcdefghijklmnop"[n]).join("");
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/dub.html?src=${encodeURIComponent(`${origin}/clip.mp4`)}&name=clip`,
  { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !document.querySelector("#start").disabled, { timeout: 60000 });
await page.check('input[name="voice"][value="local"]');
await page.selectOption("#from", "en");
await page.selectOption("#to", "zh-Hans");
await page.click("#start");

let pulled = false, restored = false, sawWaiting = false, state = {};
const started = Date.now();
while (Date.now() - started < Number(process.env.BUDGET || 1500) * 1000) {
  await page.waitForTimeout(3000);
  state = await page.evaluate(() => ({
    done: !document.querySelector("#done").hidden,
    stage: document.querySelector("#stages li.is-running")?.textContent || "",
    log: document.querySelector("#log")?.textContent || "",
  }));
  if (!pulled && /Clone the voice/.test(state.stage)) {
    appGone = true; pulled = true;
    console.log("      … the app is gone");
  }
  if (pulled && !restored && /stopped answering/.test(state.log)) {
    sawWaiting = true;
    appGone = false; restored = true;
    console.log("      … the app is back");
  }
  if (state.done || /Failed:/.test(state.log)) break;
}

check("it waits rather than giving up", sawWaiting,
  sawWaiting ? "" : "no waiting message appeared");
check("the dub survives the app going away", state.done,
  state.done ? "" : (state.log.split("\n").filter((l) => /Failed:/.test(l))[0] || "").slice(0, 120));

await ctx.close(); server.close();
const bad = checks.filter((c) => !c).length;
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
