// A translator that fails after it was created must not end the dub.
//   node tests/translator-fallback.mjs
//
// Chrome will only start a language-pack download from a user gesture. Asking
// for the translator inside the click handler fixed create(); it did not fix
// translate(), which is called minutes later and throws the same refusal while
// the pack is still coming down. That call had no handler, so a 4:18 video
// spent 1:35 separating and 2:24 listening and then died at step four — with a
// local model for the pair sitting unused.
//
// The stub here creates cleanly and then refuses, which is exactly the shape
// reported. Against the code before the fix this scores 0/3.
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
const checks = [];
const check = (n, ok, d = "") => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

const server = createServer(async (_q, res) => {
  const b = await readFile(process.argv[2] || "/tmp/clip8s.mp4");
  res.writeHead(200, { "content-type": "video/mp4", "content-length": b.length }).end(b);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const ctx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "gest-")), {
  channel: "chromium", timeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal"],
});
const id = [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 15]).map((n) => "abcdefghijklmnop"[n]).join("");
const page = await ctx.newPage();

// A translator that creates cleanly and then refuses, exactly as reported.
await page.addInitScript(() => {
  window.Translator = {
    availability: async () => "downloading",
    create: async () => ({
      sourceLanguage: "en", targetLanguage: "zh",
      translate: async () => {
        throw new Error('Requires a user gesture when availability is "downloading" or "downloadable".');
      },
    }),
  };
});
await page.goto(`chrome-extension://${id}/dub.html?src=${encodeURIComponent(`${origin}/clip.mp4`)}&name=clip`,
  { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !document.querySelector("#start").disabled, { timeout: 60000 });
await page.selectOption("#voice", "local");
await page.selectOption("#from", "en");
await page.selectOption("#to", "zh-Hans");
await page.click("#start");

const started = Date.now();
let state = {};
while (Date.now() - started < 1200000) {
  await page.waitForTimeout(4000);
  state = await page.evaluate(() => ({
    done: !document.querySelector("#done").hidden,
    log: document.querySelector("#log")?.textContent || "",
  }));
  if (state.done || /Failed:/.test(state.log)) break;
}
check("the dub survives a translator that fails mid-flight", state.done,
  state.done ? "" : (state.log.split("\n").filter((l) => /Failed:/.test(l))[0] || "").slice(0, 120));
check("and says so in the log rather than dying", /stopped part-way/.test(state.log),
  (state.log.split("\n").find((l) => /stopped part-way|built-in/.test(l)) || "nothing said").trim().slice(0, 100));
check("falling back to the model on this device", /opus-mt/.test(state.log));

// --- a key the browser filled in for you --------------------------------------
// The key boxes are password fields, so a browser will offer a saved password
// for them. That is not a key: the server refuses it. Before, it ended the dub
// — and after the key started being checked up front, it ended it immediately,
// for a key nobody typed. A refused *translation* key should cost the wording
// and nothing else.
{
  const ctx2 = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "badkey-")), {
    channel: "chromium", timeout: 120000,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page2 = await ctx2.newPage();
  await page2.goto(`chrome-extension://${id}/dub.html?src=${encodeURIComponent(`${origin}/clip.mp4`)}&name=clip`,
    { waitUntil: "domcontentloaded" });
  await page2.waitForFunction(() => !document.querySelector("#start").disabled, { timeout: 60000 });
  // the free voice, plus a "key" of the sort a password manager supplies
  await page2.selectOption("#voice", "local");
  await page2.evaluate(() => {
    const k = document.querySelector("#key");
    k.value = "hunter2-a-saved-password";                  // not a key
    document.querySelector("#keywrap").hidden = false;
  });
  await page2.selectOption("#from", "en");
  await page2.selectOption("#to", "zh-Hans");
  await page2.click("#start");
  let st = {};
  const t0 = Date.now();
  while (Date.now() - t0 < 900000) {
    await page2.waitForTimeout(4000);
    st = await page2.evaluate(() => ({
      done: !document.querySelector("#done").hidden,
      log: document.querySelector("#log")?.textContent || "",
    }));
    if (st.done || /Failed:/.test(st.log)) break;
  }
  check("a refused translation key does not end the dub", st.done,
    st.done ? "" : (st.log.split("\n").filter((l) => /Failed:/.test(l))[0] || "").slice(0, 120));
  await ctx2.close();
}

await ctx.close(); server.close();
const bad = checks.filter((c) => !c).length;
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
