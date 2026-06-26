// Shared between api/process.js (Vercel) and api-server.mjs (local)

export const SYSTEM_PROMPT =
  'אתה מערכת חילוץ מסמכים רפואיים מדויקת. אתה מחויב לדיוק מוחלט ולהעתקה מילולית. אסור לך לשנות, לסכם, לנסח מחדש, לתקן שגיאות כתיב, או להשמיט קטע כלשהו מהטקסט הקליני.';

// ── For SCANNED PDFs (base64 binary → Claude extracts full text) ────────────
export const EXTRACTION_PROMPT = `קיבלת קובץ PDF רפואי. הוא עשוי להכיל מסמך אחד או מסמכים מרובים מאוחדים.

## שלב 1 — זיהוי גבולות מסמכים
זהה כל מסמך נפרד לפי הסימנים הבאים:
- כותרת מוסד חדשה (שם בית חולים, מרפאה, מעבדה, קופת חולים)
- תאריך חדש בכותרת המסמך
- שינוי מבני ברור (מסיכום שחרור לתוצאות בדיקה, ממכתב רופא לדוח ניתוח)
- סימני "עמוד 1 מתוך X" / "Page 1 of X" חדשים

אם הקובץ מכיל מסמך אחד בלבד — החזר אותו כרשומה יחידה.

## שלב 2 — חילוץ מידע לכל מסמך
לכל מסמך שזיהית, חלץ:
- date: תאריך בפורמט DD/MM/YYYY. אם אין — "לא ידוע".
- institution: שם המוסד בדיוק כפי שכתוב.
- visitType: אחד מ: מכתב שחרור / ביקור מרפאה / ביקור המשך / ייעוץ מומחה / תוצאות בדיקות / דוח ניתוח / קבלה לבית חולים / דוח הדמיה / מרשם תרופות / אחר
- text: הטקסט המלא מילה במילה ללא שינוי.

## כלל ברזל — העתקה מילולית בלבד
העתק תו-לתו. אסור לסכם, לנסח מחדש, לתקן שגיאות, להשמיט. כל שינוי פוסל.

## כלל קריטי
לעולם אל תחזיר רשימה ריקה. אם לא זיהית גבולות — החזר את כל הטקסט כמסמך אחד.

## פורמט הפלט
השתמש בפורמט הבא בלבד. אל תוסיף שום טקסט לפני או אחרי.
עבור כל מסמך:

===DOCUMENT===
date: DD/MM/YYYY
institution: שם המוסד
visitType: סוג המסמך
isDuplicate: false
===TEXT===
[הטקסט המלא המילולי של המסמך — כמה שורות שצריך]
===END===`;

