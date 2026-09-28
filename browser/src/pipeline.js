// The whole dub, in the visitor's tab. Same seven stages as the local app, so
// the page's progress and result views render it unchanged.
import * as core from "./core.js";
import * as A from "./audio.js";
import { higgs, elevenlabs, local } from "./providers.js";
import { localTranslator } from "./translate-pairs.js";

export const STAGES = [
  ["probe", "Read the video"], ["separate", "Separate voice from music"], ["recognise", "Find speech and transcribe"],
  ["translate", "Translate and read the tone"], ["voice", "Clone the voice and speak"], ["mix", "Fit and mix the new voice"],
  ["render", "Subtitle and render"],
].map(([key, label]) => ({ key, label }));

const TOLERANCE = 1.15, MAX_SECONDS = 300;

/**
 * opts: { target, source ("auto"|code), provider ("higgs"|"elevenlabs"), key,
 *         translateKey (a Higgs key, for providers without a chat model),
 *         removeVoice, tone, burn, copyPicture }
 * emit(state): the job object the page renders, after every change.
 */
/**
 * Chrome will only start downloading a language pack while a click is still
 * fresh, and by the time we get here the video has been read, separated and
 * transcribed — half a minute after the press. So the page hands us a
 * translator it asked for during the click, and we use it when it matches the
 * language we actually heard. When it does not, creating one here works only
 * if the pack is already on the machine; if it is not, say what to do rather
 * than reporting the browser's own sentence about gestures.
 */
/** Is the browser's own translator actually going to work here? Asking costs
    one create() — cached by the browser — and saves a silent wait. */
async function usableBuiltIn(prepared, source, target, log) {
  try {
    await builtInTranslator(prepared, source, target, log);
    return true;
  } catch (e) {
    if (localTranslator(source, target.iso)) return false;   // ours will do it
    throw e;                                                 // nothing else can
  }
}

async function builtInTranslator(prepared, source, target, log) {
  if (prepared) {
    try {
      const tr = await prepared;
      if (tr && tr.sourceLanguage === source && tr.targetLanguage === target.iso) return tr;
    } catch { /* fall through and try for the language we actually heard */ }
  }
  try {
    // A create() that never settles is worse than one that fails: inside a
    // browser extension it simply hung, and the dub sat at step four for a
    // quarter of an hour saying nothing. Give it a minute, then move on.
    return await Promise.race([
      self.Translator.create({ sourceLanguage: source, targetLanguage: target.iso }),
      new Promise((_, no) => setTimeout(() => no(new Error("the browser's translator did not answer")), 60000)),
    ]);
  } catch (e) {
    if (/did not answer/.test(String(e && e.message))) {
      log("This browser's translator did not answer; translating here instead");
      throw e;                       // the caller falls back to a model of ours
    }
    if (/gesture/i.test(String(e && e.message))) {
      const name = core.language(source)?.name || source;
      log(`Chrome has no ${name} → ${target.name} pack yet`);
      throw new Error(`Chrome needs to download its ${name} → ${target.name} translation pack, and it will only start that from a click. Set “Spoken in” to ${name} and press Dub again, or add a Higgs key to translate instead.`);
    }
    throw e;
  }
}

