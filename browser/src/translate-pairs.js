// Which pairs can be translated in the tab, and by which model. Kept apart
// from the model code so the pipeline can ask the question without pulling
// transformers.js into the main bundle.

// Preferring onnx-community where it exists: those repositories state
// CC-BY-4.0, the licence Helsinki-NLP publishes opus-mt under. The Xenova
// mirrors carry the same weights without restating a licence.
const PAIRS = {
  "en>zh": "onnx-community/opus-mt-en-zh",
  "zh>en": "onnx-community/opus-mt-zh-en",
  "en>es": "onnx-community/opus-mt-en-es",
  "es>en": "onnx-community/opus-mt-es-en",
  "en>fr": "onnx-community/opus-mt-en-fr",
  "fr>en": "onnx-community/opus-mt-fr-en",
  "en>de": "onnx-community/opus-mt-en-de",
  "de>en": "onnx-community/opus-mt-de-en",
  "en>ru": "onnx-community/opus-mt-en-ru",
  "ru>en": "onnx-community/opus-mt-ru-en",
  "en>ar": "onnx-community/opus-mt-en-ar",
  "ar>en": "onnx-community/opus-mt-ar-en",
  "it>en": "onnx-community/opus-mt-it-en",
  "vi>en": "onnx-community/opus-mt-vi-en",
  "ja>en": "onnx-community/opus-mt-ja-en",
  "en>it": "Xenova/opus-mt-en-it",
  "en>hi": "Xenova/opus-mt-en-hi",
  "hi>en": "Xenova/opus-mt-hi-en",
  "en>id": "Xenova/opus-mt-en-id",
  "id>en": "Xenova/opus-mt-id-en",
  "en>vi": "Xenova/opus-mt-en-vi",
  "ko>en": "Xenova/opus-mt-ko-en",
  "th>en": "Xenova/opus-mt-th-en",
};

// The many-target model names languages in ISO 639-3, and wants the target as
// the first token of the line.
const MANY = "Xenova/opus-mt-en-mul";
const MANY_TOKEN = { ja: "jpn", ko: "kor", th: "tha", ms: "zsm", id: "ind", vi: "vie", hi: "hin", it: "ita" };

/** Can this pair be translated here, and with what? */
export function localTranslator(source, target) {
  const direct = PAIRS[`${source}>${target}`];
  if (direct) return { repo: direct, prefix: "" };
  if (source === "en" && MANY_TOKEN[target]) return { repo: MANY, prefix: `>>${MANY_TOKEN[target]}<< ` };
  return null;
}