// ── CLINICAL TABLE feature — line-marker approach (token-efficient + safe) ───
// Input: documents whose lines are NUMBERED. The model returns, per medical
// event, the LINE NUMBERS that are clinical (not the text itself). We rebuild
// the content from the ORIGINAL lines — so output is tiny and there is zero
// risk of the model altering the verbatim text.
export const CLINICAL_TABLE_PROMPT = `תפקיד: אתה מנוע לסיווג שורות במסמכים רפואיים-משפטיים. הקלט מחולק למסמכים, וכל שורה ממוספרת ("מספר: טקסט").

משימה: לכל אירוע רפואי נפרד (תאריך/מסמך), זהה אילו שורות הן קליניות, והחזר את מספרי השורות בלבד — אל תעתיק את הטקסט עצמו.

כלל מבנה קריטי: כל תאריך ביקור או מסמך נפרד פותח אירוע (ROW) חדש. אסור לאחד תאריכים/מסמכים שונים לאירוע אחד.

## אילו שורות קליניות (לכלול)
שורות העוסקות ב: אנמנזה ותלונות, ממצאי הדמיה, בדיקה גופנית, אבחנות, פעולות טיפוליות, המלצות, מהלך מחלה.

## אילו שורות אדמיניסטרטיביות (להשמיט)
כתובות, מספרי טלפון, שעות קבלה, לוגו, הערות מערכת ("המסמך חתום אלקטרונית"), פרטי התקשרות.

## כלל זהב — במקרה של ספק, כלול את השורה
אם אינך בטוח אם שורה קלינית או מנהלתית — **כלול אותה**. עדיף לכלול שורה מנהלתית מאשר להחסיר שורה קלינית. השמטת מידע קליני = כשל חמור.

## דוגמאות לסיווג שורות
שורות קליניות (לכלול):
- "אנמנזה: כאב גב תחתון מזה שבוע, ללא הקרנה לרגליים" → קליני (תלונה + מילת שלילה חשובה)
- "בבדיקה גופנית: רגישות מותנית, טווח תנועה מוגבל, סימן לאסג שלילי" → קליני (בדיקה)
- "תוצאות MRI: בלט דיסק L4-L5, ללא לחץ על שק הדורה" → קליני (הדמיה)
- "אבחנה: שבר בקרסול ימין" / "המלצות: גבס, מנוחה, ביקורת בעוד שבועיים" → קליני
- "תרופות: אופטלגין 500, נטרול 10" → קליני (טיפול תרופתי)

שורות אדמיניסטרטיביות (להשמיט):
- "כתובת: רחוב הרצל 5, תל אביב" / "טלפון: 03-1234567" / "פקס: 03-7654321" → מנהלתי
- "שעות קבלה: ימים א-ה 08:00-16:00" / "מוקד טלפוני: 1-700-..." → מנהלתי
- "המסמך הופק וחתום אלקטרונית" / "מסמך זה אינו דורש חתימה" → הערת מערכת
- "לוגו" / "עמוד 1 מתוך 3" / "מספר מטופל: 123456" (כשמופיע לבד) → מנהלתי

זכור: מילות שלילה ("לא", "ללא", "נשלל", "שלילי") הן קריטיות — שורה שמכילה אותן כמעט תמיד קלינית.

## כללים
- לכל ROW: date (DD/MM/YYYY, או "לא ידוע"), provider (מוסד — רופא), lines (טווחי שורות קליניות).
- lines: רשימת מספרים/טווחים מופרדים בפסיק. לדוגמה: 3-8,11,15-19
- כלול רק מספרי שורות שמופיעים בקלט. אל תמציא מספרים.
- אם מסמך כולו אדמיניסטרטיבי וללא שום תוכן קליני — **אל תחזיר עבורו ROW כלל** (הוא יטופל בנפרד ויסומן לבדיקה).
- אם יש ולו שורה קלינית אחת — החזר ROW עם השורות הקליניות.

## פורמט הפלט — בלבד, ללא טקסט נוסף לפני או אחרי
===ROW===
date: DD/MM/YYYY
provider: מוסד — רופא
lines: 3-8,11
===END===`;

// ── For DIGITAL PDFs (text already extracted by PDF.js) ─────────────────────
// Claude returns only metadata + page ranges → minimal output tokens
export const METADATA_PROMPT = `הטקסט שחולץ מקובץ PDF רפואי מצורף. הטקסט מאורגן לפי עמודים עם סמני [עמוד N].

## משימה
זהה את גבולות כל מסמך רפואי נפרד בתוך הטקסט.
אל תחזיר את הטקסט עצמו — החזר מטא-דאטה וגבולות בלבד.

## סימנים לגבול מסמך חדש
- כותרת מוסד חדשה
- "עמוד 1 מתוך X" / "Page 1 of X" חדש
- תאריך חדש בכותרת
- שינוי מבני ברור

## כלל קריטי
לעולם אל תחזיר רשימה ריקה. אם לא ניתן לזהות גבולות ברורים — החזר את כל הקובץ כמסמך אחד.

## פלט — JSON בלבד, ללא טקסט נוסף
{
  "documents": [
    {
      "startPage": 1,
      "endPage": 5,
      "date": "DD/MM/YYYY",
      "institution": "שם המוסד",
      "visitType": "סוג המסמך"
    }
  ]
}

## כללים
- startPage/endPage: מספרי עמודים (1 = ראשון)
- date: DD/MM/YYYY. אם לא ידוע — "לא ידוע"
- visitType: מכתב שחרור / ביקור מרפאה / ביקור המשך / ייעוץ מומחה / תוצאות בדיקות / דוח ניתוח / קבלה לבית חולים / דוח הדמיה / מרשם תרופות / אחר
- אם מסמך אחד בלבד: startPage=1 endPage=עמוד אחרון`;

