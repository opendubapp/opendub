// The pipeline's logic, ported from the Python app (opendub/asr.py, translate.py,
// tone.py, dub.py, subtitles.py). Pure functions: no I/O, no providers.

// ------------------------------------------------------------------ languages

export const LANGUAGES = [
  ["en", "English", "English", "en", 15, false], ["zh-Hans", "Chinese (Simplified)", "简体中文", "zh", 5.2, true],
  ["zh-Hant", "Chinese (Traditional)", "繁體中文", "zh", 5.2, true], ["ja", "Japanese", "日本語", "ja", 7.5, true],
  ["ko", "Korean", "한국어", "ko", 6.5, true], ["es", "Spanish", "Español", "es", 15, false],
  ["fr", "French", "Français", "fr", 15, false], ["de", "German", "Deutsch", "de", 14.5, false],
  ["pt", "Portuguese", "Português", "pt", 15, false], ["it", "Italian", "Italiano", "it", 15, false],
  ["ru", "Russian", "Русский", "ru", 14, false], ["hi", "Hindi", "हिन्दी", "hi", 13, false],
  ["id", "Indonesian", "Bahasa Indonesia", "id", 15, false], ["ms", "Malay", "Bahasa Melayu", "ms", 15, false],
  ["vi", "Vietnamese", "Tiếng Việt", "vi", 13, false], ["th", "Thai", "ไทย", "th", 11, true],
  ["ar", "Arabic", "العربية", "ar", 13, false],
].map(([code, name, endonym, iso, cps, cjk]) => ({ code, name, endonym, iso, cps, cjk }));

export const language = (code) => LANGUAGES.find((l) => l.code === code || l.iso === code)
  || { code, name: code, endonym: code, iso: code, cps: 14, cjk: false };

/**
 * How long a line wants to be, spoken at a comfortable pace.
 *
 * Characters alone mislead: "from a website of the words peoples money" is
 * short in characters and long in words, and asking a voice to say it in the
 * characters' worth of time produced four words a second — a third faster
 * than anyone speaks. Both are measured and the slower one wins.
 *
 * 2.6 words a second is unhurried narration; the per-language character rate
 * carries the writing systems where words are not the unit — Chinese and
 * Japanese have no spaces, and the word count would be one.
 */
export const wordsIn = (text) => (String(text).trim().match(/\S+/g) || []).length;

export function naturalSeconds(text, lang) {
  const chars = countChars(text);
  const byChars = chars / (lang.cps || 14);
  if (lang.cjk) return byChars;
  const words = wordsIn(text);
  return Math.max(byChars, words / 2.6);
}

/**
 * How long to ask the voice for, given where the next line starts.
 *
 * Chinese says in four seconds what English needs six to say, so asking for
 * the speaker's own span crushed the dub into it — a zh→en dub came back at
 * four and a half words a second. A line may use the pause that follows it,
 * up to where the next one begins, and is only compressed when there is
 * genuinely nowhere to put it; never by more than a quarter, because a line
 * that overruns a little is a smaller fault than one gabbled to fit.
 *
 * The two ceilings are not preferences. A line may not outlive the video and
 * may not swallow the one after it: a runaway transcription of jerry's last
 * line asked for 54.6 s of speech to sit in the 10.9 s the video had left,
 * and the engine gives you exactly the length you ask it for.
 */
export function fitSeconds({ text, start, end, nextStart, videoEnd = Infinity }, lang) {
  const span = Math.max(0.3, end - start);
  const natural = naturalSeconds(text, lang);
  const next = nextStart ?? videoEnd;
  const room = Math.max(span, next - start - 0.08);      // a breath before the next line
  // A sixth more than the words need: the engine lays its own pauses inside
  // the length it is given, and the silence at the ends is trimmed off after,
  // so asking for exactly the speaking time came back a sixth fast.
  const want = Math.min(Math.max(natural * 1.15, 0.3), Math.max(room, natural / 1.25),
                        Math.max(0.3, Math.min(videoEnd, next + 1.5) - start));
  return { want, room, natural };
}

// ------------------------------------------------------------------ tokens and alignment

const CJK = "\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff";
const CJK_TOKEN = new RegExp(`[${CJK}][^\\s${CJK}\\p{L}\\p{N}]*|[^\\s${CJK}]+`, "gu");
const isCjk = (t) => new RegExp(`^[${CJK}]`).test(t);

