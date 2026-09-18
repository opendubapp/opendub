// OpenVoice client: upload, poll, show, edit, re-dub. No framework — one page, three views.

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

// ---------------------------------------------------------------- boot

async function boot() {
  CFG = await (await fetch("/api/config")).json();
  const remembered = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const src = $("#source"), tgt = $("#target");
  src.append(el("option", { value: "auto" }, "Detect automatically"));
  for (const l of CFG.languages) {
    const label = l.endonym === l.name ? l.name : `${l.endonym} — ${l.name}`;
    src.append(el("option", { value: l.code }, label));
    tgt.append(el("option", { value: l.code }, label));
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
  $("#model-list").textContent = `${CFG.models.stt} · ${CFG.models.llm} · ${CFG.models.tts}`;
  if (!CFG.has_key) $("#new-hint").textContent = "The server has no BOSON_API_KEY — add it to .env and restart.";
  wireNew();
  wireResult();
  loadRecent();
  const id = new URLSearchParams(location.hash.slice(1)).get("job");
  if (id) openJob(id);
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
    r = await fetch(`/api/jobs/${id}`);
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
  else loadRecent();
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
    li.append(icon, el("span", { class: "stage-label" }, s.label),
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
  return `/api/jobs/${job.id}/files/${name}?v=${job.result.version}${download ? "&download=1" : ""}`;
}

function renderResult() {
  const R = job.result;
  const lang = CFG.languages.find((l) => l.code === R.target);
  $("#res-eyebrow").textContent = `Dubbed into ${R.target_name}`;
  $("#res-title").textContent = job.filename;
  $("#dub-lang").textContent = R.target_endonym || (lang ? lang.endonym : R.target);
  $("#src-lang").textContent = R.source_endonym || R.source;
  $("#dl-video").href = fileUrl(R.files.video, true);

  if (renderedVersion !== R.version) {
    renderedVersion = R.version;
    const portrait = R.height > R.width;
    $("#players").classList.toggle("is-portrait", portrait);
    const vs = $("#v-src"), vd = $("#v-dub");
    const t = vd.currentTime || 0;
    vs.src = `/api/jobs/${job.id}/files/${job.source_file}`;
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
    stat(avg == null ? "—" : `${Math.round(avg * 100)}%`, "heard back correctly"),
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
  const vad = el("div", { class: "tl-row tl-vad", title: "Speech found by Silero VAD" },
    R.vad.map(([s, e]) => box(s, e, "", `speech ${fmt(s)}–${fmt(e)}`)));
  const src = el("div", { class: "tl-row tl-src" },
    R.lines.map((l) => box(l.src_start, l.src_end, "", l.source, seek(l.src_start))));
  const dub = el("div", { class: "tl-row tl-dub" });
  for (const l of R.lines) {
    const span = timings[l.id] !== undefined ? (timings[l.id] || [l.src_start, l.src_end]) : [l.start, l.end];
    const cls = [Math.abs(l.tempo - 1) > 0.1 ? "fast" : "", l.manual || timings[l.id] ? "manual" : ""].join(" ").trim();
    const b = box(span[0], span[1], cls, `${l.text}${Math.abs(l.tempo - 1) > 0.01 ? ` (${l.tempo}×)` : ""}`);
    b.dataset.id = l.id;
    draggable(b, l, dub, D);
    dub.append(b);
  }
  const head = el("i", { class: "tl-head", id: "tl-head" });
  $("#timeline").replaceChildren(vad, src, dub, head);
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
  const parts = [v.value === "clone" ? "Cloned voice" : v.selectedOptions[0].textContent.split(" —")[0] + " (preset)",
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
    const ta = el("textarea", { rows: 1, "aria-label": `Translation of line ${l.id + 1}`, lang: R.target });
    ta.value = l.text;
    const mark = () => { li.classList.toggle("is-edited", l.id in edits || l.id in tones); updateRedubBar(); };
    ta.addEventListener("input", () => {
      if (ta.value.trim() && ta.value !== l.text) edits[l.id] = ta.value;
      else delete edits[l.id];
      mark();
    });
    const was = (l.tone && l.tone.emotion) || "neutral";
    const sel = el("select", { class: `tone-select${was !== "neutral" ? " is-set" : ""}`, title: "How this line is delivered", "aria-label": `Tone of line ${l.id + 1}` },
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
  const a = (name, label) => el("a", { class: "oa-btn oa-btn--secondary oa-btn--sm", href: fileUrl(name, true) }, label);
  $("#downloads").replaceChildren(
    a(F.video, "Dubbed video (MP4)"),
    a(F.audio, "Dub audio (WAV)"),
    a(F.subtitles, `${R.target_endonym || R.target} subtitles (SRT)`),
    a(F.source_subtitles, `${R.source_endonym || R.source} subtitles (SRT)`),
    a(F.reference, "Cloned voice sample"),
  );
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

window.addEventListener("hashchange", () => {
  const id = new URLSearchParams(location.hash.slice(1)).get("job");
  if (id && (!job || job.id !== id)) openJob(id);
});

boot();