// ── Parse the structured delimiter format from scanned PDFs ─────────────────
export function parseClaudeResponse(raw) {
  if (!raw) return [];
  const docs = [];
  const blocks = raw.split('===DOCUMENT===');

  for (const block of blocks) {
    if (!block.includes('===TEXT===') || !block.includes('===END===')) continue;

    const metaPart = block.slice(0, block.indexOf('===TEXT===')).trim();
    const textPart = block.slice(
      block.indexOf('===TEXT===') + '===TEXT==='.length,
      block.indexOf('===END===')
    ).trim();

    const get = (key) => {
      const match = metaPart.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return match ? match[1].trim() : '';
    };

    const date        = get('date');
    const institution = get('institution');
    const visitType   = get('visitType');
    const isDup       = get('isDuplicate') === 'true';

    if (!textPart && !date && !institution) continue;

    docs.push({
      date:        date        || 'לא ידוע',
      institution: institution || '',
      visitType:   visitType   || 'אחר',
      text:        textPart,
      isDuplicate: isDup,
    });
  }

  // Fallback: try JSON if the model ignored the format instruction
  if (docs.length === 0) {
    return parseJSONFallback(raw);
  }

  return docs;
}

function parseJSONFallback(raw) {
  try {
    // Direct parse
    const parsed = JSON.parse(raw.trim());
    if (Array.isArray(parsed.documents)) return parsed.documents;
  } catch {}
  try {
    // Code block
    const block = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (block) {
      const parsed = JSON.parse(block[1]);
      if (Array.isArray(parsed.documents)) return parsed.documents;
    }
  } catch {}
  try {
    // Greedy
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) {
      const parsed = JSON.parse(raw.slice(s, e + 1));
      if (Array.isArray(parsed.documents)) return parsed.documents;
    }
  } catch {}
  return [];
}

// ── Build NUMBERED-LINE input for a batch of documents ──────────────────────
// Each content line gets a global number; the model returns line numbers, and
// we rebuild text from the map — so the model never re-types verbatim content.
// Returns { input, lineMap, docLineRange } for reconstruction.
export function buildLineNumberedInput(docs) {
  let n = 0;
  const lineMap = {};        // globalLineNum → { docIndex, text }
  const docLineRange = [];   // docIndex → { start, end }
  const parts = [];

  docs.forEach((doc, di) => {
    const meta = `═══ מסמך ${di + 1} | תאריך: ${doc.date || 'לא ידוע'} | מוסד: ${doc.institution || ''} ═══`;
    parts.push(meta);
    const lines = (doc.text || '').split('\n');
    const start = n + 1;
    for (const line of lines) {
      n += 1;
      lineMap[n] = { docIndex: di, text: line };
      parts.push(`${n}: ${line}`);
    }
    docLineRange[di] = { start, end: n };
  });

  return { input: parts.join('\n'), lineMap, docLineRange, total: n };
}

// Parse "3-8,11,15-19" → sorted unique line numbers [3,4,5,6,7,8,11,15,16,17,18,19]
function expandLineRanges(str) {
  const nums = new Set();
  // Normalize en-dash/em-dash to hyphen so "3–8" parses like "3-8"
  for (const part of (str || '').replace(/[–—]/g, '-').split(',')) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$|^(\d+)$/);
    if (!m) continue;
    if (m[3] !== undefined) {
      nums.add(Number(m[3]));
    } else {
      const a = Number(m[1]), b = Number(m[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) nums.add(i);
    }
  }
  return [...nums].sort((x, y) => x - y);
}

