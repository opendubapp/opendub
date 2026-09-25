// Voice providers, called straight from the visitor's browser with the
// visitor's own key. The key lives in memory for one job: it is never stored,
// and it is sent only to the provider it belongs to (both allow browser CORS).
import { parseJson } from "./core.js";

/** One request start per `gap` ms across the whole tab, retrying 429/5xx. */
function pacer(gap) {
  let next = 0;
  return async function request(url, init, attempts = 8) {
    let backoff = 0, last = "";
    for (let a = 0; a < attempts; a++) {
      const now = Date.now(), at = Math.max(now, next) + backoff;
      next = at + gap;
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
      let r;
      try { r = await fetch(url, init); } catch (e) { last = String(e); r = null; }
      if (r?.ok) return r;
      if (r) {
        last = `${r.status} ${(await r.text()).slice(0, 200)}`;
        if (r.status === 401 || r.status === 403) throw new Error(`The key was refused (${r.status}). Check it and try again.`);
        if (/insufficient_quota|quota_exceeded/.test(last)) throw new Error("The account behind this key is out of credit.");
        if (r.status < 500 && ![408, 409, 429].includes(r.status)) throw new Error(`${new URL(url).pathname} failed: ${last}`);
      }
      backoff = Math.min(8000, 1000 * (a + 1));
    }
    throw new Error(`${new URL(url).pathname} failed after ${attempts} tries: ${last}`);
  };
}

// ------------------------------------------------------------------ Higgs Audio (Boson AI)

export function higgs(key) {
  const base = "https://api.boson.ai/v1", auth = { Authorization: `Bearer ${key}` };
  const request = pacer(1050);  // the hackathon key allows about one request a second
  return {
    id: "higgs",
    name: "Higgs Audio",
    hasChat: true,
    wordTimestamps: false,
    async transcribe(wavBlob, lang) {
      const f = new FormData();
      f.append("model", "higgs-stt-3.1"); f.append("response_format", "json"); f.append("file", wavBlob, "speech.wav");
      if (lang) f.append("language", lang);
      return { text: ((await (await request(`${base}/audio/transcriptions`, { method: "POST", headers: auth, body: f })).json()).text || "").trim() };
    },
    async chat(system, user, maxTokens = 4000) {
      const r = await request(`${base}/chat/completions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "higgs-realtime", messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.2 }) });
      return parseJson((await r.json()).choices[0].message.content || "");
    },
    async prepareVoice(refWav, refText) { return { refWav, refText }; },
    async releaseVoice() {},
    async speak(text, voice, { tags = "", lang } = {}) {
      const f = new FormData();
      f.append("model", "higgs-tts-3"); f.append("input", tags + text); f.append("response_format", "wav");
      if (lang) f.append("tn_language", lang);
      f.append("ref_audio", voice.refWav, "ref.wav"); if (voice.refText) f.append("ref_text", voice.refText);
      const r = await request(`${base}/audio/speech`, { method: "POST", headers: auth, body: f });
      if ((r.headers.get("content-type") || "").includes("json")) {
        const j = await r.json(); return new Blob([Uint8Array.from(atob(j.audio), (c) => c.charCodeAt(0))], { type: "audio/wav" });
      }
      return r.blob();
    },
  };
}

// ------------------------------------------------------------------ ElevenLabs (untested: no key yet)

export function elevenlabs(key) {
  const base = "https://api.elevenlabs.io/v1", auth = { "xi-api-key": key };
  const request = pacer(250);
  return {
    id: "elevenlabs",
    name: "ElevenLabs",
    hasChat: false,
    wordTimestamps: true,
    /** Scribe returns word-level timestamps, so no in-tab Whisper is needed for timing. */
    async transcribe(wavBlob, lang) {
      const f = new FormData();
      f.append("model_id", "scribe_v1"); f.append("file", wavBlob, "speech.wav"); f.append("timestamps_granularity", "word");
      if (lang) f.append("language_code", lang);
      const j = await (await request(`${base}/speech-to-text`, { method: "POST", headers: auth, body: f })).json();
      const words = (j.words || []).filter((w) => w.type === "word").map((w) => ({ text: w.text, start: w.start, end: w.end }));
      return { text: (j.text || "").trim(), words, language: j.language_code };
    },
    /** An instant voice clone from the reference clip, deleted again after the job. */
    async prepareVoice(refWav) {
      const f = new FormData();
      f.append("name", `OpenDub ${new Date().toISOString().slice(0, 16)}`); f.append("files", refWav, "reference.wav");
      f.append("description", "Temporary voice for one OpenDub job; deleted when the job ends.");
      const j = await (await request(`${base}/voices/add`, { method: "POST", headers: auth, body: f })).json();
      return { voiceId: j.voice_id };
    },
    async releaseVoice(voice) {
      if (voice?.voiceId) await fetch(`${base}/voices/${voice.voiceId}`, { method: "DELETE", headers: auth }).catch(() => {});
    },
    async speak(text, voice, { speed = 1, lang } = {}) {
      const r = await request(`${base}/text-to-speech/${voice.voiceId}?output_format=mp3_44100_128`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", ...(lang ? { language_code: lang } : {}),
          voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: Math.min(1.2, Math.max(0.7, speed)) } }),
      });
      return r.blob();
    },
  };
}

// ------------------------------------------------------------------ OmniVoice (free, on the visitor's computer)

/**
 * The free voice. OmniVoice is a PyTorch model and cannot run in a tab, so it
 * runs in the OpenDub app on the visitor's own computer (./run.sh), which this
 * page calls on localhost. No key, no account, nothing leaves the machine.
 */
export const LOCAL_APP = "http://127.0.0.1:8910";

export async function localAppStatus() {
  try {
    const r = await fetch(`${LOCAL_APP}/api/local/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** A free engine in the OpenDub app on this computer (OmniVoice, Chatterbox, CosyVoice 2, …). */
export function local(engine = "omnivoice", exactDuration = engine === "omnivoice", name = engine) {
  return {
    id: "local",
    engine,
    name,
    hasChat: false,
    wordTimestamps: false,
    exactDuration,
    transcribe: null,
    async prepareVoice(refWav, refText) { return { refWav, refText }; },
    async releaseVoice() {},
    async speak(text, voice, { duration, lang } = {}) {
      const f = new FormData();
      f.append("engine", engine);
      f.append("ref_audio", voice.refWav, "ref.wav");
      f.append("ref_text", voice.refText || "");
      if (lang) f.append("language", lang);
      f.append("lines", JSON.stringify([{ text, duration: duration || null }]));
      let r;
      try { r = await fetch(`${LOCAL_APP}/api/local/speak`, { method: "POST", body: f }); }
      catch { throw new Error("Lost the OpenDub app on this computer. Is it still running (./run.sh)?"); }
      if (!r.ok) throw new Error(`The OpenDub app could not speak: ${(await r.text()).slice(0, 200)}`);
      const { clips } = await r.json();
      return new Blob([Uint8Array.from(atob(clips[0]), (c) => c.charCodeAt(0))], { type: "audio/wav" });
    },
  };
}

/** Kept for callers that name OmniVoice directly. */
export const omnivoice = () => local("omnivoice", true, "OmniVoice");
