// A GPU that cannot hold the model must not cost you the dub.
//   node tests/gpu-fallback.mjs [clip.mp4]
//
// WebGPU promises 128 MB for one binding and 256 MB for one buffer, and many
// adapters report exactly that. The speech model's decoder is about 150 MB. On
// the machine this was developed on the adapter reports 4096 MB, so the larger
// model looked safe; on an ordinary one the runtime spent twenty-three minutes
// and then failed inside its buffer manager, and the whole dub was lost.
//
// Here the adapter is made to report the standard limits. The dub must still
// finish — on the processor, slower, rather than not at all.
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

const ctx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "gpulim-")), {
  channel: "chromium", timeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal"],
});
const id = [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 15]).map((n) => "abcdefghijklmnop"[n]).join("");
const page = await ctx.newPage();

// An adapter with the limits the specification guarantees, and no more.
await page.addInitScript(() => {
  const real = navigator.gpu?.requestAdapter?.bind(navigator.gpu);
  if (!real) return;
  navigator.gpu.requestAdapter = async (...a) => {
    const ad = await real(...a);
    if (!ad) return ad;
    return new Proxy(ad, {
      get(t, k) {
        if (k === "limits") return new Proxy(t.limits, {
          get(l, n) {
            if (n === "maxStorageBufferBindingSize") return 134217728;   // 128 MB
            if (n === "maxBufferSize") return 268435456;                 // 256 MB
            const v = l[n];
            return typeof v === "function" ? v.bind(l) : v;
          },
        });
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  };
});

await page.goto(`chrome-extension://${id}/dub.html?src=${encodeURIComponent(`${origin}/clip.mp4`)}&name=clip`,
  { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !document.querySelector("#start").disabled, { timeout: 60000 });
check("the adapter now reports the standard limits",
  await page.evaluate(async () => (await navigator.gpu.requestAdapter()).limits.maxStorageBufferBindingSize === 134217728));

await page.selectOption("#voice", "local");
await page.selectOption("#from", "en");
await page.selectOption("#to", "zh-Hans");
await page.click("#start");

const started = Date.now();
let state = {};
while (Date.now() - started < Number(process.env.BUDGET || 1500) * 1000) {
  await page.waitForTimeout(4000);
  state = await page.evaluate(() => ({
    done: !document.querySelector("#done").hidden,
    log: document.querySelector("#log")?.textContent || "",
  }));
  if (state.done || /Failed:/.test(state.log)) break;
}
check("a dub finishes on a GPU that cannot hold the model", state.done,
  state.done ? "" : (state.log.split("\n").filter((l) => /Failed:/.test(l))[0] || "").slice(0, 140));
check("and it did not fail inside the GPU buffer manager",
  !/buffer_manager|MapAsyncStatus|OrtRun/.test(state.log),
  (state.log.split("\n").find((l) => /buffer_manager|OrtRun/.test(l)) || "no GPU error").slice(0, 90));

await ctx.close(); server.close();
const bad = checks.filter((c) => !c).length;
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
