// Audio in the tab: decode, resample, WAV, trim, stretch, mix.
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";

export const SR = 44100;

/** Probe a video file: duration, display size, whether it has audio. */
export async function probe(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  if (!audio) throw new Error("This file has no audio track to dub.");
  const duration = await input.computeDuration();
  return { duration, width: video?.displayWidth ?? 1280, height: video?.displayHeight ?? 720, hasVideo: !!video };
}

/** The whole soundtrack as stereo Float32Arrays at 44.1 kHz. */
export async function decodeStereo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  const chunks = [];
  let rate = SR;
  for await (const { buffer } of new AudioBufferSink(track).buffers()) {
    rate = buffer.sampleRate;
    const l = buffer.getChannelData(0);
    const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
    chunks.push([l.slice(), r.slice()]);
  }
  const n = chunks.reduce((a, [l]) => a + l.length, 0);
  const L = new Float32Array(n), R = new Float32Array(n);
  let o = 0;
  for (const [l, r] of chunks) { L.set(l, o); R.set(r, o); o += l.length; }
  return rate === SR ? [L, R] : [await resample(L, rate, SR), await resample(R, rate, SR)];
}

export async function resample(samples, from, to) {
  if (from === to) return samples;
  const len = Math.ceil(samples.length * to / from);
  const ctx = new OfflineAudioContext(1, len, to);
  const buf = ctx.createBuffer(1, samples.length, from);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

export const mono = (L, R) => { const m = new Float32Array(L.length); for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i]); return m; };
export const slice = (a, sr, start, end) => a.subarray(Math.max(0, Math.floor(start * sr)), Math.min(a.length, Math.ceil(end * sr)));

/** 16-bit PCM WAV, which every provider accepts for cloning and transcription. */
export function wav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: "audio/wav" });
}

/** Decode whatever a provider sent back (wav/mp3) to mono Float32 at `sr`. */
export async function decodeBlob(blob, sr = SR) {
  const ctx = new OfflineAudioContext(1, 1, sr);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  return resample(buf.getChannelData(0).slice(), buf.sampleRate, sr);
}

/** Cut lead-in and tail so a clip's length is its speech, not its padding. */
export function trimSilence(a, sr = SR, floorDb = -42, pad = 0.04) {
  const win = Math.floor(sr * 0.01), n = Math.floor(a.length / win);
  if (!n) return a;
  const rms = new Float32Array(n);
  let max = 1e-12;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < win; j++) s += a[i * win + j] ** 2; rms[i] = Math.sqrt(s / win) + 1e-12; max = Math.max(max, rms[i]); }
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) if (20 * Math.log10(rms[i] / max) > floorDb) { if (first < 0) first = i; last = i; }
  if (first < 0) return a;
  return a.slice(Math.max(0, first * win - Math.floor(pad * sr)), Math.min(a.length, (last + 1) * win + Math.floor(pad * sr)));
}

/**
 * WSOLA time-stretch: change duration without changing pitch. tempo > 1 is
 * faster (shorter). Speech-sized frames; the overlap search finds the offset
 * whose waveform continues the previous frame best, which is what keeps it
 * from sounding phasey the way a plain overlap-add does.
 */
export function stretch(x, tempo, sr = SR) {
  if (Math.abs(tempo - 1) < 0.01 || x.length < sr * 0.1) return x;
  const N = Math.floor(sr * 0.03), Hs = N >> 1, Ha = Hs * tempo, tol = Math.floor(sr * 0.008);
  const outLen = Math.floor(x.length / tempo) + N;
  const y = new Float32Array(outLen), wsum = new Float32Array(outLen);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  let prev = 0;
  for (let k = 0, out = 0; ; k++, out += Hs) {
    const nominal = Math.round(k * Ha);
    if (nominal + N + tol >= x.length || out + N >= outLen) break;
    let best = nominal;
    if (k > 0) {
      let bestScore = -Infinity;
      const natural = prev + Hs;
      for (let d = -tol; d <= tol; d += 2) {
        const c = nominal + d; if (c < 0) continue;
        let s = 0; for (let i = 0; i < N; i += 4) s += x[c + i] * x[natural + i];
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }
    for (let i = 0; i < N; i++) { y[out + i] += x[best + i] * win[i]; wsum[out + i] += win[i]; }
    prev = best;
  }
  const len = Math.floor(x.length / tempo);
  const res = new Float32Array(len);
  for (let i = 0; i < len; i++) res[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : 0;
  return res;
}

/** Fit to exactly `n` samples (the stretcher lands within a few ms). */
export function fitLength(a, n) {
  if (a.length === n) return a;
  const out = new Float32Array(n); out.set(a.subarray(0, Math.min(n, a.length))); return out;
}

export function speechRms(x, sr = SR) {
  const win = Math.floor(sr / 20), m = Math.floor(x.length / win);
  const r = [];
  for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < win; j++) s += x[i * win + j] ** 2; r.push(Math.sqrt(s / win)); }
  const top = Math.max(0, ...r), loud = r.filter((v) => v > top * 0.1);
  return loud.length ? Math.sqrt(loud.reduce((a, v) => a + v * v, 0) / loud.length) : 0;
}

/** Loudness and pace of each line against the speaker's median, for the tone director. */
export function measure(segs, voice) {
  const loud = segs.map((s) => 20 * Math.log10(speechRms(slice(voice, SR, s.start, s.end)) + 1e-9));
  const pace = segs.map((s) => s.text.length / Math.max(0.3, s.end - s.start));
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const ml = med(loud), mp = med(pace);
  return segs.map((_, i) => ({ loudness_db: +(loud[i] - ml).toFixed(1), pace: +(pace[i] / mp).toFixed(2) }));
}

/**
 * The final soundtrack: background (or the ducked original) plus the placed
 * dub, matched to the original speech's loudness, peak-limited. Returns an
 * AudioBuffer for the encoder and the stereo arrays for a WAV download.
 */
export function mix({ lines, background, original, voiceRef, duration, duck = 0.12 }) {
  const n = Math.floor(duration * SR);
  const voice = new Float32Array(n);
  for (const l of lines) {
    const s = Math.floor(l.start * SR);
    if (s < n) voice.set(l.audio.subarray(0, Math.min(l.audio.length, n - s)), s);
  }
  const target = speechRms(voiceRef), have = speechRms(voice);
  const gain = have > 0 && target > 0 ? Math.min(4, Math.max(0.25, target / have)) : 1;
  const [bl, br] = background ?? [original[0].map((v) => v * duck), original[1].map((v) => v * duck)];
  const L = new Float32Array(n), R = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    L[i] = (bl[i] ?? 0) + voice[i] * gain; R[i] = (br[i] ?? 0) + voice[i] * gain;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  if (peak > 0.97) { const k = 0.97 / peak; for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; } }
  const buffer = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR });
  buffer.copyToChannel(L, 0); buffer.copyToChannel(R, 1);
  return { buffer, L, R };
}
