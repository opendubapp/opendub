// Site assets from one mark: favicon.svg/.ico, icon PNGs, and the 1200×630 link card.
//   node scripts/make_assets.mjs dist/
// Needs `playwright`; PLAYWRIGHT_FROM points at any node_modules that has it.
import { createRequire } from "node:module";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: make_assets.mjs <dist dir>");
// The tile in the page header: --logo-tile-bg (#020202) holding the waveform
// glyph in --logo-tile-fg (--brand, #00c896).
const TILE = "#020202", GLYPH = "#00c896";
const svg = (size = 64) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="${TILE}"/>
<g transform="translate(14 14) scale(1.5)" fill="none" stroke="${GLYPH}" stroke-width="2.2" stroke-linecap="round">
<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></g></svg>`;

writeFileSync(join(OUT, "favicon.svg"), svg());

const b = await chromium.launch();
const page = await b.newPage();
const png = async (size) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
};
const pngs = {};
for (const s of [16, 32, 48, 180, 192, 512]) {
  pngs[s] = await png(s);
  writeFileSync(join(OUT, `icon-${s}.png`), pngs[s]);
}

// favicon.ico: PNG-encoded entries, 16 + 32 + 48 (a 256 entry would be written as 0).
const ico = (sizes) => {
  const imgs = sizes.map((s) => pngs[s]);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += imgs[i].length;
  });
  return Buffer.concat([head, ...imgs]);
};
writeFileSync(join(OUT, "favicon.ico"), ico([16, 32, 48]));

// The link card is type, so it is HTML set in the site's own tokens, written to a
// real file beside them (setContent on about:blank cannot load file:// CSS).
const card = join(OUT, "_card.html");
writeFileSync(card, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="vendor/tokens/styles.css"><style>
body{margin:0;width:1200px;height:630px;background:var(--bg-page);display:flex;flex-direction:column;justify-content:center;padding:0 88px;box-sizing:border-box;font-family:var(--font-sans)}
.tile{width:88px;height:88px}.brand{display:flex;align-items:center;gap:28px}
.word{font:500 96px/1 var(--font-display);letter-spacing:-0.04em;color:var(--text-strong)}
.m{color:var(--text-muted)}.d{color:var(--accent-4)}
h1{font:500 50px/1.15 var(--font-display);letter-spacing:-0.02em;color:var(--text-strong);margin:44px 0 0;max-width:980px}
p{font:400 28px/1.4 var(--font-sans);color:var(--text-muted);margin:20px 0 0}
</style></head><body>
<div class="brand"><span class="tile">${svg(88)}</span><span class="word"><span class="m">Open</span>Dub<span class="d">.</span></span></div>
<h1>Your video, in any language, in your own voice.</h1>
<p>Cloned voice · lip-timed lines · the speaker's tone · subtitles burned in</p>
</body></html>`);
await page.setViewportSize({ width: 1200, height: 630 });
await page.goto("file://" + card, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(OUT, "og-image.png") });
await b.close();
unlinkSync(card);
console.log("assets: favicon.svg favicon.ico icon-{16,32,48,180,192,512}.png og-image.png");
