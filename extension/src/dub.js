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
  $("#omni-status").textContent = "Not running. Start OpenDub on this computer, or use a key.";
  document.querySelector('input[name="voice"][value="higgs"]').checked = true;
  $("#keywrap").hidden = false;
}

// --- running it -------------------------------------------------------------

const stages = $("#stages");
function paint(job) {
  stages.replaceChildren(...STAGES.map((s) => {
    const li = document.createElement("li");
    li.textContent = s.label || s.key;
    const state = job.stages[s.key]?.status;
    li.className = state === "done" ? "done" : job.stage === s.key ? "doing" : "";
    // The step being worked on says what it is doing and how far along it is.
    // Without this the page is silent through a model download and minutes of
    // listening, and a slow step is indistinguishable from a stuck one — which
    // is what it was reported as.
    if (job.stage === s.key && (job.note || job.stage_progress)) {
      const pct = job.stage_progress > 0 ? ` ${Math.round(job.stage_progress * 100)}%` : "";
      const b = document.createElement("span");
      b.className = "doing-note";
      b.textContent = ` — ${job.note || "working"}${pct}`;
      li.append(b);
    }
    return li;
  }));
  $("#log").textContent = job.log.slice(-40).map((l) => `${l.t.toFixed(1)}s  ${l.msg}`).join("\n");
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
  $("#done").hidden = false;
  $("#player").src = done.result.files.video;
  $("#save").href = done.result.files.video;
  $("#save").download = `${name}.${done.result.target}.mp4`;
  $("#subs").href = done.result.files.subtitles;
  $("#subs").download = `${name}.${done.result.target}.srt`;
  $("#done").scrollIntoView({ behavior: "smooth" });
});
