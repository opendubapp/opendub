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

$("#voice").addEventListener("change", () => {
  $("#keywrap").hidden = $("#voice").value !== "higgs";
});

// --- the file ---------------------------------------------------------------

let file = null;
(async () => {
  if (!src) { $("#note").textContent = "No video was passed to this page."; return; }
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
  const free = $("#voice").querySelector('option[value="local"]');
  if (!status) {
    free.textContent = "The app on this computer — not running";
    free.disabled = true;
    $("#voice").value = "higgs";
    $("#keywrap").hidden = false;
    $("#note").textContent += " Start OpenDub on this computer for the free voice, or use a key.";
  }
}

// --- running it -------------------------------------------------------------

const stages = $("#stages");
function paint(job) {
  stages.replaceChildren(...STAGES.map((s) => {
    const li = document.createElement("li");
    li.textContent = s.label || s.key;
    const state = job.stages[s.key]?.status;
    li.className = state === "done" ? "done" : job.stage === s.key ? "doing" : "";
    return li;
  }));
  $("#log").textContent = job.log.slice(-40).map((l) => `${l.t.toFixed(1)}s  ${l.msg}`).join("\n");
}

$("#start").addEventListener("click", async () => {
  $("#start").disabled = true;
  $("#progress").hidden = false;
  const provider = $("#voice").value;
  const done = await dub(file, {
    target: $("#to").value,
    source: $("#from").value,
    provider,
    engine: "omnivoice",
    exactDuration: provider === "local",
    key: $("#key").value.trim(),
    translateKey: provider === "higgs" ? $("#key").value.trim() : null,
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
