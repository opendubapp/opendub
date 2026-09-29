// What Whisper heard → the lines we actually dub.
//   node tests/lines.mjs
//
// A user dubbed a 41-second Mandarin video into English and reported that the
// Chinese was still audible underneath. It was: of the 11 segments
// Whisper returned, clean() kept 1 — the only one with Latin letters in it —
// so 34 of the 41 seconds were never dubbed at all. \W is ASCII-only however
// the u flag is set, so squash() emptied every Chinese line, and an empty
// squash is how clean() recognises "[Music]".
//
// No browser and no model: these are pure functions, and this is the test
// that would have caught it years before a person had to.
import { wordsFromSegments, segment, clean, collapseLoops, fitSeconds, language } from "../browser/src/core.js";

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ ok }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const lines = (segs) => clean(segment(wordsFromSegments(
  segs.map(([text, start, end], id) => ({ id, text, start, end })))));

// --- a reported video, as Whisper transcribed it -----------------------------
{
  const heard = [
    ["大家好,我是戈非。", 0.0, 2.4], ["人在国内做出海网站,赚全球人民的钱。", 2.4, 6.5],
    ["我做的这个SEO实战社群,", 6.5, 9.0], ["叫戈非的朋友们。", 9.0, 11.2],
    ["是一个出海网站和SEO的交流社区。", 11.2, 15.4], ["我会把我每一步的实操,", 15.4, 18.6],
    ["都记录在这里。", 18.6, 20.9], ["包括选品、建站、写内容、发外链。", 20.9, 26.3],
    ["还有我每个月的收入数据。", 26.3, 30.1], ["如果你也想做出海网站,", 30.1, 34.0],
    ["欢迎加入我们。", 34.0, 41.2],
  ];
  const out = lines(heard);
  const covered = out.reduce((a, l) => a + (l.end - l.start), 0);
  check("11 Chinese segments become lines, not one", out.length >= 8, `${out.length} lines`);
  check("and the whole video is dubbed", covered > 40, `${covered.toFixed(1)} s of 41.2`);
  check("the speech itself survives intact", out[1]?.text.includes("赚全球人民的钱"), out[1]?.text || "gone");
}

// --- every script we offer as a source ---------------------------------------
// Each of these was dropped whole before the fix, so dubbing *from* Chinese,
// Japanese, Korean, Russian, Hindi, Arabic or Thai produced a silent pass.
{
  const speech = {
    "zh-Hans": "人在国内做出海网站,赚全球人民的钱。", "ja": "この動画では、実際の手順を紹介します。",
    "ko": "오늘은 사이트를 만드는 방법을 알려드릴게요.", "ru": "Сегодня я расскажу, как это работает.",
    "hi": "आज मैं आपको यह दिखाने जा रहा हूँ।", "ar": "اليوم سأشرح لكم كيف يعمل هذا.",
    "th": "วันนี้ผมจะมาสอนวิธีทำครับ", "en": "Today I will show you how it works.",
  };
  const lost = Object.entries(speech).filter(([, t]) => lines([[t, 0, 3]]).length === 0).map(([k]) => k);
  check(`speech in all ${Object.keys(speech).length} source scripts is kept`, lost.length === 0, lost.join(", ") || "none lost");
}

// --- a decoder that came off the rails ---------------------------------------
// Whisper-base really returned this on a reported video: 更多的推出 fifty times,
// then 共同 sixty more, 381 characters for 17 seconds of speech. Untouched it
// became 128 English words and asked the voice for 54 seconds.
{
  const loop = "更多的推出".repeat(50) + "把所有的东西都放在这里" + "共同".repeat(60);
  const out = collapseLoops(loop);
  check("a loop with no spaces in it collapses", out.length < 30, `${loop.length} chars → ${out.length}`);
  check("and what the speaker actually said survives", out.includes("把所有的东西都放在这里"), out);
  check("the spaced kind still collapses too", collapseLoops("the the the words") === "the words", collapseLoops("the the the words"));

  // Two of a thing is how Chinese says a thing, not a decoder failing.
  const real = ["謝謝", "看看", "慢慢来", "人人有责", "爸爸妈妈", "好好学习天天向上"];
  const mangled = real.filter((t) => collapseLoops(t) !== t);
  check("reduplication a speaker really uses is left alone", mangled.length === 0, mangled.join(", ") || "none touched");
}

// --- and the cleanup still cleans --------------------------------------------
// The point of clean() is Whisper's inventions. Keeping Chinese must not mean
// keeping those — including the Chinese ones, which the old squash() could
// never match either, since they squashed to "" and were dropped by accident.
{
  const drops = [["[Music]", 0, 2], ["♪♪♪", 0, 2], ["(applause)", 0, 2], ["音乐", 0, 2], ["【掌声】", 0, 2]];
  const kept = drops.filter(([t]) => lines([[t, 0, 2]]).length > 0).map(([t]) => t);
  check("labels are still thrown away", kept.length === 0, kept.join(", ") || "none kept");

  const tail = [["Today I will show you how it works.", 0, 3], ["Thanks for watching!", 3, 4.5]];
  check("an invented English sign-off is still cut", lines(tail).length === 1, `${lines(tail).length} lines`);
  const zhTail = [["如果你也想做出海网站,欢迎加入我们。", 0, 4], ["谢谢观看", 4, 5.5]];
  check("and now the Chinese one is too", lines(zhTail).length === 1, `${lines(zhTail).length} lines`);
}

// --- how long to ask the voice for -------------------------------------------
// The engine returns exactly the length it is asked for (measured: 7.3 s asked,
// 7.5 s back), so an ask that cannot fit becomes a clip that cannot fit.
{
  const en = language("en");
  const ask = (o) => fitSeconds(o, en).want;

  // That report's last line, as it really came out: 128 words of runaway translation
  // on a line starting at 30.2 s of a 41.2 s video. It asked for 54.6 s.
  const runaway = { text: "together, ".repeat(128), start: 30.2, end: 41.2, nextStart: 41.2, videoEnd: 41.2 };
  check("a line can no longer outlive the video", ask(runaway) <= 11.01, `asks ${ask(runaway).toFixed(1)} s with 11.0 s left`);

  // ...nor eat the line after it. Overrunning by a little is still allowed:
  // it is a smaller fault than a gabbled line, and placement reports it.
  const greedy = { text: "together, ".repeat(60), start: 10, end: 14, nextStart: 16, videoEnd: 120 };
  check("nor swallow the line after it", ask(greedy) <= 7.51, `asks ${ask(greedy).toFixed(1)} s, next line at 16 s`);

  // And an ordinary line is untouched by either ceiling: room to breathe into
  // the pause that follows, a sixth over what the words need.
  const normal = { text: "I record every step of it here, including the sites I build.", start: 5, end: 9, nextStart: 11, videoEnd: 60 };
  check("an ordinary line still uses the pause after it", ask(normal) > 4 && ask(normal) < 6,
    `asks ${ask(normal).toFixed(1)} s for a 4.0 s line with 5.9 s of room`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