export function tokens(text) {
  // Higgs joins its ~30 s windows as "languages.That": an unspaced full stop
  // mid-sentence is a seam, not a sentence end.
  text = text.replace(/(?<=[a-z])\.([A-Z][a-z]*|I)\b/g, (_, w) => " " + (w === "I" || w === w.toUpperCase() ? w : w.toLowerCase()));
  text = text.replace(/([!?,;:])(?=[A-Z])/g, "$1 ");
  return text.match(CJK_TOKEN) || [];
}

export function joinTokens(toks) {
  let out = "";
  for (const t of toks) {
    const prev = out.slice(-1);
    const glue = out && !(isCjk(t) && isCjk(prev)) && !(isCjk(t) && !/[\p{L}\p{N}]/u.test(prev)) && !(isCjk(prev) && !/^[\p{L}\p{N}]/u.test(t));
    out += (glue ? " " : "") + t;
  }
  return out;
}

const norm = (t) => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function spread(toks, start, end) {
  const total = toks.reduce((a, t) => a + Math.max(1, t.length), 0);
  let t = start;
  return toks.map((tok) => { const d = (end - start) * Math.max(1, tok.length) / total; const w = { text: tok, start: t, end: t + d }; t += d; return w; });
}

/** Segment-level timestamps → per-word estimates, by character share (opensubs). */
export function wordsFromSegments(segs) {
  return segs.flatMap((s) => spread(tokens(s.text), s.start, s.end));
}

/** Longest-common-subsequence opcodes over two token lists (difflib's role). */
function matchBlocks(a, b) {
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return pairs;
}

/** Give each token of `text` a time borrowed from the matching timed word. */
export function align(text, timed, lo, hi) {
  const toks = tokens(text);
  if (!toks.length) return [];
  if (!timed.length) return spread(toks, lo, hi);
  const pairs = matchBlocks(toks.map(norm), timed.map((w) => norm(w.text)));
  const out = new Array(toks.length).fill(null);
  for (const [i, j] of pairs) out[i] = { text: toks[i], start: timed[j].start, end: timed[j].end };
  for (let i = 0; i < out.length;) {
    if (out[i]) { i++; continue; }
    let j = i; while (j < out.length && !out[j]) j++;
    const s = i > 0 ? out[i - 1].end : Math.max(lo, j < out.length ? out[j].start - 0.3 * (j - i) : lo);
    let e = j < out.length ? out[j].start : Math.min(hi, s + 0.3 * (j - i));
    if (e <= s) e = s + 0.05 * (j - i);
    spread(toks.slice(i, j), s, e).forEach((w, k) => (out[i + k] = w));
    i = j;
  }
  return out;
}

// ------------------------------------------------------------------ segmentation + cleanup

const SENTENCE_END = /[.!?…。！？]['"”’)\]]*$/;
const CLAUSE_END = /[,;:，、；：]['"”’)\]]*$/;

export function segment(words, { pauseSplit = 0.6, maxDur = 11, minDur = 1.2 } = {}) {
  const groups = []; let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const nxt = words[i + 1];
    if (SENTENCE_END.test(w.text) || !nxt || nxt.start - w.end > pauseSplit) { groups.push(...cap(cur, maxDur)); cur = []; }
  });
  const merged = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const short = g.at(-1).end - g[0].start < minDur || prev.at(-1).end - prev[0].start < minDur;
      if (short && g[0].start - prev.at(-1).end <= 0.4 && g.at(-1).end - prev[0].start <= maxDur) { merged[merged.length - 1] = prev.concat(g); continue; }
    }
    merged.push(g);
  }
  return merged.map((g, id) => ({ id, start: g[0].start, end: g.at(-1).end, text: joinTokens(g.map((w) => w.text)), words: g }));
}

