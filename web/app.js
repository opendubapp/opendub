// OpenDub client: upload, poll, show, edit, re-dub. No framework — one page, three views.

import { t } from "/i18n.js";  // the card's own strings; the page itself is translated per locale

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const fmt = (t) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

const ICON = {
  pending: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>',
  running: '<svg class="spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>',
  done: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
};

let CFG = null;
let file = null;
let mode = "replace";
let job = null;          // latest job state from the server
let pollTimer = null;
let edits = {};          // line id -> edited text
let tones = {};          // line id -> edited tone
let timings = {};        // line id -> [start, end] dragged on the timeline, or null to snap back
let renderedVersion = null;
// No backend (the public site): the page shows a finished demo dub from static
// files under demo/, read-only, and explains how to run OpenDub yourself.
let STATIC = false;

// ---------------------------------------------------------------- boot

async function boot() {
  // The header's account control reflects the local session only (no round trip).
  try { if (localStorage.getItem("openapps.session")) document.querySelector(".account-btn")?.classList.add("is-signed-in"); } catch {}
  try {
    // The public build marks itself, so it never probes for a server it knows is absent.
    if (document.querySelector('meta[name="opendub-static"]')) throw new Error("static build");
    const r = await fetch("/api/config");
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error("no api");
    CFG = await r.json();
  } catch {
    STATIC = true;
    CFG = await (await fetch("demo/config.json")).json();
    document.documentElement.classList.add("is-static");
  }
  const remembered = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const src = $("#source"), tgt = $("#target");
  src.append(el("option", { value: "auto" }, "Detect automatically"));
  for (const l of CFG.languages) {
    const label = l.endonym === l.name ? l.name : `${l.endonym} — ${l.name}`;
    src.append(el("option", { value: l.code }, label));
    tgt.append(el("option", { value: l.code }, label));
  }
  // Free engines on this computer: installed ones offered, others shown and disabled.
  for (const e of CFG.engines || []) {
    if (e.id === "omnivoice" && $("#set-voice").querySelector('option[value="omnivoice"]')) $("#set-voice").querySelector('option[value="omnivoice"]').remove();
    $("#set-voice").append(el("option", { value: e.id, disabled: !e.ready },
      `Clone the speaker — ${e.name} (free${e.commercial ? "" : ", non-commercial"})${e.ready ? "" : " — not installed"}`));
  }
  for (const v of CFG.voices) $("#set-voice").append(el("option", { value: v.id }, v.label));
  for (const e of CFG.emotions) $("#set-tone").append(el("option", { value: e }, e === "neutral" ? "Neutral throughout" : `${e[0].toUpperCase()}${e.slice(1)} throughout`));
  for (const id of ["set-voice", "set-tone", "set-expressive", "set-pitch", "set-style"]) {
    const n = $(`#${id}`);
    n.value = remembered(`ov.${id}`, n.value);
    if (!n.value) n.selectedIndex = 0;
    n.addEventListener("change", () => { try { localStorage.setItem(`ov.${id}`, n.value); } catch {} summarise(); });
  }
  $("#set-normalize").addEventListener("change", summarise);
  summarise();
  src.value = remembered("ov.source", "auto");
  tgt.value = remembered("ov.target", CFG.default_target);
  for (const [n, k] of [[src, "ov.source"], [tgt, "ov.target"]]) {
    n.addEventListener("change", () => { try { localStorage.setItem(k, n.value); } catch {} });
  }
  wireNew();
  wireResult();
  // Two ways to dub, and which one is offered depends on whether this copy
  // has a key. The pipeline behind this page sends every step to Higgs —
  // listening, translating and speaking — so with no key it cannot run at
  // all, and telling someone to put a line in a .env file inside an
  // application bundle is not an answer. The one that runs in this page
  // needs nothing: it listens and translates here and borrows only the voice
  // from this computer, over the same origin, so no permission is asked for.
  const freeHere = STATIC || !CFG.has_key;
  if (freeHere) {
    if (STATIC) $("#view-local").hidden = false;
    else { $("#view-new").hidden = true; keyOffer(); }
    wireBrowserDub();
    const kept = await loadDub();
    if (kept) {
      try {
        job = kept;
        renderedVersion = null;
        renderResult();
        showKeptNote();
        show("result");
        return;
      } catch (e) {
        // Kept by an older build, or half-written: show the demo rather than a
        // broken page, and stop offering something we cannot render.
        job = null;
        await clearDub();
      }
    }
    if (STATIC) await poll("demo");     // the finished example; the app has none
    return;
  }
  loadRecent();
  const id = new URLSearchParams(location.hash.slice(1)).get("job");
  if (id) openJob(id);
}

/**
 * A place to put a Higgs key, for people who have one.
 *
 * Without a key this copy dubs in the page, free, which is the usual case and
 * needs nothing. With one it can use the pipeline behind this page instead:
 * better timing, tone, voice-over, burnt-in subtitles. That used to mean
 * finding a .env file inside the application and restarting; now it is a box.
 */
function keyOffer() {
  const card = el("div", { class: "panel key-offer" });
  const input = el("input", { type: "text", class: "oa-input", placeholder: "bai-…",
                              autocomplete: "off", spellcheck: "false" });
  const note = el("p", { class: "oa-caption" },
    "Optional. With a key this app also offers tone, voice-over and burnt-in subtitles, and does the listening and translating itself. It is saved on this computer only.");
  const save = el("button", { type: "button", class: "oa-btn oa-btn--md" }, "Save key");
  save.addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key) return;
    save.disabled = true; save.textContent = "Saving…";
    try {
      const body = new FormData();
      body.append("key", key);
      const r = await fetch("/api/local/key", { method: "POST", body });
      if (!r.ok) throw new Error((await r.json()).detail || `${r.status}`);
      location.reload();                       // comes back with the fuller pipeline
    } catch (e) {
      save.disabled = false; save.textContent = "Save key";
      note.textContent = `That key was not saved: ${e.message}`;
    }
  });
  card.append(el("h2", {}, "Have a Higgs key?"), note,
              el("div", { class: "row" }, input, save));
  $("#view-local").after(card);
  $("#view-local").hidden = true;
}

