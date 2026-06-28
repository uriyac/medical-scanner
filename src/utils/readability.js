// Readability assessment for OCR output — shared by extraction, preview, and Word.
//
// Real Hebrew medical text is full of common words (של, את, על, לא…). When OCR
// fails — a broken text layer, or hard cursive handwriting read wrong — the
// output is real Hebrew LETTERS scrambled into non-words, so the common-word
// ratio collapses. Combined with the count of explicit [לא ברור] markers, this
// gives an objective signal of how trustworthy a document's text is.

export const COMMON_HEBREW_WORDS = new Set([
  'של', 'את', 'על', 'לא', 'עם', 'או', 'אל', 'כי', 'גם', 'זה', 'יש', 'כל',
  'אם', 'כך', 'אך', 'רק', 'הוא', 'היא', 'אני', 'אבל', 'אחרי', 'לפני', 'ללא',
  'יותר', 'מאוד', 'בית', 'חולים', 'בדיקה', 'טיפול', 'רופא', 'מטופל', 'תאריך',
  'תלונה', 'ימין', 'שמאל', 'כאב', 'תקין', 'ביקור', 'מרפאה',
]);

// Tokenize to Hebrew-only words of length ≥2 and measure the common-word ratio.
function hebrewWordStats(text) {
  const words = (text ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^א-ת]/g, ''))
    .filter((w) => w.length >= 2);
  const common = words.filter((w) => COMMON_HEBREW_WORDS.has(w)).length;
  return { count: words.length, commonRatio: words.length ? common / words.length : 1 };
}

// Used at extraction time on a digital PDF's text layer (browser-side).
export function hebrewLooksGarbled(text) {
  const { count, commonRatio } = hebrewWordStats(text);
  if (count < 15) return false;        // too little signal to judge
  return commonRatio < 0.02;           // <2% common words → broken encoding
}

// Per-document readability of OCR output.
//   level: 'high'    — reads cleanly
//          'partial' — some words marked [לא ברור]
//          'low'     — mostly unreadable (garbled, heavily illegible, or rough handwriting)
//
// Note on the common-word ratio: clean medical documents are mostly FORM data
// (names, IDs, dates, institutions) with few function words, so they run only
// ~0.07–0.13 — NOT like prose (~0.40). Mis-read cursive collapses to ~0.03. The
// gap is narrow, so we trust the model's own signals (isHandwritten flag +
// [לא ברור] markers) as the primary tell and use the ratio only for SEVERE
// garble (<0.05), well below the clean-form floor. This avoids false-flagging
// legible printed records.
export function assessReadability(text, { isHandwritten = false } = {}) {
  const t = (text ?? '').trim();
  const illegible = (t.match(/\[לא ברור\]/g) || []).length;
  const { count, commonRatio } = hebrewWordStats(t);
  const illegibleRatio = count ? illegible / count : 0;

  let level = 'high';
  if (count >= 20 && commonRatio < 0.05) level = 'low';            // severely garbled / broken layer
  else if (illegibleRatio >= 0.15 || illegible >= 8) level = 'low'; // model flagged much as illegible
  else if (isHandwritten && commonRatio < 0.08) level = 'low';     // handwriting read with low quality
  else if (illegible > 0) level = 'partial';

  return { level, illegible, words: count, commonRatio };
}
