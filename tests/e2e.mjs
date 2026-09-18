// End to end in a real browser: upload -> dub -> check the page -> edit a line -> re-dub.
//   node tests/e2e.mjs path/to/video.mp4 [http://127.0.0.1:8910]
// Needs `playwright` resolvable; PLAYWRIGHT_FROM points at any node_modules that has it.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require("playwright");

const video = process.argv[2];
const base = process.argv[3] || "http://127.0.0.1:8910";
const shots = new URL("../work/shots/", import.meta.url).pathname;
mkdirSync(shots, { recursive: true });
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (m) => console.log("ok  ", m);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click("#more summary");
const voices = await page.locator("#set-voice option").count();
if (voices < 7) fail(`Other settings lists ${voices} voices`);
ok(`Other settings open: ${voices - 1} preset voices + clone, ${await page.locator("#set-tone option").count()} tone choices`);
const font = await page.evaluate(() => getComputedStyle(document.querySelector("h1")).fontFamily);
if (/serif/i.test(font) && !/sans/i.test(font)) fail(`h1 renders in ${font} — tokens did not load`);
ok(`tokens loaded (h1: ${font.split(",")[0]})`);
await page.screenshot({ path: shots + "1-new.png" });

// ---- upload and dub
await page.setInputFiles("#file", video);
await page.waitForFunction(() => !document.querySelector("#start").disabled);
const t0 = Date.now();
await page.click("#start");
await page.waitForSelector("#view-run:not([hidden])", { timeout: 60_000 });
ok("upload accepted, stages showing");
await page.waitForTimeout(20_000);
await page.screenshot({ path: shots + "2-running.png" });
await page.waitForSelector("#view-result:not([hidden]), #view-run .error-box", { timeout: 900_000 });
if (await page.locator("#view-run .error-box").count()) fail(`the dub failed: ${await page.locator("#view-run .error-box").innerText()}`);
ok(`dubbed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const lines = await page.locator(".line").count();
if (lines < 5) fail(`only ${lines} lines`);
ok(`${lines} lines listed`);
await page.waitForFunction(() => document.querySelector("#v-dub").readyState >= 1, null, { timeout: 30_000 });
const dur = await page.evaluate(() => document.querySelector("#v-dub").duration);
if (!(dur > 60)) fail(`dubbed video duration ${dur}`);
ok(`dubbed video plays metadata (${dur.toFixed(1)}s)`);
await page.evaluate(() => { const v = document.querySelector("#v-dub"); v.currentTime = 2; });
await page.waitForTimeout(800);
await page.locator("#view-result").screenshot({ path: shots + "3-result.png" });

// ---- phone width: nothing scrolls sideways
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
if (overflow) fail("page scrolls sideways at 390px");
ok("no horizontal overflow at 390px");
await page.screenshot({ path: shots + "4-phone.png", fullPage: true });
await page.setViewportSize({ width: 1440, height: 900 });

// ---- edit line 1 and re-dub
const fixed = "等等，现在跟你说话的真的是我吗，还是我的克隆体？";
const ta = page.locator('.line[data-id="0"] textarea');
await ta.fill(fixed);
await page.waitForSelector("#redub-bar:not([hidden])");
ok("edit shows the re-dub bar");
const toneBefore = await page.locator('.line[data-id="0"] .tone-select').inputValue();
ok(`line 1 tone read as: ${toneBefore}`);
await page.locator('.line[data-id="2"] .tone-select').selectOption("enthusiasm");
const barText = await page.locator("#redub-count").innerText();
if (!barText.startsWith("2 lines")) fail(`re-dub bar says "${barText}" after a text edit and a tone edit`);
ok("tone edit counted in the re-dub bar");

// drag line 5's right edge 0.5 s earlier
const blk = page.locator('.tl-dub span[data-id="4"]');
const bb = await blk.boundingBox();
const rowW = (await page.locator(".tl-dub").boundingBox()).width;
const dur0 = await page.evaluate(() => document.querySelector("#v-dub").duration);
await page.mouse.move(bb.x + bb.width - 2, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(bb.x + bb.width - 2 - 0.5 * rowW / dur0, bb.y + bb.height / 2, { steps: 8 });
await page.mouse.up();
const bar3 = await page.locator("#redub-count").innerText();
if (!bar3.startsWith("3 lines")) fail(`after a drag the bar says "${bar3}"`);
ok("dragging a block counts as a change");
const api = () => page.evaluate(async () => {
  const id = new URLSearchParams(location.hash.slice(1)).get("job");
  return (await (await fetch(`/api/jobs/${id}`)).json()).result;
});
const before = await api();
const off = before.lines.filter((l) => Math.abs(l.start - l.src_start) > 0.02 || Math.abs(l.end - l.src_end) > 0.02);
if (off.length) fail(`${off.length} of ${before.lines.length} lines are not aligned with the speaker: ${off.map((l) => l.id + 1).join(", ")}`);
ok(`${before.lines.length}/${before.lines.length} lines start and end with the speaker (±20 ms)`);
const want5 = before.lines[4].end - 0.5;

await page.click("#play-both");
await page.waitForTimeout(1200);
await page.click("#stop-both");
const stopped = await page.evaluate(() => ["#v-src", "#v-dub"].every((q) => { const v = document.querySelector(q); return v.paused && v.currentTime === 0; }));
if (!stopped) fail("stop both left a video playing");
ok("play side by side, then stop both");
const v0 = await page.evaluate(() => document.querySelector("#v-dub").src);
await page.click("#redub-go");
await page.waitForFunction((v0) => {
  const v = document.querySelector("#v-dub");
  return !document.querySelector("#view-result").hidden && v.src !== v0;
}, v0, { timeout: 300_000 });
const now = await ta.inputValue();
if (now !== fixed) fail(`line 1 after re-dub is ${now}`);
ok("re-dub finished; line 1 kept the edit and the video reloaded");
const tone3 = await page.locator('.line[data-id="2"] .tone-select').inputValue();
if (tone3 !== "enthusiasm") fail(`line 3 tone after re-dub is ${tone3}`);
ok("line 3 kept its new tone");
const after = await api();
const got5 = after.lines[4];
if (!got5.manual || Math.abs(got5.end - want5) > 0.1) fail(`line 5 after drag ends at ${got5.end}, wanted ~${want5.toFixed(2)}`);
ok(`line 5 now ends at ${got5.end.toFixed(2)}s (edge dragged -0.5s), ${got5.tempo}×`);
const off2 = after.lines.filter((l) => !l.manual && (Math.abs(l.start - l.src_start) > 0.02 || Math.abs(l.end - l.src_end) > 0.02));
if (off2.length) fail(`after the drag, lines ${off2.map((l) => l.id + 1).join(", ")} moved off the speaker`);
ok("every other line is still aligned with the speaker");
const chips = await page.locator('.line[data-id="0"] .line-meta .chip').allInnerTexts().then((a) => a.join("\n"));
ok(`line 1 chips: ${chips.replace(/\n/g, " | ")}`);

if (errors.length) fail(`console errors: ${errors.join(" / ")}`);
ok("no console errors");
await browser.close();