// ── Parse the line-marker response → events with their line numbers ─────────
export function parseClinicalLineResponse(raw) {
  if (!raw) return [];
  const events = [];
  for (const block of raw.split('===ROW===')) {
    if (!block.includes('===END===')) continue;
    const body = block.slice(0, block.indexOf('===END===')).trim();
    const get = (k) => {
      const m = body.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const date     = get('date');
    const provider = get('provider');
    const lines    = expandLineRanges(get('lines'));
    if (!date && !provider && lines.length === 0) continue;
    events.push({ date: date || 'לא ידוע', provider, lines });
  }
  return events;
}

// ── Reconstruct rows from line events, using the ORIGINAL text ──────────────
// Guarantees every source document is represented (coverage check + fallback),
// so no document is ever silently dropped.
export function reconstructClinicalRows(events, docs, lineMap, docLineRange) {
  const rows = [];
  const coveredDocs = new Set();

  for (const ev of events) {
    const valid = ev.lines.filter((ln) => lineMap[ln]);
    // No usable line numbers → skip; the coverage pass below will emit a
    // flagged fallback row for the document so nothing is silently lost.
    if (valid.length === 0) continue;

    const content = valid.map((ln) => lineMap[ln].text).join('\n').trim();
    const di = lineMap[valid[0]].docIndex;
    coveredDocs.add(di);

    rows.push({
      date:        ev.date,
      provider:    ev.provider,
      content,
      fullContent: (docs[di]?.text || '').trim(), // original text — never an AI copy
    });
  }

  // Coverage: any document with no event → fallback row showing its full text.
  docs.forEach((doc, di) => {
    if (coveredDocs.has(di)) return;
    const full = (doc.text || '').trim();
    rows.push({
      date:        doc.date || 'לא ידוע',
      provider:    doc.institution || '',
      content:     full,    // no filtering available → show all (never hide)
      fullContent: full,
      fallback:    true,
    });
  });

  return rows;
}

// ── Split documents into batches by char budget (safe: coverage is verified) ─
export function batchByChars(docs, maxChars = 20000, maxDocs = 12) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const doc of docs) {
    const len = (doc.text || '').length;
    if (cur.length && (cur.length >= maxDocs || chars + len > maxChars)) {
      batches.push(cur); cur = []; chars = 0;
    }
    cur.push(doc);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ── METADATA response still uses JSON (no free text, so safe) ───────────────
export function parseMetadataResponse(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.trim());
    if (Array.isArray(parsed.documents)) return parsed.documents;
  } catch {}
  try {
    const block = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (block) {
      const parsed = JSON.parse(block[1]);
      if (Array.isArray(parsed.documents)) return parsed.documents;
    }
  } catch {}
  try {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) {
      const parsed = JSON.parse(raw.slice(s, e + 1));
      if (Array.isArray(parsed.documents)) return parsed.documents;
    }
  } catch {}
  return [];
}

// ── Reconstruct document text from PDF.js pages using Claude's boundaries ───
// Always returns at least one document (fallback = entire file as single doc)
export function reconstructDocuments(metadataDocs, pages) {
  if (metadataDocs.length === 0) {
    return [{
      date:        'לא ידוע',
      institution: '',
      visitType:   'אחר',
      text:        pages.map((p) => p.text).join('\n\n').trim(),
      isDuplicate: false,
    }];
  }

  return metadataDocs.map((meta) => {
    const start = Number(meta.startPage) || 1;
    const end   = Number(meta.endPage)   || pages.length;
    const text  = pages
      .filter((p) => p.pageNum >= start && p.pageNum <= end)
      .map((p) => p.text)
      .join('\n\n')
      .trim();
    return {
      date:        meta.date        || 'לא ידוע',
      institution: meta.institution || '',
      visitType:   meta.visitType   || 'אחר',
      text,
      isDuplicate: false,
    };
  });
}

// ── Semaphore: run tasks with max N concurrent ───────────────────────────────
export function semaphore(taskFns, maxConcurrent) {
  return new Promise((resolve) => {
    const results = new Array(taskFns.length);
    let nextIdx = 0;
    let running = 0;
    let done = 0;

    function startNext() {
      while (running < maxConcurrent && nextIdx < taskFns.length) {
        const i = nextIdx++;
        running++;
        taskFns[i]()
          .then((r)  => { results[i] = { value: r }; })
          .catch((e) => { results[i] = { error: e }; })
          .finally(() => {
            running--;
            done++;
            if (done === taskFns.length) resolve(results);
            else startNext();
          });
      }
    }

    if (taskFns.length === 0) resolve(results);
    else startNext();
  });
}

// ── Deduplicate + sort ───────────────────────────────────────────────────────
export function toTimestamp(dateStr) {
  if (!dateStr || dateStr === 'לא ידוע') return Number.MAX_SAFE_INTEGER;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y) return Number.MAX_SAFE_INTEGER;
  return new Date(y, m - 1, d).getTime();
}

// Normalize text for dedup: collapse whitespace + strip punctuation so
// OCR/formatting variance between copies of the same record still matches.
export function normalizeForDedup(text) {
  return (text ?? '')
    .replace(/[\s]+/g, ' ')
    .replace(/["'`.,;:!?\-–—()[\]{}]/g, '')
    .trim()
    .toLowerCase();
}

export function deduplicateAndSort(allDocuments) {
  const seen = new Set();
  const unique = allDocuments.filter((doc) => {
    if (doc.isDuplicate) return false;
    const key = `${(doc.date ?? '').trim()}::${normalizeForDedup(doc.text)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => toTimestamp(a.date) - toTimestamp(b.date));
  return unique;
}
