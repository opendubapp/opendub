// The page and this pipeline ship separately, so the page may be older.
//   node tests/provider-names.mjs
//
// The free voice used to be asked for as "omnivoice" and is now "local". A
// bundle that knows only the new name sends the request to the paid provider
// instead, which takes whatever is in the key box and answers "the key was
// refused" — to someone who chose the free voice. That is exactly what the
// live site did once the bundle was deployed without the page.
import { chooseProvider } from "../browser/src/pipeline.js";

const checks = [];
const check = (n, ok, d = "") => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

const id = (provider) => chooseProvider({ provider, key: "not-a-key", engine: "omnivoice" }).id;

check('the name the live page sends, "omnivoice", is the free voice', id("omnivoice") === "local", id("omnivoice"));
check('the name this repository uses, "local", is the free voice', id("local") === "local", id("local"));
check("a paid choice is still the paid one", id("higgs") === "higgs", id("higgs"));
check("and the other paid one too", id("elevenlabs") === "elevenlabs", id("elevenlabs"));

// Whatever a future page sends, it must not silently become something that
// spends money or demands a key.
const unknown = id("some-future-name");
check("an unknown name does not quietly become a free local run", unknown !== "local", unknown);

const bad = checks.filter((c) => !c).length;
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