export async function dub(file, opts, emit) {
  const created = Date.now() / 1000;
  const job = { id: "browser", filename: file.name, status: "running", stage: "", stage_progress: 0, stages: {}, log: [], created, options: opts, result: null };
  const log = (msg) => { job.log.push({ t: +(Date.now() / 1000 - created).toFixed(1), msg }); emit(job); };
  let t0 = 0;
  const begin = (k) => { job.stage = k; job.stage_progress = 0; job.stages[k] = { status: "running" }; t0 = performance.now(); emit(job); };
  const progress = (f, note) => { job.stage_progress = Math.max(0, Math.min(1, f || 0)); if (note) job.note = note; emit(job); };
  const end = (k) => { job.stages[k] = { status: "done", seconds: +((performance.now() - t0) / 1000).toFixed(1) }; emit(job); };

  const target = core.language(opts.target);
  const provider = opts.provider === "elevenlabs" ? elevenlabs(opts.key)
    : opts.provider === "local" ? local(opts.engine, !!opts.exactDuration, opts.engineName) : higgs(opts.key);
  const chatter = provider.hasChat ? provider : opts.translateKey ? higgs(opts.translateKey) : null;
  let voice = null;
  try {
    // 1 — read
    begin("probe");
    const info = await A.probe(file);
    if (info.duration > MAX_SECONDS) throw new Error(`This video is ${Math.round(info.duration)} s long. In the browser, OpenDub dubs up to ${MAX_SECONDS / 60} minutes; for longer videos run it on your machine.`);
    const [L, R] = await A.decodeStereo(file);
    log(`${info.width}×${info.height}, ${info.duration.toFixed(1)} s`);
    end("probe");

    // 2 — separate (optional, on this device)
    begin("separate");
    let vocals = [L, R], background = null;
    if (opts.removeVoice) {
      const { separate } = await import("./separate.js");
      ({ vocals, background } = await separate(L, R, { onProgress: progress }));
      log("The voice was separated from the music on this device");
    } else log("Keeping the original soundtrack; its voice will be turned down under the dub");
    const voiceMono = A.mono(vocals[0], vocals[1]);
    end("separate");

    // 3 — transcribe, with timing
    begin("recognise");
    const mono16k = await A.resample(voiceMono, A.SR, 16000);
    const lang = opts.source === "auto" ? null : core.language(opts.source).iso;
    let words;
    if (provider.wordTimestamps) {
      const r = await provider.transcribe(A.wav(mono16k, 16000), lang);
      words = r.words.length ? r.words : core.wordsFromSegments([{ text: r.text, start: 0, end: info.duration }]);
      log(`${provider.name} heard ${words.length} words`);
    } else if (!provider.transcribe) {
      // The free route: Whisper in this tab writes the words and times them.
      const { transcribe: whisper } = await import("./whisper.js");
      const segs = await whisper(mono16k, { language: lang, onProgress: progress });
      words = core.wordsFromSegments(segs);
      log(`Whisper in this tab heard ${segs.length} segments`);
    } else {
      const { transcribe: whisper } = await import("./whisper.js");
      const [heard, segs] = await Promise.all([
        provider.transcribe(A.wav(mono16k, 16000), lang),
        whisper(mono16k, { language: lang, onProgress: progress }),
      ]);
      words = core.align(heard.text, core.wordsFromSegments(segs), 0, info.duration);
      log(`${provider.name} wrote the words; Whisper in this tab timed them (${segs.length} segments)`);
    }
    const segs = core.clean(core.segment(words));
    if (!segs.length) throw new Error("No speech was found in this video.");
    log(`${segs.length} lines`);
    end("recognise");

    // 4 — translate and read the tone
    begin("translate");
    const sourceName = lang ? core.language(lang).name : "the original language";
    let texts;
    if (chatter) {
      texts = await translateWithChat(chatter, segs, target, sourceName, log);
    } else if ("Translator" in self && await usableBuiltIn(opts.translator, lang || "en", target, log)) {
      const tr = await builtInTranslator(opts.translator, lang || "en", target, log);
      texts = []; for (const s of segs) texts.push(await tr.translate(s.text));
      log("Translated by this browser's built-in translator (no length budget)");
    } else if (localTranslator(lang || "en", target.iso)) {
      // Firefox has no translator of its own, so bring one: opus-mt in this
      // tab, downloaded once and cached by the browser.
      const { translateLocally } = await import("./translate-local.js");
      log(`Translating here with opus-mt (${lang || "en"} → ${target.iso}); the model downloads once`);
      texts = await translateLocally(segs.map((s) => s.text), lang || "en", target.iso,
                                     (f) => progress(f, "Translating on this device"));
      log("Translated on this device (no length budget)");
    } else {
      // A pair with no model here, in a browser with no translator of its own.
      const from = core.language(lang || "en")?.name || lang || "the spoken language";
      throw new Error(`Nothing on this device can translate ${from} → ${target.name}. Add a Higgs key, or use Chrome, whose built-in translator covers more pairs.`);
    }
    let tones = segs.map(() => null);
    if (opts.tone !== false && chatter && provider.id === "higgs") {
      try {
        const feats = A.measure(segs, voiceMono);
        const { system, user } = core.tonePrompt(segs, feats);
        const got = (await chatter.chat(system, user, 100 + 40 * segs.length)).lines || [];
        if (got.length === segs.length) tones = got.map((g) => ({ emotion: core.EMOTIONS.includes(g.emotion) ? g.emotion : "neutral", expressive: g.expressive || "normal", style: g.style || "none" }));
        const moods = [...new Set(tones.filter((t) => t && t.emotion !== "neutral").map((t) => t.emotion))];
        log(`Tone: ${moods.length ? moods.join(", ") : "neutral throughout"}`);
      } catch (e) { log(`Tone skipped: ${e.message}`); }
    }
    end("translate");

    // 5 — clone and speak, each line fitted to the speaker's own length
    begin("voice");
    const ref = pickReference(segs, info.duration);
    const refAudio = await A.resample(A.slice(voiceMono, A.SR, ref.start, ref.end), A.SR, 24000);
    voice = await provider.prepareVoice(A.wav(peakNormalize(refAudio), 24000), ref.text);
    provider.voice = voice;
    log(`Cloning from ${ref.start.toFixed(1)}–${ref.end.toFixed(1)} s`);
    const lines = segs.map((s, i) => ({ seg: s, text: texts[i], tone: tones[i], audio: null, notes: [], shortened: false }));
    let done = 0;
    // The app on this computer generates one line at a time; the cloud providers take three.
    await pool(lines, provider.id === "local" ? 1 : 3, async (line, i) => {
      await speakFitted(line, provider, chatter, target, lines, i);
      progress(++done / lines.length);
      log(`line ${i + 1}/${lines.length}: ${(line.audio.length / A.SR).toFixed(1)} s against the speaker's ${(line.seg.end - line.seg.start).toFixed(1)} s`);
    });
    end("voice");

    // 6 — place exactly on the speaker's span, and mix
    begin("mix");
    for (const l of lines) {
      const want = Math.max(0.3, l.seg.end - l.seg.start);
      l.tempo = l.audio.length / A.SR / want;
      l.audio = A.fitLength(A.stretch(l.audio, l.tempo), Math.round(want * A.SR));
      l.start = l.seg.start; l.end = l.seg.start + want;
    }
    const mixed = A.mix({ lines, background, original: [L, R], voiceRef: voiceMono, duration: info.duration });
    log(`Placed ${lines.length} lines on the speaker's own start and end`);
    end("mix");

    // 7 — subtitles and the video
    begin("render");
    const src = core.language(lang || "en");
    const lay = core.layout(info.width, info.height, target);
    const tgtCues = core.cues(lines.map((l) => ({ start: l.start, end: l.end, text: l.text })), target, lay.perLine);
    const srcCues = core.cues(segs.map((s) => ({ start: s.start, end: s.end, text: s.text })), src, src.cjk ? 20 : 42);
    const url = (data, type) => URL.createObjectURL(new Blob([data], { type }));
    const files = {
      subtitles: url(core.srt(tgtCues), "application/x-subrip"), subtitles_vtt: url(core.vtt(tgtCues), "text/vtt"),
      source_subtitles: url(core.srt(srcCues), "application/x-subrip"), source_subtitles_vtt: url(core.vtt(srcCues), "text/vtt"),
      audio: URL.createObjectURL(stereoWav(mixed.L, mixed.R)), reference: URL.createObjectURL(A.wav(refAudio, 24000)),
    };
    let videoBlob = null, extension = "mp4";
    if (info.hasVideo) {
      const { burnSupport, burnInBrowser } = await import("./lib/burn.ts");
      const support = await burnSupport(info.width, info.height);
      if (!support.ok) throw new Error(support.reason || "This browser cannot encode video. Chrome, Edge or Safari 16.4+ can.");
      const burned = await burnInBrowser({
        file, width: info.width, height: info.height, start: 0, end: null, audio: mixed.buffer,
        copyPicture: !!opts.copyPicture,
        ass: opts.burn === false ? core.ass([], info.width, info.height, lay, "sans-serif") : core.ass(tgtCues, info.width, info.height, lay, "sans-serif"),
        onProgress: (f, note) => progress(f, note),
      });
      videoBlob = burned.blob; extension = burned.extension;
    }
    files.video = videoBlob ? URL.createObjectURL(videoBlob) : files.audio;
    end("render");

    job.result = {
      duration: info.duration, width: info.width, height: info.height, target: target.code, target_name: target.name, target_endonym: target.endonym,
      source: src.code, source_name: lang ? src.name : "Original", source_endonym: lang ? src.endonym : "Original",
      transcript_source: provider.id, vad: [], removed: [], reference: { start: ref.start, end: ref.end, text: ref.text }, voice: "clone",
      version: Date.now(), extension, files, local: true,
      lines: lines.map((l, i) => ({
        id: i, src_start: +l.seg.start.toFixed(2), src_end: +l.seg.end.toFixed(2), start: +l.start.toFixed(2), end: +l.end.toFixed(2),
        slot: +(l.seg.end - l.seg.start).toFixed(2), source: l.seg.text, text: l.text, tone: l.tone, manual: null,
        tempo: +l.tempo.toFixed(2), similarity: null, shortened: l.shortened, attempts: 1, notes: l.notes,
      })),
    };
    job.source_file = URL.createObjectURL(file);
    job.status = "done"; job.stage = "";
    log(provider.id === "local"
      ? (opts.translateKey ? "Done. The voice was made on this computer; only the text went to Higgs, to be translated." : "Done. Nothing left this computer.")
      : `Done. Only speech clips and text left this device, sent to ${provider.name}.`);
    return job;
  } catch (e) {
    job.status = "error"; job.error = e.message || String(e);
    if (job.stage) job.stages[job.stage] = { status: "error" };
    log(`Failed: ${job.error}`);
    return job;
  } finally {
    await provider.releaseVoice?.(voice);
  }
}