// ---------------------------------------------------------------- new dub

function wireNew() {
  const drop = $("#drop"), input = $("#file");
  input.addEventListener("change", () => input.files[0] && pick(input.files[0]));
  ["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("is-over"); }));
  drop.addEventListener("drop", (ev) => ev.dataTransfer.files[0] && pick(ev.dataTransfer.files[0]));
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  }));
  $("#start").addEventListener("click", start);
}

function pick(f) {
  file = f;
  $("#drop").classList.add("has-file");
  $("#drop-title").textContent = f.name;
  const mb = (f.size / 1048576).toFixed(1);
  $("#drop-sub").textContent = `${mb} MB — reading length…`;
  const v = document.createElement("video");
  v.preload = "metadata";
  v.src = URL.createObjectURL(f);
  v.onloadedmetadata = () => {
    $("#drop-sub").textContent = `${mb} MB · ${clock(v.duration)}${v.videoWidth ? ` · ${v.videoWidth}×${v.videoHeight}` : ""} — choose another to replace it`;
    URL.revokeObjectURL(v.src);
  };
  v.onerror = () => { $("#drop-sub").textContent = `${mb} MB`; };
  $("#start").disabled = !CFG.has_key;
}

async function start() {
  if (!file) return;
  const btn = $("#start");
  btn.disabled = true;
  btn.textContent = "Uploading…";
  const fd = new FormData();
  fd.append("file", file);
  fd.append("target", $("#target").value);
  fd.append("source", $("#source").value);
  fd.append("mode", mode);
  fd.append("burn_subtitles", $("#burn").checked);
  fd.append("qa", $("#qa").checked);
  fd.append("voice", $("#set-voice").value);
  fd.append("tone", $("#set-tone").value);
  fd.append("expressive", $("#set-expressive").value);
  fd.append("style", $("#set-style").value);
  fd.append("pitch", $("#set-pitch").value);
  fd.append("normalize", $("#set-normalize").checked);
  try {
    const r = await fetch("/api/jobs", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    const { id } = await r.json();
    location.hash = `job=${id}`;
    openJob(id);
  } catch (e) {
    $("#new-hint").textContent = `Upload failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Dub this video";
  }
}

// ---------------------------------------------------------------- job

function show(view) {
  $("#view-new").hidden = view !== "new";
  $("#view-run").hidden = view !== "run";
  $("#view-result").hidden = view !== "result";
}

async function openJob(id) {
  clearTimeout(pollTimer);
  renderedVersion = null;
  edits = {};
  tones = {};
  timings = {};
  await poll(id);
  document.getElementById("app").scrollIntoView({ behavior: "smooth" });
}

async function poll(id) {
  let r;
  try {
    r = await fetch(STATIC ? "demo/job.json" : `/api/jobs/${id}`);
  } catch {
    pollTimer = setTimeout(() => poll(id), 2000);
    return;
  }
  if (!r.ok) { show("new"); history.replaceState(null, "", location.pathname); return; }
  job = await r.json();
  const busy = job.status === "queued" || job.status === "running";
  if (busy || (job.status === "error" && !job.result)) {
    renderRun();
    show("run");
  } else if (job.result) {
    renderResult();
    show("result");
    if (job.status === "error") $("#res-eyebrow").textContent = `Re-dub failed: ${job.error}`;
  }
  if (busy) pollTimer = setTimeout(() => poll(id), 800);
  else if (!STATIC) loadRecent();
}

function renderRun() {
  const lang = CFG.languages.find((l) => l.code === job.options.target);
  $("#run-title").textContent = job.filename;
  $("#run-eyebrow").textContent = job.status === "error" ? "Failed"
    : job.status === "queued" ? "Waiting for the previous job" : `Dubbing into ${lang ? lang.name : job.options.target}`;
  const last = job.log.length ? job.log[job.log.length - 1].t : 0;
  $("#elapsed").textContent = clock(job.status === "running" ? Math.max(last, (Date.now() / 1000 - job.created)) : last);
  const ol = $("#stages");
  ol.replaceChildren(...CFG.stages.map((s) => {
    const st = job.stages[s.key] || {};
    const status = st.status || "pending";
    const li = el("li", { class: `stage is-${status}` });
    const icon = el("span", { class: "stage-icon" });
    icon.innerHTML = ICON[status] || ICON.pending;
    const note = status === "running" && job.stage === s.key && job.note ? ` — ${job.note}` : "";
    li.append(icon, el("span", { class: "stage-label" }, s.label + note),
      el("span", { class: "stage-time" }, st.seconds != null ? `${st.seconds.toFixed(1)}s` : ""));
    if (status === "running" && job.stage === s.key && job.stage_progress > 0) {
      const bar = el("span", { class: "stage-bar" }, el("i"));
      bar.firstChild.style.width = `${Math.round(job.stage_progress * 100)}%`;
      li.append(el("span"), bar);
    }
    return li;
  }));
  const pre = $("#log");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.textContent = job.log.map((l) => `${clock(l.t).padStart(5)}  ${l.msg}`).join("\n");
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  document.querySelector("#view-run .error-box")?.remove();
  if (job.status === "error") {
    $("#view-run").append(el("div", { class: "error-box" }, job.error || "Something went wrong.",
      " ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); resetNew(); } }, "Start again")));
  }
}

// ---------------------------------------------------------------- result

function fileUrl(name, download = false) {
  if (/^(blob|data):/.test(name)) return name;   // a dub made in this tab
  if (STATIC) return `demo/${name}`;
  return `/api/jobs/${job.id}/files/${name}?v=${job.result.version}${download ? "&download=1" : ""}`;
}

// ---------------------------------------------------------------- keeping a dub

// A dub made in this tab used to live only in memory: a reload, a Back or a
// closed tab threw it away and the page came back showing the demo. It now
// goes into the browser's own file system (OPFS) — private to this site, on
// this device, never uploaded — and is restored on the next visit.
const DUB_DIR = "last-dub";

async function dubDir(create = false) {
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DUB_DIR, { create });
  } catch { return null; }
}

/** Save the finished dub and everything the result view needs to show it. */
async function saveDub(j) {
  const dir = await dubDir(true);
  if (!dir) return false;
  const R = j.result;
  const saved = { ...R, files: { ...R.files } };
  const put = async (key, url) => {
    if (!url || !/^blob:/.test(url)) return url;
    const blob = await (await fetch(url)).blob();
    const name = `${key}${blob.type.includes("mp4") ? ".mp4" : blob.type.includes("wav") ? ".wav" : ".bin"}`;
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return name;                       // the job.json refers to files, not blobs
  };
  try {
    for (const [k, v] of Object.entries(R.files)) saved.files[k] = await put(k, v);
    const source = await put("source", j.source_file);
    const meta = { filename: j.filename, created: j.created, options: j.options, source_file: source, result: saved };
    const mh = await dir.getFileHandle("job.json", { create: true });
    const mw = await mh.createWritable();
    await mw.write(new Blob([JSON.stringify(meta)], { type: "application/json" }));
    await mw.close();
    return true;
  } catch (e) {
    // Out of room, or a browser that will not keep it: the dub is still on
    // screen, so warn before leaving rather than pretending it is safe.
    await clearDub();
    return false;
  }
}

/** The dub from last time, with fresh blob URLs, or null. */
async function loadDub() {
  const dir = await dubDir();
  if (!dir) return null;
  try {
    const meta = JSON.parse(await (await (await dir.getFileHandle("job.json")).getFile()).text());
    const url = async (name) => {
      if (!name || /^(blob|data|https?):/.test(name)) return name;
      const f = await (await dir.getFileHandle(name)).getFile();
      return URL.createObjectURL(f);
    };
    const files = {};
    for (const [k, v] of Object.entries(meta.result.files)) files[k] = await url(v);
    return {
      id: "browser", status: "done", stage: "", stage_progress: 1, stages: {}, log: [],
      filename: meta.filename, created: meta.created, options: meta.options,
      source_file: await url(meta.source_file),
      result: { ...meta.result, files },
    };
  } catch { return null; }              // nothing kept, or half-written
}

/** Say where this came from, and offer to get rid of it. Someone who does not
    know it was kept would wonder why their video is on a page they just
    opened. */
function showKeptNote() {
  const eyebrow = $("#res-eyebrow");
  const note = el("span", { class: "kept-note" },
    " · ", t("Kept on this device."), " ",
    el("button", { type: "button", class: "kept-remove", onclick: forgetDub }, t("Remove")));
  eyebrow.append(note);
}

async function forgetDub() {
  await clearDub();
  location.reload();     // back to the demo, which is what the page shows without one
}

// The page is a module, so tests cannot reach these any other way. Keeping a
// dub is worth a real test — it is the difference between losing someone's
// video and not.
window.opendub = { saveDub, loadDub, clearDub };

async function clearDub() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(DUB_DIR, { recursive: true });
  } catch { /* nothing to remove */ }
}

/** A dub made in this tab exists only in memory: a reload, a Back or a closed
    tab throws it away, and the page comes back showing the demo. Ask before
    that happens, and stop asking once it has been saved. */
let unsavedDub = false;
const warnBeforeLeaving = (e) => { e.preventDefault(); e.returnValue = ""; };
function guardDub(on) {
  if (on === unsavedDub) return;
  unsavedDub = on;
  if (on) window.addEventListener("beforeunload", warnBeforeLeaving);
  else window.removeEventListener("beforeunload", warnBeforeLeaving);
}

/** What a saved file should be called, or null when the server names it. */
function downloadName(R, name) {
  const stem = (job.filename || "video").replace(/\.[^.]+$/, "");
  const F = R.files;
  const names = {
    [F.video]: `${stem}.${R.target}.${R.extension || "mp4"}`,
    [F.audio]: `${stem}.${R.target}.wav`,
    [F.subtitles]: `${stem}.${R.target}.srt`,
    [F.source_subtitles]: `${stem}.${R.source}.srt`,
    [F.reference]: `${stem}.voice-sample.wav`,
  };
  if (/^(blob|data):/.test(name)) return names[name] || `${stem}.${R.target}.mp4`;
  return STATIC ? (R.local ? names[name] : name) : null;
}

function renderResult() {
  const R = job.result;
  const lang = CFG.languages.find((l) => l.code === R.target);
  $("#res-eyebrow").textContent = R.local ? `Dubbed into ${R.target_name}, on this device` : `Dubbed into ${R.target_name}`;
  $("#res-title").textContent = job.filename;
  $("#dub-lang").textContent = R.target_endonym || (lang ? lang.endonym : R.target);
  $("#src-lang").textContent = R.source_endonym || R.source;
  // A dub made in this tab is a blob: URL, and a link to one without a
  // download attribute navigates the tab to a bare video player instead of
  // saving anything — and pressing Back then reloads the page and loses the
  // dub, which is only in memory. The attribute is what makes it save.
  const dl = $("#dl-video");
  dl.href = fileUrl(R.files.video, true);
  const saveAs = downloadName(R, R.files.video);
  if (saveAs) dl.download = saveAs; else dl.removeAttribute("download");
  guardDub(/^blob:/.test(R.files.video));
  dl.onclick = () => guardDub(false);   // saved: nothing left to lose

  if (renderedVersion !== R.version) {
    renderedVersion = R.version;
    const portrait = R.height > R.width;
    $("#players").classList.toggle("is-portrait", portrait);
    const vs = $("#v-src"), vd = $("#v-dub");
    const t = vd.currentTime || 0;
    vs.src = /^blob:/.test(job.source_file) ? job.source_file
      : STATIC ? `demo/${job.source_file}` : `/api/jobs/${job.id}/files/${job.source_file}`;
    vs.replaceChildren(el("track", { kind: "subtitles", srclang: R.source, label: R.source_name || R.source, default: true, src: fileUrl(R.files.source_subtitles_vtt) }));
    vd.src = fileUrl(R.files.video);
    if (t) vd.addEventListener("loadedmetadata", () => { vd.currentTime = t; }, { once: true });
    edits = {};
    tones = {};
    timings = {};
    renderLines();
    renderStats();
    renderDownloads();
  }
  renderTimeline();
  updateRedubBar();
}

function renderStats() {
  const R = job.result, L = R.lines;
  const heard = L.filter((l) => l.similarity != null);
  const avg = heard.length ? heard.reduce((a, l) => a + l.similarity, 0) / heard.length : null;
  const stretched = L.filter((l) => Math.abs(l.tempo - 1) > 0.01);
  // How far each dubbed line ends from where the speaker stopped.
  const drift = L.reduce((a, l) => a + Math.abs(l.end - l.src_end), 0) / Math.max(1, L.length);
  const total = Object.values(job.stages).reduce((a, s) => a + (s.seconds || 0), 0);
  const stat = (b, s) => el("div", { class: "stat" }, el("b", {}, b), el("span", {}, s));
  $("#stats").replaceChildren(
    stat(String(L.length), "lines dubbed"),
    stat(avg == null ? "—" : `${Math.round(avg * 100)}%`, avg == null ? "heard back: not checked in the browser" : "heard back correctly"),
    stat(`±${drift.toFixed(2)}s`, `average gap between the dub and the speaker finishing a line`),
    stat(clock(total), `to dub ${clock(R.duration)} of video${stretched.length ? ` · ${stretched.length} lines stretched` : ""}`),
  );
}

function renderTimeline() {
  const R = job.result, D = R.duration || 1;
  const pct = (t) => `${(100 * t / D).toFixed(3)}%`;
  const box = (s, e, cls, title, onclick) => {
    const n = el("span", { class: cls || "", title, onclick });
    n.style.left = pct(s);
    n.style.width = pct(Math.max(0.05, e - s));
    return n;
  };
  const seek = (t) => () => { $("#v-dub").currentTime = t; $("#v-src").currentTime = t; };
  const vad = (R.vad || []).length ? el("div", { class: "tl-row tl-vad", title: "Speech found by Silero VAD" },
    R.vad.map(([s, e]) => box(s, e, "", `speech ${fmt(s)}–${fmt(e)}`))) : null;
  const src = el("div", { class: "tl-row tl-src" },
    R.lines.map((l) => box(l.src_start, l.src_end, "", l.source, seek(l.src_start))));
  const dub = el("div", { class: "tl-row tl-dub" });
  for (const l of R.lines) {
    const span = timings[l.id] !== undefined ? (timings[l.id] || [l.src_start, l.src_end]) : [l.start, l.end];
    const cls = [Math.abs(l.tempo - 1) > 0.1 ? "fast" : "", l.manual || timings[l.id] ? "manual" : ""].join(" ").trim();
    const b = box(span[0], span[1], cls, `${l.text}${Math.abs(l.tempo - 1) > 0.01 ? ` (${l.tempo}×)` : ""}`);
    b.dataset.id = l.id;
    if (!STATIC) draggable(b, l, dub, D);
    else b.addEventListener("click", seek(l.start));
    dub.append(b);
  }
  const head = el("i", { class: "tl-head", id: "tl-head" });
  $("#timeline").replaceChildren(...[vad, src, dub, head].filter(Boolean));
}

// Drag a dubbed block to move it; drag an edge to change its length. The take
// can only be stretched so far (the server allows 0.6–1.8×), so the drag stops there.
function draggable(b, l, row, D) {
  const takeLen = (l.end - l.start) * l.tempo;
  // Neighbours bound the drag, so moving one line never pushes another off its speaker.
  const spanOf = (k) => {
    const o = job.result.lines[k];
    if (!o) return null;
    return timings[k] !== undefined ? (timings[k] || [o.src_start, o.src_end]) : [o.start, o.end];
  };
  const minLen = Math.max(0.3, takeLen / 1.8), maxLen = takeLen / 0.6;
  let drag = null;
  b.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const r = b.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const edge = Math.min(10, r.width / 4);
    const cur = timings[l.id] || (timings[l.id] === null ? [l.src_start, l.src_end] : [l.start, l.end]);
    const prev = spanOf(l.id - 1), next = spanOf(l.id + 1);
    drag = { mode: x < edge ? "l" : x > r.width - edge ? "r" : "move", x0: ev.clientX, s0: cur[0], e0: cur[1], moved: false,
             lo: prev ? prev[1] + 0.05 : 0, hi: next ? next[0] - 0.05 : D,
             pxPerSec: row.getBoundingClientRect().width / D };
    b.setPointerCapture(ev.pointerId);
    b.classList.add("is-dragging");
    ev.preventDefault();
  });
  b.addEventListener("pointermove", (ev) => {
    if (!drag) {
      const r = b.getBoundingClientRect(), x = ev.clientX - r.left, edge = Math.min(10, r.width / 4);
      b.style.cursor = x < edge || x > r.width - edge ? "ew-resize" : "grab";
      return;
    }
    const dt = (ev.clientX - drag.x0) / drag.pxPerSec;
    if (Math.abs(ev.clientX - drag.x0) > 3) drag.moved = true;
    let s = drag.s0, e = drag.e0;
    if (drag.mode === "move") {
      s = Math.min(Math.max(drag.lo, drag.s0 + dt), drag.hi - (drag.e0 - drag.s0));
      e = s + (drag.e0 - drag.s0);
    } else if (drag.mode === "l") {
      s = Math.min(Math.max(drag.lo, drag.s0 + dt, drag.e0 - maxLen), drag.e0 - minLen);
    } else {
      e = Math.max(Math.min(drag.hi, drag.e0 + dt, drag.s0 + maxLen), drag.s0 + minLen);
    }
    drag.s = s; drag.e = e;
    b.style.left = `${(100 * s / D).toFixed(3)}%`;
    b.style.width = `${(100 * (e - s) / D).toFixed(3)}%`;
    let tip = row.querySelector(".tl-tip");
    if (!tip) { tip = el("span", { class: "tl-tip" }); row.append(tip); }
    tip.style.left = `${(100 * (s + e) / 2 / D).toFixed(3)}%`;
    tip.textContent = `${fmt(s)} – ${fmt(e)} · ${(takeLen / (e - s)).toFixed(2)}×`;
  });
  const end = () => {
    if (!drag) return;
    b.classList.remove("is-dragging");
    row.querySelector(".tl-tip")?.remove();
    if (drag.moved && drag.s != null) {
      timings[l.id] = [+drag.s.toFixed(3), +drag.e.toFixed(3)];
      b.classList.add("manual");
      document.querySelector(`.line[data-id="${l.id}"]`)?.classList.add("is-edited");
      updateRedubBar();
    } else {
      $("#v-dub").currentTime = l.start;
      $("#v-src").currentTime = l.start;
    }
    drag = null;
  };
  b.addEventListener("pointerup", end);
  b.addEventListener("pointercancel", end);
  b.addEventListener("dblclick", () => {
    if (l.manual) timings[l.id] = null; else delete timings[l.id];
    renderTimeline();
    updateRedubBar();
  });
}

function summarise() {
  const v = $("#set-voice"), t = $("#set-tone");
  const parts = [v.value === "clone" ? "Cloned voice" : (CFG.engines || []).some((e) => e.id === v.value) ? `${(CFG.engines.find((e) => e.id === v.value)).name} clone (free)` : v.selectedOptions[0].textContent.split(" —")[0] + " (preset)",
    t.value === "auto" ? "tone matched per line" : t.selectedOptions[0].textContent.toLowerCase()];
  if ($("#set-expressive").value !== "auto") parts.push($("#set-expressive").selectedOptions[0].textContent.toLowerCase());
  if ($("#set-pitch").value !== "natural") parts.push(`${$("#set-pitch").selectedOptions[0].textContent.toLowerCase()} pitch`);
  if ($("#set-style").value !== "auto") parts.push($("#set-style").selectedOptions[0].textContent.toLowerCase());
  $("#more-summary").textContent = parts.join(" · ");
}

function chipsFor(l) {
  const out = [];
  if (l.similarity != null) {
    const p = Math.round(l.similarity * 100);
    out.push(el("span", { class: `chip ${p >= 90 ? "chip--good" : p >= 72 ? "chip--warn" : "chip--bad"}`, title: "Higgs STT transcribed the dubbed clip back; this is how closely it matched" }, `heard ${p}%`));
  }
  if (Math.abs(l.tempo - 1) > 0.03) out.push(el("span", { class: `chip ${l.tempo > 1.2 || l.tempo < 0.88 ? "chip--warn" : ""}`, title: l.tempo > 1 ? "Sped up to match the speaker's length" : "Slowed to match the speaker's length" }, `${l.tempo > 1 ? "faster" : "slower"} ${l.tempo.toFixed(2)}×`));
  if (l.shortened) out.push(el("span", { class: "chip", title: l.notes.join("\n") }, "re-said to fit"));
  if (l.notes.some((n) => n.startsWith("edited") || n.startsWith("tone changed"))) out.push(el("span", { class: "chip" }, "edited"));
  if (l.manual) out.push(el("span", { class: "chip", title: "Placed by hand on the timeline" }, "placed by hand"));
  if (l.notes.some((n) => n.startsWith("overruns"))) out.push(el("span", { class: "chip chip--warn", title: l.notes.join("\n") }, "overlaps next"));
  return out;
}

function renderLines() {
  const R = job.result;
  $("#lines").replaceChildren(...R.lines.map((l) => {
    const ta = el("textarea", { rows: 1, "aria-label": `Translation of line ${l.id + 1}`, lang: R.target, readonly: STATIC });
    ta.value = l.text;
    const mark = () => { li.classList.toggle("is-edited", l.id in edits || l.id in tones); updateRedubBar(); };
    ta.addEventListener("input", () => {
      if (ta.value.trim() && ta.value !== l.text) edits[l.id] = ta.value;
      else delete edits[l.id];
      mark();
    });
    const was = (l.tone && l.tone.emotion) || "neutral";
    const sel = el("select", { class: `tone-select${was !== "neutral" ? " is-set" : ""}`, title: "How this line is delivered", "aria-label": `Tone of line ${l.id + 1}`, disabled: STATIC },
      CFG.emotions.map((e) => el("option", { value: e, selected: e === was }, e === "neutral" ? "neutral tone" : e)));
    sel.addEventListener("change", () => {
      if (sel.value !== was) tones[l.id] = { ...(l.tone || { expressive: "normal", style: "none" }), emotion: sel.value };
      else delete tones[l.id];
      sel.classList.toggle("is-set", sel.value !== "neutral");
      mark();
    });
    const time = el("button", { class: "line-time", title: "Play this line", onclick: () => {
      const v = $("#v-dub"); v.currentTime = l.start; v.play();
    } });
    time.innerHTML = ICON.play;
    time.append(fmt(l.start));
    const li = el("li", { class: "line", "data-id": l.id },
      time,
      el("div", { class: "line-src", lang: R.source }, l.source),
      el("div", { class: "line-dub" }, ta),
      el("div", { class: "line-meta" }, sel, chipsFor(l)));
    return li;
  }));
}

function renderDownloads() {
  const R = job.result, F = R.files;
  const lang = CFG.languages.find((l) => l.code === R.target);
  const a = (name, label) => el("a", { class: "oa-btn oa-btn--secondary oa-btn--sm", href: fileUrl(name, true),
    download: downloadName(R, name) }, label);
  // filter(Boolean): replaceChildren turns a null into the text "null", so a
  // dub with no separate audio track printed a bare null between the buttons.
  $("#downloads").replaceChildren(...[
    a(F.video, "Dubbed video (MP4)"),
    F.audio && a(F.audio, "Dub audio (WAV)"),
    a(F.subtitles, `${R.target_endonym || R.target} subtitles (SRT)`),
    a(F.source_subtitles, `${R.source_endonym || R.source} subtitles (SRT)`),
    F.reference && a(F.reference, "Cloned voice sample"),
  ].filter(Boolean));
}

function updateRedubBar() {
  const n = new Set([...Object.keys(edits), ...Object.keys(tones), ...Object.keys(timings)]).size;
  $("#redub-bar").hidden = n === 0;
  $("#redub-count").textContent = `${n} line${n === 1 ? "" : "s"} edited`;
}

function wireResult() {
  const vs = $("#v-src"), vd = $("#v-dub");
  $("#stop-both").addEventListener("click", () => {
    vs.pause(); vd.pause();
    vs.currentTime = 0; vd.currentTime = 0;
  });
  $("#play-both").addEventListener("click", () => {
    vs.muted = true;
    vs.currentTime = vd.currentTime;
    Promise.all([vs.play(), vd.play()]).catch(() => {});
  });
  // Keep the muted original in step with the dub while both play.
  vd.addEventListener("pause", () => { if (!vs.paused) vs.pause(); });
  vd.addEventListener("seeked", () => { if (Math.abs(vs.currentTime - vd.currentTime) > 0.25) vs.currentTime = vd.currentTime; });
  vd.addEventListener("timeupdate", () => {
    if (!job?.result) return;
    const t = vd.currentTime;
    if (!vs.paused && Math.abs(vs.currentTime - t) > 0.3) vs.currentTime = t;
    const head = $("#tl-head");
    if (head) head.style.left = `calc(${(100 * t / job.result.duration).toFixed(3)}% )`;
    const cur = job.result.lines.find((l) => t >= l.start && t < l.end);
    document.querySelectorAll(".line").forEach((n) => n.classList.toggle("is-now", cur && +n.dataset.id === cur.id));
  });
  $("#new-dub").addEventListener("click", resetNew);
  $("#redub-reset").addEventListener("click", () => { edits = {}; tones = {}; timings = {}; renderLines(); renderTimeline(); updateRedubBar(); });
  $("#redub-go").addEventListener("click", async () => {
    const btn = $("#redub-go");
    btn.disabled = true;
    const r = await fetch(`/api/jobs/${job.id}/redub`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edits, tones, timings }),
    });
    btn.disabled = false;
    if (!r.ok) { alert((await r.json()).detail || "Re-dub failed"); return; }
    $("#v-dub").pause();
    poll(job.id);
  });
}

function resetNew() {
  if (STATIC) { renderedVersion = null; job = null; poll("demo"); return; }
  clearTimeout(pollTimer);
  job = null;
  history.replaceState(null, "", location.pathname);
  $("#v-src").pause(); $("#v-dub").pause();
  show("new");
}

async function loadRecent() {
  try {
    const jobs = await (await fetch("/api/jobs")).json();
    const done = jobs.filter((j) => j.status === "done" && (!job || j.id !== job.id)).slice(0, 6);
    $("#recent").hidden = done.length === 0;
    $("#recent-list").replaceChildren(...done.map((j) => el("li", {},
      el("a", { href: `#job=${j.id}`, onclick: (e) => { e.preventDefault(); location.hash = `job=${j.id}`; openJob(j.id); } },
        el("span", {}, j.filename), el("span", { class: "oa-caption" }, `${j.target} · ${new Date(j.created * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)))));
  } catch { /* the list is a convenience */ }
}

/** "Open the app" means the card in the hero, not the demo further down. */
function callToCard(ev) {
  const card = document.getElementById("dub-here");
  if (!card || card.hidden) return;            // another page: let the link navigate
  if (ev) ev.preventDefault();
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  const drop = document.getElementById("bdrop");
  if (!drop) return;
  drop.classList.add("is-called");             // so something visibly happens even at the top
  setTimeout(() => drop.classList.remove("is-called"), 1400);
}

// ---------------------------------------------------------------- dub here, in this tab (public site)

let bfile = null;
let bmodule = null;
const loadBrowser = () => (bmodule ??= import("/browser/opendub-browser.js"));

function wireBrowserDub() {
  const form = $("#dub-here");
  form.hidden = false;
  const src = $("#bsource"), tgt = $("#btarget");
  // The card is narrow: each language by its own name, the English one in the tooltip.
  src.append(el("option", { value: "auto" }, "Auto-detect"));
  for (const l of CFG.languages) {
    src.append(el("option", { value: l.code, title: l.name }, l.endonym));
    tgt.append(el("option", { value: l.code, title: l.name }, l.endonym));
  }
  tgt.value = CFG.default_target;

  const drop = $("#bdrop"), input = $("#bfile");
  const pick = (f) => {
    if (!f) return;
    bfile = f;
    drop.classList.add("has-file");
    $("#bdrop-title").textContent = f.name;
    $("#bdrop-sub").textContent = `${(f.size / 1048576).toFixed(1)} MB — stays on this device`;
    update();
  };
  input.addEventListener("change", () => pick(input.files[0]));
  ["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("is-over"); }));
  drop.addEventListener("drop", (ev) => pick(ev.dataTransfer.files[0]));

  const PROVIDER_NAME = { higgs: "Higgs Audio", elevenlabs: "ElevenLabs" };
  const PROVIDERS = {
    local: { free: true },
    higgs: { label: "Higgs Audio API key", note: "Used for this dub only and sent only to Boson AI. Never stored.", placeholder: "bai-…" },
    elevenlabs: { label: "ElevenLabs API key", note: "Used for this dub only and sent only to ElevenLabs. Never stored.", placeholder: "sk_…" },
  };
  const provider = () => form.querySelector('input[name="bprovider"]:checked').value;
  let omniReady = false;
  function update() {
    const id = provider(), p = PROVIDERS[id];
    $("#bkey-wrap").hidden = !!p.free;
    if (!p.free) {
      $("#bkey-label").textContent = p.label;
      $("#bkey-note").textContent = p.note;
      $("#bkey").placeholder = p.placeholder;
    }
    $("#btkey-field").hidden = id === "higgs";
    $("#btkey-note").textContent = id === "local"
      ? "The engines on your computer speak but do not translate. Without a Higgs key, Chrome's built-in translator is used where available — free, and on this device."
      : "ElevenLabs has no translation model. Without a Higgs key, translation runs in this tab — Chrome's own translator, or a model downloaded once.";
    updateStart();
  }

  // A dead button reads as a broken site: someone chose the free route without
  // the app running, clicked, and nothing happened. The button now always names
  // the step that is missing — and where that step is finding the app on this
  // computer, pressing it does exactly that.
  let encodes = true;
  function updateStart() {
    const btn = $("#bstart"), p = PROVIDERS[provider()];
    if (!encodes) return;  // the browser cannot make a video at all; that label stands
    const set = (action, label, disabled) => {
      btn.dataset.action = action;
      btn.textContent = label;
      btn.disabled = disabled;
    };
    if (p.free && !omniReady) return set("connect", "Look for the app on this computer", false);
    if (!p.free && !$("#bkey").value.trim()) return set("dub", `Enter your ${PROVIDER_NAME[provider()]} key above`, true);
    if (!bfile) return set("dub", "Choose a video first", true);
    set("dub", "Dub on this device", false);
  }

  // The free voice lives in the OpenDub app on this computer. The page only
  // looks for it when asked: probing localhost on load would put Chrome's
  // "access other apps on this device" prompt in front of every visitor, and
  // would contact an address outside the site for people who never chose it.
  // Once someone has connected, Chrome remembers the permission and so do we.
  const remember = (v) => { try { v ? localStorage.setItem("ov.omni", "1") : localStorage.removeItem("ov.omni"); } catch {} };
  async function detect() {
    const st = $("#bomni-status");
    st.className = "omni-status";
    // Chrome asks permission before a public page may reach 127.0.0.1, and the
    // prompt talks about "devices on your local network", which sounds like far
    // more than it is. Say what it means before it appears.
    st.replaceChildren(
      el("span", {}, t("Looking for the OpenDub app on this computer…")),
      el("span", { class: "oa-caption" }, t("Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.")));
    const startedAt = Date.now();
    const m = await loadBrowser();
    const s = await m.localAppStatus();
    engines = s?.engines || (s?.omnivoice ? [{ id: "omnivoice", name: "OmniVoice", ready: true, commercial: false, exact_duration: true, note: "" }] : []);
    omniReady = engines.some((e) => e.ready);
    remember(omniReady);
    // Under ~700 ms the whole thing flashes past and the card looks unchanged,
    // which is exactly how "I pressed it and nothing happened" is produced.
    const left = 700 - (Date.now() - startedAt);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    if (omniReady) {
      st.className = "omni-status is-ready";
      st.textContent = t("Connected to the OpenDub app on this computer.");
      form.querySelector('input[value="local"]').checked = true;
      fillEngines();
    } else {
      st.className = "omni-status is-missing";
      // The app was not there. Telling someone to run ./run.sh assumes they
      // already have OpenDub; most people asking for the free voice do not,
      // so hand them the one line that installs it and starts it.
      st.replaceChildren(s
        ? el("span", {}, t("The OpenDub app is running but OmniVoice is not installed: "),
            el("code", {}, ".venv/bin/pip install omnivoice"), ". ",
            el("button", { type: "button", onclick: detect }, t("connect again")), ".")
        : el("span", { class: "install-outcome" },
            el("b", {}, await blockedByBrowser()
              ? t("Your browser is blocking this page from reaching your computer. Allow it from the icon in the address bar, then press again.")
              : t("Nothing answered on this computer.")),
            installPanel()));
    }
    update();
  }
  /** Chrome refuses a public page's request to 127.0.0.1 until it is allowed,
      and a refusal looks exactly like nothing being installed. Tell them apart
      where the browser will say, and stay quiet where it will not. */
  async function blockedByBrowser() {
    try {
      const p = await navigator.permissions.query({ name: "local-network-access" });
      return p.state === "denied";
    } catch { return false; }
  }

  /** One line that installs the free voice and starts it, with a copy button. */
  function installPanel() {
    const cmd = "curl -fsSL https://opendub.app/install.sh | bash";
    const copy = el("button", { type: "button", class: "copy-btn" }, t("Copy"));
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        copy.textContent = t("Copied");
        setTimeout(() => { copy.textContent = t("Copy"); }, 1600);
      } catch {
        // Clipboard refused: select the line so it can still be copied by hand.
        const r = document.createRange();
        r.selectNodeContents(copy.previousElementSibling);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    });
    // A download beats a command for almost everyone, so the installer leads and
    // the one-liner stays for Linux and for people who would rather read it.
    const ua = navigator.userAgentData?.platform || navigator.platform || "";
    const mac = /mac/i.test(ua), win = /win/i.test(ua);
    const line = el("span", { class: "install-cmd", hidden: mac || win }, el("code", {}, cmd), copy);
    const kids = [];
    if (mac || win) {
      kids.push(el("a", { class: "oa-btn oa-btn--primary oa-btn--sm install-dl",
                          href: mac ? "/OpenDub.dmg" : "/OpenDub-setup.exe", download: "" },
                   t(mac ? "Download OpenDub for Mac" : "Download OpenDub for Windows")),
                el("span", { class: "oa-caption" }, t("Open it and press Install. No terminal, nothing to set up.")),
                el("button", { type: "button", class: "install-toggle",
                               onclick: () => { line.hidden = !line.hidden; } }, t("Or install it with one line")),
                line);
    } else {
      kids.push(el("b", {}, t("Install it in one line")), line);
    }
    return el("span", { class: "install" }, ...kids,
      el("span", { class: "oa-caption" }, t("About 2 GB, a few minutes. It all stays on this computer.")),
      el("span", { class: "oa-caption" }, t("When it finishes, press the button below.")),
      el("span", { class: "oa-caption" }, t("Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.")));
  }

  // Every engine the app knows, with its licence on the label; ones not installed
  // here are shown but greyed, so people see what exists and why it is unavailable.
  let engines = [];
  function fillEngines() {
    const sel = $("#bengine");
    const prev = sel.value || (() => { try { return localStorage.getItem("ov.engine"); } catch { return null; } })();
    sel.replaceChildren(...engines.map((e) => el("option", { value: e.id, disabled: !e.ready },
      `${e.name} · ${e.commercial ? "commercial use OK" : "non-commercial"}${e.ready ? "" : /NVIDIA/.test(e.hardware || "") ? " — needs an NVIDIA GPU" : " — not installed"}`)));
    const ready = engines.filter((e) => e.ready);
    sel.value = ready.some((e) => e.id === prev) ? prev : ready[0]?.id;
    $("#bengine-wrap").hidden = false;
    noteEngine();
  }
  function noteEngine() {
    const e = engines.find((x) => x.id === $("#bengine").value);
    $("#bengine-note").textContent = e ? `${e.note} Licence: ${e.licence}.` : "";
    try { localStorage.setItem("ov.engine", $("#bengine").value); } catch {}
  }
  $("#bengine").addEventListener("change", noteEngine);
  $("#bomni-connect").addEventListener("click", (e) => { e.preventDefault(); detect(); });
  form.querySelector('input[value="local"]').addEventListener("change", () => { if (!omniReady) detect(); });
  let remembered = false;
  try { remembered = localStorage.getItem("ov.omni") === "1"; } catch {}
  // Looking for the app is held back until someone asks for it, because the
  // first look is what makes the browser ask about the local network, and a
  // prompt nobody invited is a prompt people refuse. Once the browser has
  // already said yes there is no prompt left to cause, so there is nothing to
  // wait for: look straight away and let the card come up connected.
  // Served by the app itself, this page and the app are the same origin:
  // there is no prompt to cause and nothing to ask for, so never make
  // someone press a button to find the program that is serving them.
  if (remembered || !STATIC) detect();
  else (async () => {
    try {
      const p = await navigator.permissions.query({ name: "local-network-access" });
      if (p.state === "granted") detect();
    } catch { /* a browser that cannot be asked is left alone */ }
  })();
  update();
  form.addEventListener("change", update);
  $("#bkey").addEventListener("input", update);
  for (const a of document.querySelectorAll('a[href$="#app"]')) a.addEventListener("click", callToCard);
  if (location.hash === "#app") callToCard(null);

  // Offer on-device voice removal honestly: WebGPU makes it minutes, not tens of minutes.
  loadBrowser().then(async (m) => {
    const cap = await m.capabilities();
    if (!cap.encode) {
      encodes = false;
      $("#bstart").textContent = "This browser cannot encode video";
      $("#bstart").disabled = true;
      $("#bdrop-sub").textContent = "Dubbing here needs Chrome, Edge or Safari 16.4+.";
    }
    if (!cap.webgpu) $("#bremove-note").textContent = "This browser has no WebGPU, so removing the voice runs on the CPU and can take a long time. Downloads a 172 MB separator once.";
  }).catch(() => {});


  // Chrome only starts a language-pack download while a click is still fresh.
  // The pipeline needs the translator half a minute later, by which time the
  // press has expired, so ask for it here — inside the handler — and hand the
  // promise on. With "Auto-detect" we cannot know the language yet, so we ask
  // for English, which is what most uploads are; if the video turns out to be
  // something else the pipeline says so plainly.
  function prepareTranslator() {
    const p = provider();
    const needs = p !== "higgs" && !$("#btkey").value.trim();
    if (!needs || !("Translator" in window)) return null;
    const source = src.value === "auto" ? "en" : (CFG.languages.find((l) => l.code === src.value)?.iso || src.value);
    const targetIso = CFG.languages.find((l) => l.code === tgt.value)?.iso || tgt.value;
    if (source === targetIso) return null;
    try {
      return window.Translator.create({
        sourceLanguage: source,
        targetLanguage: targetIso,
        monitor: (m) => m.addEventListener("downloadprogress", (e) => {
          const pct = Math.round((e.loaded || 0) * 100);
          $("#bdrop-sub").textContent = t("Downloading the translation pack… {pct}%", { pct });
        }),
      });
    } catch { return null; }   // not available here; the pipeline will say so
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("#bstart");
    if (btn.dataset.action === "connect") return detect();
    if (!bfile) return;
    const translator = prepareTranslator();   // while the click still counts
    btn.disabled = true;
    const opts = {
      target: tgt.value, source: src.value, provider: provider(),
      engine: $("#bengine").value || "omnivoice",
      exactDuration: !!engines.find((e) => e.id === $("#bengine").value)?.exact_duration,
      engineName: engines.find((e) => e.id === $("#bengine").value)?.name,
      key: $("#bkey").value.trim(), translateKey: $("#btkey").value.trim() || null,
      removeVoice: $("#bremove").checked, tone: true, burn: true,
      translator,
    };
    const m = await loadBrowser();
    let first = true;
    const done = await m.dub(bfile, opts, (j) => {
      job = j;
      renderRun();
      show("run");
      if (first) { first = false; document.getElementById("app").scrollIntoView({ behavior: "smooth" }); }
    });
    updateStart();
    job = done;
    if (done.status === "done") {
      renderedVersion = null;
      renderResult();
      show("result");
      document.getElementById("app").scrollIntoView({ behavior: "smooth" });
      // Keep it, so a reload or a Back brings it back instead of the demo.
      if (await saveDub(done)) guardDub(false);
    } else {
      renderRun();
      show("run");
    }
  });
}

window.addEventListener("hashchange", () => {
  const id = new URLSearchParams(location.hash.slice(1)).get("job");
  if (id && (!job || job.id !== id)) openJob(id);
});

boot();
