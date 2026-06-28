import { describe, it, expect } from 'vitest';
import { assessReadability, hebrewLooksGarbled } from './readability.js';

const CLEAN =
  'המטופל פנה למרפאה עם תלונה על כאב בגב התחתון ימין. בבדיקה נמצא תקין ללא ממצא חריג. הומלץ על טיפול שמרני ומנוחה אצל רופא מומחה.';
// Hebrew letters mis-read from cursive: a few real words survive (~3% common).
const GARBLED =
  'גב שרית המארגנות מאנה שלנפאה בקרסול לאחר שלחה וקחסו מרחה כד נאמיר הלה הרפסה כנשין לגגר מסן ביאלולר קרסול יש ומחזרל פגמח שמס לפיכם המרפאות החלו וקסרה לגלה סם שהשמל השמאל מאסן שמציות';
// A fully ciphered text layer (broken ToUnicode): essentially zero real words.
const GARBLED_DIGITAL =
  'קזחט מנסע גקרשד טפלמא צבכרת דשגכמ נפתלא רקצמש בגדכת לחנמפ קרשתב מגדנכ לפצרש תכמבד נגלרק שפתמא בכדרל מנקצש גתפלכ דרבנמ קלשגת מנפרכ';

describe('assessReadability', () => {
  it('rates clean Hebrew medical prose as high', () => {
    expect(assessReadability(CLEAN).level).toBe('high');
  });

  it('rates scrambled Hebrew (no real words) as low', () => {
    expect(assessReadability(GARBLED).level).toBe('low');
  });

  it('rates text with a few [לא ברור] markers as partial', () => {
    const t = 'המטופל פנה עם [לא ברור] בקרסול. בבדיקה נמצא ללא ממצא. הומלץ על טיפול ומנוחה אצל רופא.';
    const r = assessReadability(t);
    expect(r.level).toBe('partial');
    expect(r.illegible).toBe(1);
  });

  it('rates heavily-illegible text as low', () => {
    const t = Array(12).fill('[לא ברור]').join(' ') + ' של את על';
    expect(assessReadability(t).level).toBe('low');
  });

  it('does not flag short snippets (insufficient signal)', () => {
    expect(assessReadability('בדיקה תקין').level).toBe('high');
    expect(assessReadability('').level).toBe('high');
  });

  it('counts [לא ברור] occurrences', () => {
    expect(assessReadability('א [לא ברור] ב [לא ברור]').illegible).toBe(2);
  });
});

describe('hebrewLooksGarbled', () => {
  it('flags a fully ciphered text layer', () => {
    expect(hebrewLooksGarbled(GARBLED_DIGITAL)).toBe(true);
  });

  it('does not flag clean Hebrew', () => {
    expect(hebrewLooksGarbled(CLEAN)).toBe(false);
  });

  it('does not flag short text', () => {
    expect(hebrewLooksGarbled('של את על לא')).toBe(false);
  });
});
