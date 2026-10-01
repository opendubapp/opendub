// The dubbing page. It fetches the video the popup pointed at — extension
// pages may read hosts the user has granted, which is why the permission is
// asked for at that moment — and then runs the same pipeline the website
// runs, bundled here so nothing has to leave this machine.

import { dub, STAGES, LANGUAGES, capabilities, localAppStatus, singleThreaded } from "./browser/opendub-browser.js";

// Before anything loads a model: an extension page may not start a worker
// from a blob: URL, which is what the runtime's threaded build does.
await singleThreaded();

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const src = params.get("src");
const name = (params.get("name") || "video").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60);

$("#source").textContent = src ? new URL(src).host : "";

for (const l of LANGUAGES) {
  $("#from").append(new Option(l.endonym, l.code));
  $("#to").append(new Option(l.endonym, l.code));
}
$("#from").prepend(new Option("Auto-detect", "auto"));
$("#from").value = "auto";
$("#to").value = "zh-Hans";

// The voice is chosen the way the site chooses it: cards, not a dropdown.
const voice = () => document.querySelector('input[name="voice"]:checked')?.value || "local";
const freeRadio = () => document.querySelector('input[name="voice"][value="local"]');
for (const r of document.querySelectorAll('input[name="voice"]')) {
  r.addEventListener("change", () => { $("#keywrap").hidden = voice() !== "higgs"; });
}

// --- the file ---------------------------------------------------------------

let file = null;
(async () => {
  // Opened from the popup with nothing named: most sites build their video
  // in the page and there is no file to take, and dubbing one of your own
  // never needed the page anyway.
  if (!src) {
    $("#pick").hidden = false;
    $("#start").textContent = "Choose a video first";
    $("#note").textContent = "Nothing is uploaded: the video is read here, on this computer.";
    const drop = $("#pick");
    ["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("is-over"); }));
    drop.addEventListener("drop", (ev) => {
      const f = ev.dataTransfer?.files?.[0];
      if (f) { $("#pickfile").files = ev.dataTransfer.files; $("#pickfile").dispatchEvent(new Event("change")); }
    });
    $("#pickfile").addEventListener("change", async () => {
      const chosen = $("#pickfile").files[0];
      if (!chosen) return;
      file = chosen;
      // The label holds the file input: writing over its text would remove
      // the input and there would be no way to choose a different video.
      $("#pick").querySelector(".mini-drop-title").textContent = chosen.name;
      $("#pick").classList.add("has-file");
      $("#note").textContent = `${(chosen.size / 1048576).toFixed(1)} MB. It stays on this computer.`;
      $("#start").disabled = false;
      $("#start").textContent = "Dub it";
      await offerVoices();
    });
    return;
  }
  try {
    const res = await fetch(src, { credentials: "omit" });
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    const blob = await res.blob();
    file = new File([blob], `${name}.mp4`, { type: blob.type || "video/mp4" });
    $("#start").disabled = false;
    $("#start").textContent = "Dub it";
    $("#note").textContent = `${(file.size / 1048576).toFixed(1)} MB fetched. It stays on this computer.`;
    await offerVoices();
  } catch (e) {
    $("#note").textContent = `That video could not be fetched (${e.message}). Some sites only allow it from their own page.`;
  }
})();

/** Only offer the free voice when the app on this computer answers. */
async function offerVoices() {
  const cap = await capabilities();
  if (!cap.encode) {
    $("#start").disabled = true;
    $("#start").textContent = "This browser cannot make a video";
    return;
  }
  const status = await localAppStatus();
  const free = freeRadio();
  if (status) {
    $("#omni-status").textContent = "Connected to the OpenDub app on this computer.";
    return;
  }
  free.disabled = true;
  $("#omni").classList.add("is-unavailable");
  $("#omni-status").replaceChildren(
    document.createTextNode("Not running. "),
    startButton(),
    document.createTextNode(" on this computer, or use a key."));
  document.querySelector('input[name="voice"][value="higgs"]').checked = true;
  $("#keywrap").hidden = false;
}

/**
 * Ask the system to open the OpenDub app.
 *
 * A page cannot start a program — but it can ask for a scheme, and the app
 * registers opendub:// when it is installed. If nothing is installed nothing
 * happens and no error is raised either, so the only way to tell is to look
 * again afterwards: wait for the app to answer, and say where to get it when
 * it does not.
 */
function startButton() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "linklike";
  b.textContent = "Start OpenDub";
  b.addEventListener("click", async () => {
    b.disabled = true;
    const status = $("#omni-status");
    status.textContent = "Asking macOS to open OpenDub…";
    location.href = "opendub://start";
    for (let waited = 0; waited < 40; waited++) {
      await new Promise((ok) => setTimeout(ok, 1000));
      if (await localAppStatus()) {
        const free = freeRadio();
        free.disabled = false;
        free.checked = true;
        $("#omni").classList.remove("is-unavailable");
        status.textContent = "Connected to the OpenDub app on this computer.";
        $("#keywrap").hidden = true;
        return;
      }
      if (waited === 4) status.textContent = "Waiting for OpenDub to start…";
    }
    status.replaceChildren(
      document.createTextNode("OpenDub did not start. If it is not installed yet, get it from "),
      Object.assign(document.createElement("a"), { href: "https://opendub.app", target: "_blank", rel: "noreferrer", textContent: "opendub.app" }),
      document.createTextNode("."));
  });
  return b;
}

// --- running it -------------------------------------------------------------

