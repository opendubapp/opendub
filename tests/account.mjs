// The account surface on the live site. Every check here is one that has
// failed silently in production elsewhere in the suite.
//   node tests/account.mjs https://opendub.app/
import { createRequire } from "node:module";

const require = createRequire(process.env.PLAYWRIGHT_FROM
  || "/Users/dariuskohsg/Downloads/sharing_folder/openapps/opencrowd/node_modules/");
const { chromium } = require("playwright");

const base = process.argv[2] || "https://opendub.app/";
const AUTH = "https://auth.opendub.app";
let failed = 0;
const ok = (m) => console.log("ok  ", m);
const fail = (m) => { console.error("FAIL", m); failed++; };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });

// The header control, on every page: present, top right.
for (const path of ["", "account", "privacy"]) {
  const p = await ctx.newPage();
  await p.goto(new URL(path, base).href);
  const r = await p.locator(".account-btn").boundingBox();
  r && r.x > 720 && r.y < 80 ? ok(`account icon top right on /${path}`) : fail(`account icon misplaced on /${path}: ${JSON.stringify(r)}`);
  await p.close();
}

const page = await ctx.newPage();
const calls = [];
page.on("request", (r) => calls.push(`${r.method()} ${r.url()}`));
await page.goto(new URL("account", base).href);
await page.waitForFunction(() => {
  const el = document.querySelector("openapps-login");
  return el?.shadowRoot && el.shadowRoot.textContent.includes("Sign in to OpenDub");
}, null, { timeout: 20_000 });
await page.waitForTimeout(2500);

const seen = await page.evaluate(() => {
  const roots = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot);
  const text = [document.body.innerText, ...roots.map((e) => e.shadowRoot.textContent)].join(" ");
  const login = document.querySelector("openapps-login").shadowRoot;
  return {
    text,
    mark: login.querySelector(".mark")?.textContent?.trim(),
    unreachable: /could not reach the server/i.test(text),
    buttons: [...login.querySelectorAll("button")].map((x) => x.textContent.trim()).filter(Boolean),
    signedInBlockHidden: document.getElementById("signed-in").hidden,
  };
});
seen.unreachable ? fail("account page cannot reach the server (CORS or down)") : ok("account page reaches auth.opendub.app");
/openapps/i.test(seen.text) ? fail("visible text names the platform") : ok("no visible text names the platform (shadow DOM included)");
seen.mark === "∿" ? ok(`panel mark is the product glyph (${seen.mark})`) : fail(`panel mark is ${JSON.stringify(seen.mark)}`);
seen.buttons.length ? ok(`sign-in methods offered: ${seen.buttons.join(" · ")}`) : fail("no sign-in buttons rendered");
seen.signedInBlockHidden ? ok("signed out: balance, buy and history are not mounted") : fail("signed-out page shows the signed-in block");
calls.some((c) => c.startsWith(`GET ${AUTH}/v1/auth/methods`)) ? ok("asked auth.opendub.app which sign-in methods exist") : fail("never asked the server for its methods");
calls.some((c) => /accounts\.openapps\.network|gateway\.openapps\.network/.test(c)) ? fail("the page called the platform's own hostname") : ok("no request named the platform's hostname");

// The return trip: a fresh load with a code in the fragment must attempt the exchange.
const back = await ctx.newPage();
const posts = [];
back.on("request", (r) => r.method() === "POST" && posts.push(r.url()));
await back.goto(new URL("account#code=not-a-real-code", base).href);
await back.waitForTimeout(4000);
posts.some((u) => u.startsWith(`${AUTH}/v1/auth/oidc/exchange`))
  ? ok("a return with #code= attempts POST /v1/auth/oidc/exchange") : fail(`no exchange attempted (posts: ${posts.join(", ") || "none"})`);

// The server side of the same flow.
const start = await back.request.get(`${AUTH}/v1/auth/oidc/google/start?return_to=${encodeURIComponent(new URL("account", base).href)}`, { maxRedirects: 0 });
start.status() === 307 ? ok("the server accepts /account as a return_to (307)") : fail(`return_to answered ${start.status()}`);
await b.close();
if (failed) { console.error(`${failed} failed`); process.exit(1); }