async function translateWithChat(chat, segs, target, sourceName, log) {
  const out = [];
  for (let b = 0; b < segs.length; b += 40) {
    const batch = segs.slice(b, b + 40);
    const { system, user } = core.translationPrompt(batch, target, sourceName);
    let got = null;
    for (let a = 0; a < 3 && !got; a++) {
      try {
        const r = (await chat.chat(system, user, 200 + 120 * batch.length)).translations || [];
        // A count mismatch is a failure, not something to pad: every later line would play at the wrong time.
        if (r.length === batch.length && r.every(Boolean)) got = r.map(String);
        else log(`The translator returned ${r.length} of ${batch.length} lines; retrying`);
      } catch (e) { log(`Translation attempt ${a + 1} failed: ${e.message}`); }
    }
    if (!got) throw new Error("Translation failed three times.");
    out.push(...got);
  }
  log(`Translated ${out.length} lines into ${target.name}`);
  return out;
}

async function speakFitted(line, provider, chat, target, lines, i) {
  const want = Math.max(0.3, line.seg.end - line.seg.start);
  const speak = async () => A.trimSilence(await A.decodeBlob(await provider.speak(line.text, provider.voice, {
    tags: core.higgsTags(line.tone), speed: line.speed ?? 1, lang: target.iso, duration: want,
  })));
  line.audio = await speak();
  if (provider.exactDuration) return;  // generated at the speaker's length already
  const off = () => line.audio.length / A.SR / want;
  // Local engines have no speed control: without a translator to re-word the
  // line, the final stretch in the mix is all there is.
  const steps = provider.id === "local" ? (chat ? ["resize", "resize"] : []) : chat ? ["resize", "resize", "speed"] : ["speed"];
  for (const step of steps) {
    const r = off();
    if (want < 1 || (r >= 1 / TOLERANCE && r <= TOLERANCE)) break;
    const old = { text: line.text, audio: line.audio, tone: line.tone, speed: line.speed };
    if (step === "resize") {
      const n = core.countChars(line.text);
      const ctx = lines.slice(Math.max(0, i - 1), i + 2).map((l) => l.seg.text).join(" / ");
      const { system, user } = core.resizePrompt(line.seg.text, line.text, target, Math.max(2, Math.round(n / r)), ctx);
      let text;
      try { text = String((await chat.chat(system, user, 400)).text || "").trim(); } catch { continue; }
      const m = core.countChars(text);
      if (!text || text === line.text || !(r > 1 ? m < n : m > n)) continue;
      line.text = text; line.shortened = true;
    } else if (provider.id === "higgs") {
      line.tone = { ...(line.tone || {}), speed: r > 1 ? "fast" : "slow" };
    } else {
      line.speed = Math.min(1.2, Math.max(0.7, r));
    }
    try { line.audio = await speak(); } catch { Object.assign(line, old); break; }
    if (Math.abs(Math.log(off())) >= Math.abs(Math.log(r))) Object.assign(line, old);  // landed no closer
    else line.notes.push(`${step === "resize" ? "re-said" : "re-paced"} to fit the speaker's ${want.toFixed(1)} s`);
  }
}