const stages = $("#stages");
// The same stage rows, icons and log the site and the app show, so a dub
// looks the same wherever it is run from.
const ICON = {
  pending: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>',
  running: '<svg class="spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>',
  done: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>',
};
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function paint(job) {
  $("#run-title").textContent = job.filename || name;
  $("#run-eyebrow").textContent = job.status === "error" ? "Failed"
    : `Dubbing into ${LANGUAGES.find((l) => l.code === $("#to").value)?.name || $("#to").value}`;
  const last = job.log.length ? job.log[job.log.length - 1].t : 0;
  $("#elapsed").textContent = clock(last);
  stages.replaceChildren(...STAGES.map((s) => {
    const st = job.stages[s.key] || {};
    const status = st.status || "pending";
    const li = document.createElement("li");
    li.className = `stage is-${status}`;
    const icon = document.createElement("span");
    icon.className = "stage-icon";
    icon.innerHTML = ICON[status] || ICON.pending;
    const label = document.createElement("span");
    label.className = "stage-label";
    // The step being worked on says what it is doing and how far along it is.
    // Without this the page is silent through a model download and minutes of
    // listening, and a slow step is indistinguishable from a stuck one.
    const note = status === "running" && job.stage === s.key && job.note ? ` — ${job.note}` : "";
    label.textContent = (s.label || s.key) + note;
    const time = document.createElement("span");
    time.className = "stage-time";
    time.textContent = st.seconds != null ? `${st.seconds.toFixed(1)}s` : "";
    li.append(icon, label, time);
    if (status === "running" && job.stage === s.key && job.stage_progress > 0) {
      const bar = document.createElement("span");
      bar.className = "stage-bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.round(job.stage_progress * 100)}%`;
      bar.append(fill);
      li.append(document.createElement("span"), bar);
    }
    return li;
  }));
  const pre = $("#log");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.textContent = job.log.map((l) => `${clock(l.t).padStart(5)}  ${l.msg}`).join("\n");
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

$("#start").addEventListener("click", async () => {
  // The app is looked for once, when the page opens, and if it does not answer
  // then the free voice is taken away and the paid one put in its place. Start
  // the app a moment later and the page still believes it is not there — so
  // someone using the free voice presses Dub and is told their key was
  // refused, for a key they never meant to use. Look again here.
  const free = freeRadio();
  if (free.disabled && await localAppStatus()) {
    free.disabled = false;
    free.checked = true;
    $("#omni").classList.remove("is-unavailable");
    $("#omni-status").textContent = "Connected to the OpenDub app on this computer.";
    $("#keywrap").hidden = true;
  }
  const provider = voice();
  // An empty box sends an empty key, the server answers 401, and the page says
  // the key was refused — which reads as a broken key rather than a missing one.
  if (provider === "higgs" && !$("#key").value.trim()) {
    $("#note").textContent = "Add your key first, or install the app on this computer and use the free voice.";
    $("#key").focus();
    return;
  }
  $("#start").disabled = true;
  $("#progress").hidden = false;
  // The site moves from the form to the run view to the result. Leaving the
  // form on screen underneath is the thing that makes this page feel like a
  // different product.
  document.querySelector(".dub-card").hidden = true;
  const done = await dub(file, {
    target: $("#to").value,
    source: $("#from").value,
    provider,
    engine: "omnivoice",
    exactDuration: provider === "local",
    key: $("#key").value.trim(),
    translateKey: provider === "higgs" ? $("#key").value.trim() : null,
    removeVoice: $("#remove").checked,
    tone: true,
    // Subtitles cannot be burned in here: libass is Emscripten, and an
    // extension's content-security-policy refuses the `new Function` its glue
    // is built on. The picture is copied instead — quicker, and the subtitles
    // come as a file beside the video.
    burn: false,
    copyPicture: true,
  }, paint);

  if (done.status !== "done") {
    $("#log").textContent += `\n\n${done.error || "It did not finish."}`;
    $("#start").disabled = false;
    return;
  }
  const R = done.result;
  $("#done").hidden = false;
  $("#res-title").textContent = done.filename || name;
  $("#res-eyebrow").textContent = `Dubbed into ${R.target_name || R.target}`;
  $("#dub-lang").textContent = `${R.target_endonym || R.target_name || R.target} — from ${R.source_name || "the original"}`;
  $("#player").src = R.files.video;
  $("#save").href = R.files.video;
  $("#save").download = `${name}.${R.target}.mp4`;
  $("#subs").href = R.files.subtitles;
  $("#subs").download = `${name}.${R.target}.srt`;
  // The lines, as the site and the app show them. Read-only here for the same
  // reason they are read-only there for a dub made in a page: changing one
  // means making the dub again, and there is no job on a server to re-make.
  $("#lines").replaceChildren(...(R.lines || []).map((l) => {
    const li = document.createElement("li");
    li.className = "line";
    const when = document.createElement("span");
    when.className = "line-time mono";
    when.textContent = clock(l.start);
    const text = document.createElement("div");
    text.className = "line-text";
    text.lang = R.target;
    text.textContent = l.text;
    const src = document.createElement("div");
    src.className = "oa-caption";
    src.textContent = l.source;
    const body = document.createElement("div");
    body.append(text, src);
    li.append(when, body);
    return li;
  }));
  $("#lines-why").textContent = (R.lines || []).length
    ? "Editing a line and dubbing it again needs the pipeline in the OpenDub app, which uses a Higgs key."
    : "";
  $("#done").scrollIntoView({ behavior: "smooth" });
});