function cap(ws, maxDur) {
  if (ws.at(-1).end - ws[0].start <= maxDur || ws.length < 4) return [ws];
  const mid = (ws[0].start + ws.at(-1).end) / 2;
  const cands = ws.map((w, i) => i).slice(1, -1).filter((i) => CLAUSE_END.test(ws[i].text));
  const k = cands.length ? cands.reduce((a, i) => Math.abs(ws[i].end - mid) < Math.abs(ws[a].end - mid) ? i : a)
    : ws.map((w, i) => i).slice(1, -1).reduce((a, i) => ws[i + 1].start - ws[i].end > ws[a + 1].start - ws[a].end ? i : a, 1);
  return [...cap(ws.slice(0, k + 1), maxDur), ...cap(ws.slice(k + 1), maxDur)];
}

const SIGN_OFFS = new Set(["thanksforwatching", "thankyouforwatching", "pleasesubscribe", "likeandsubscribe",
  "subtitlesbytheamaraorgcommunity", "thankyou", "字幕由amaraorg社群提供", "谢谢观看", "謝謝觀看", "ご視聴ありがとうございました", "시청해주셔서감사합니다"]);
const LABELS = new Set(["music", "applause", "laughter", "laughs", "silence", "noise", "inaudible", "音乐", "掌声", "笑声"]);
// \W is ASCII-only whatever the u flag says, so this used to squash every
// Chinese line to "" — and clean() reads an empty squash as a non-speech
// label. A 41 s Mandarin video came out of Whisper as 11 segments and left
// clean() as 1: the only one with Latin letters in it. Letters and numbers
// in any script, as norm() above already does.
const squash = (s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * A decoder that has come off the rails repeats itself. In a language with
 * spaces that reads "the the the"; in one without, 更多的推出更多的推出 with
 * nothing in between — which the word-boundary form cannot see. Whisper looped
 * that way on a Mandarin video and turned 17 seconds into 381 characters,
 * which became 128 English words and asked the voice for 54 seconds of speech
 * to fit in the 11 the video had left.
 *
 * Three repeats, never two, so reduplication a speaker really uses — 謝謝,
 * 看看, 慢慢来, 爸爸妈妈, 好好学习天天向上 — is left alone.
 */
export const collapseLoops = (text) => String(text)
  .replace(/\b(\w+)(?:[\s,]+\1\b){2,}/giu, "$1")
  .replace(new RegExp(`([${CJK}]{1,12}?)\\1{2,}`, "gu"), "$1")
  .trim();

/** opensubs' cleanup: drop invented sign-offs and non-speech labels, collapse decoder loops. */
export function clean(segs) {
  const kept = [];
  for (const s of segs) {
    const text = collapseLoops(s.text);
    const words = text.replace(/[[\]()♪♫*_-]/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
    const label = !squash(text) || (words.length && words.filter((w) => LABELS.has(squash(w))).length / words.length >= 0.6);
    const signOff = SIGN_OFFS.has(squash(text)) && s.end - s.start < 2.5 && segs.length > 1;
    if (!label && !signOff) kept.push({ ...s, text, id: kept.length });
  }
  return kept;
}

// ------------------------------------------------------------------ translation + tone prompts

const SCRIPT_RULES = {
  "zh-Hans": "- Use Simplified Chinese characters only (简体字), with Chinese punctuation (，。？！).",
  "zh-Hant": "- Use Traditional Chinese characters only (繁體字), with Chinese punctuation (，。？！).",
  ja: "- Use natural Japanese with kanji and kana, Japanese punctuation (、。).",
};

export function translationPrompt(segs, target, sourceName) {
  const system = `You translate a video's spoken lines for a voice-over dub.

Rules:
- Return exactly one translation per input line, in the same order. Never merge, split, reorder, drop or add entries: entry N of your output is spoken at the timestamp of entry N.
- Each line has "chars": about how many characters a native speaker says in the time the original took. Aim for it — within about 15 %. Much shorter and the voice finishes while the speaker is still talking; much longer and it has to be rushed.
- Write natural spoken ${target.name}, the way a native presenter would say it on camera — not written or formal prose.
- Keep who is speaking to whom: "I/me" stays the speaker and "you" stays the listener. Never swap pronouns.
- Keep product and proper names as written. Write numbers the way a speaker would say them in ${target.name}.
- Use the surrounding lines as context: a line may finish a sentence the previous one began.
- A line already in another language is translated into ${target.name} too.
${SCRIPT_RULES[target.code] || ""}
Reply with JSON only: {"translations": ["...", "..."]}`;
  const lines = segs.map((s, i) => ({ id: i + 1, text: s.text, seconds: +(s.end - s.start).toFixed(1), chars: Math.max(4, Math.round((s.end - s.start) * target.cps)) }));
  return { system, user: `Translate these ${lines.length} lines from ${sourceName} into ${target.name}.\n\n${JSON.stringify({ lines })}` };
}

export function resizePrompt(source, current, target, wantChars, context) {
  const n = countChars(current);
  const how = wantChars > n
    ? "It is too SHORT: the speaker took longer to say this. Rephrase it more fully and naturally — restore interjections, connectives and emphasis the speaker actually used — but add no new information."
    : "It is too LONG to say in the time. Say the same thing more compactly — cut filler and redundancy first, never the meaning.";
  return {
    system: `You adjust the length of ${target.name} voice-over lines so each one takes as long to say as the original. ${how} Keep the natural spoken register and proper names. Reply with JSON only: {"text": "..."}${SCRIPT_RULES[target.code] ? "\n" + SCRIPT_RULES[target.code] : ""}`,
    user: JSON.stringify({ original: source, current_translation: current, current_chars: n, target_chars: wantChars, context }),
  };
}

export const EMOTIONS = ["neutral", "elation", "amusement", "enthusiasm", "determination", "pride", "contentment", "affection", "relief",
  "contemplation", "confusion", "surprise", "awe", "longing", "anger", "fear", "disgust", "bitterness", "sadness", "shame", "helplessness"];

export function tonePrompt(segs, feats) {
  const system = `You are a voice director preparing a dub. For each spoken line, decide how it should be DELIVERED so the dubbed voice keeps the original performance.

Each line comes with measurements of how the speaker actually said it, relative to their own average across the video:
- "loudness_db": + is louder than usual, - is quieter.
- "pace": >1 is faster than usual, <1 slower.
Use them together with the words and the surrounding lines. Most lines in ordinary talk are "neutral" or mild; pick a strong emotion only when the words or the delivery clearly carry it.

For each line return:
- "emotion": one of ${JSON.stringify(EMOTIONS)}
- "expressive": one of ["low","normal","high"]
- "style": one of ["none","whispering","shouting"] — only if the speaker clearly does so

Return exactly one entry per line, in order. Reply with JSON only:
{"lines": [{"emotion": "...", "expressive": "...", "style": "..."}]}`;
  return { system, user: JSON.stringify({ lines: segs.map((s, i) => ({ id: i + 1, text: s.text, ...feats[i] })) }) };
}

export function higgsTags(t) {
  if (!t) return "";
  let out = "";
  if (t.emotion && t.emotion !== "neutral") out += `<|emotion:${t.emotion}|>`;
  if (t.style === "whispering" || t.style === "shouting") out += `<|style:${t.style}|>`;
  if (t.expressive === "high" || t.expressive === "low") out += `<|prosody:expressive_${t.expressive}|>`;
  if (t.speed === "fast" || t.speed === "slow") out += `<|prosody:speed_${t.speed}|>`;
  return out;
}

export const countChars = (text) => text.replace(/[\s\p{P}\p{S}_]+/gu, "").length;

export function parseJson(text) {
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1];
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`the model did not return JSON: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(a, b + 1));
}

export function similarity(a, b) {
  const sq = (s) => [...s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")];   // any script, as squash()
  a = sq(a); b = sq(b);
  if (!a.length || !b.length) return 0;
  const m = matchBlocks(a, b).length;
  return (2 * m) / (a.length + b.length);
}

// ------------------------------------------------------------------ subtitles

function wordBounds(text, lang) {
  if (typeof Intl?.Segmenter !== "function") return [...text].map((_, i) => i + 1).slice(0, -1);
  const seg = new Intl.Segmenter(lang, { granularity: "word" });
  const out = []; for (const { index, segment } of seg.segment(text)) out.push(index + segment.length);
  return out.slice(0, -1);
}
const plen = (s) => s.replace(/\s/g, "").length;

export function layout(width, height, lang) {
  const fs = Math.round(Math.min(height * 0.045, width * 0.075));
  let perLine = lang.cjk ? Math.floor(width * 0.86 / fs) : Math.floor(width * 0.86 / (fs * 0.5));
  perLine = Math.max(8, Math.min(perLine, lang.cjk ? 20 : 42));
  return { fontSize: fs, perLine, marginV: Math.round(height * (height > width ? 0.165 : 0.06)) };
}

function pieces(text, cap, lang) {
  const clauses = text.split(lang.cjk ? /(?<=[，。！？；：、,.!?;:])/ : /(?<=[，。！？；：、,.!?;:])\s+/).map((c) => c.trim()).filter(Boolean);
  const out = []; let cur = "";
  for (let c of clauses) {
    while (plen(c) > cap) {
      let head;
      if (lang.cjk) { const cut = Math.max(...wordBounds(c, lang.iso).filter((i) => i <= cap), cap); head = c.slice(0, cut); c = c.slice(cut); }
      else { const ws = c.split(/\s+/); head = ""; while (ws.length && plen(head + ws[0]) <= cap) head = `${head} ${ws.shift()}`.trim(); if (!head) head = ws.shift(); c = ws.join(" "); }
      if (cur) { out.push(cur); cur = ""; }
      out.push(head);
    }
    if (cur && plen(cur + c) > cap) { out.push(cur); cur = c; } else cur = cur ? (cur + (lang.cjk ? "" : " ") + c).trim() : c;
  }
  if (cur) out.push(cur);
  return out;
}

function wrap(text, perLine, lang) {
  if (plen(text) <= perLine) return [text];
  if (lang.cjk) {
    const mid = text.length / 2;
    const cands = wordBounds(text, lang.iso).filter((i) => Math.max(i, text.length - i) <= perLine);
    const cut = (cands.length ? cands : [Math.floor(mid)]).reduce((a, i) => Math.abs(i - mid) < Math.abs(a - mid) ? i : a);
    return [text.slice(0, cut).trim(), text.slice(cut).trim()];
  }
  const words = text.split(/\s+/); const lines = []; let cur = "";
  for (const w of words) { if (cur && cur.length + 1 + w.length > perLine) { lines.push(cur); cur = w; } else cur = `${cur} ${w}`.trim(); }
  lines.push(cur);
  return lines.length > 2 ? [words.slice(0, words.length >> 1).join(" "), words.slice(words.length >> 1).join(" ")] : lines;
}

export function cues(items, lang, perLine) {
  const out = [];
  for (const { start, end, text } of items) {
    const ps = pieces(text, perLine * 2, lang);
    const total = ps.reduce((a, p) => a + Math.max(1, plen(p)), 0);
    let t = start;
    for (const p of ps) {
      const d = (end - start) * Math.max(1, plen(p)) / total;
      const shown = lang.cjk ? p.replace(/[，。、；：]+$/, "").replace(/[，。、；：]/g, " ").trim() : p;
      if (shown) out.push({ start: t, end: t + d, text: wrap(shown, perLine, lang).join("\n") });
      t += d;
    }
  }
  return out;
}

const ts = (t, sep) => { const ms = Math.round(Math.max(0, t) * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`; };
export const srt = (cs) => cs.map((c, i) => `${i + 1}\n${ts(c.start, ",")} --> ${ts(c.end, ",")}\n${c.text}\n`).join("\n");
export const vtt = (cs) => "WEBVTT\n\n" + cs.map((c) => `${ts(c.start, ".")} --> ${ts(c.end, ".")}\n${c.text}\n`).join("\n");

export function ass(cs, width, height, lay, font) {
  const at = (t) => { const c = Math.round(Math.max(0, t) * 100); return `${Math.floor(c / 360000)}:${String(Math.floor(c / 6000) % 60).padStart(2, "0")}:${String(Math.floor(c / 100) % 60).padStart(2, "0")}.${String(c % 100).padStart(2, "0")}`; };
  const pad = Math.max(4, Math.round(lay.fontSize * 0.28)), side = Math.round(width * 0.05);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Dub,${font},${lay.fontSize},&H00FFFFFF,&H00FFFFFF,&H14000000,&H14000000,0,0,0,0,100,100,0,0,3,${pad},0,2,${side},${side},${lay.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cs.map((c) => `Dialogue: 0,${at(c.start)},${at(c.end)},Dub,,0,0,0,,${c.text.replace(/\n/g, "\\N")}`).join("\n")}
`;
}
