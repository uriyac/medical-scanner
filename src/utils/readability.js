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
//          'low'     — mostly unreadable (garbled or heavily illegible)
export function assessReadability(text) {
  const t = (text ?? '').trim();
  const illegible = (t.match(/\[לא ברור\]/g) || []).length;
  const { count, commonRatio } = hebrewWordStats(t);
  const illegibleRatio = count ? illegible / count : 0;

  // Clean Hebrew medical prose runs ~0.35–0.45 common-word ratio; OCR garble
  // (even when a few words read right) collapses to ~0.03. 0.12 sits in the
  // wide empty gap between them — flags garble with margin, never clean text.
  let level = 'high';
  if (count >= 15 && commonRatio < 0.12) level = 'low';        // garbled — almost no real words
  else if (illegibleRatio >= 0.2 || illegible >= 10) level = 'low'; // heavily illegible
  else if (illegible > 0) level = 'partial';

  return { level, illegible, words: count, commonRatio };
}