/** The densest run of whole sentences 6–12 s long, to clone from. */
function pickReference(segs, duration) {
  let best = null, bestScore = -1;
  for (let i = 0; i < segs.length; i++) for (let j = i; j < segs.length; j++) {
    const span = segs[j].end - segs[i].start;
    if (span > 12) break;
    if (span < 6) continue;
    const speech = segs.slice(i, j + 1).reduce((a, s) => a + s.words.reduce((b, w) => b + (w.end - w.start), 0), 0);
    const score = speech / span - 0.01 * i;
    if (score > bestScore) { best = [i, j]; bestScore = score; }
  }
  if (!best) { let j = segs.length - 1; while (j > 0 && segs[j].end - segs[0].start > 12) j--; best = [0, j]; }
  const [i, j] = best;
  return { start: Math.max(0, segs[i].start - 0.05), end: Math.min(duration, segs[j].end + 0.1), text: segs.slice(i, j + 1).map((s) => s.text).join(" ") };
}

function peakNormalize(a) { let p = 0; for (const v of a) p = Math.max(p, Math.abs(v)); const k = p > 0 ? 0.9 / p : 1; return a.map((v) => v * k); }

function stereoWav(L, R) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 2, true); v.setUint32(24, A.SR, true); v.setUint32(28, A.SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 0x7fff, true); v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 0x7fff, true); }
  return new Blob([buf], { type: "audio/wav" });
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}
