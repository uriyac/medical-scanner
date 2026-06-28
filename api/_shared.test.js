import { describe, it, expect } from 'vitest';
import {
  parseClaudeResponse,
  parseMetadataResponse,
  reconstructDocuments,
  deduplicateAndSort,
  toTimestamp,
  normalizeForDedup,
  buildLineNumberedInput,
  parseClinicalLineResponse,
  reconstructClinicalRows,
  batchByChars,
} from './_shared.js';

// ── parseClaudeResponse (scanned OCR format) ────────────────────────────────
describe('parseClaudeResponse', () => {
  const raw = `===DOCUMENT===
date: 01/02/2025
institution: בית חולים הדסה
visitType: ייעוץ מומחה
isDuplicate: false
isHandwritten: true
===TEXT===
שורה ראשונה
שורה שנייה
===END===`;

  it('parses fields including isHandwritten', () => {
    const [doc] = parseClaudeResponse(raw);
    expect(doc.date).toBe('01/02/2025');
    expect(doc.institution).toBe('בית חולים הדסה');
    expect(doc.visitType).toBe('ייעוץ מומחה');
    expect(doc.isDuplicate).toBe(false);
    expect(doc.isHandwritten).toBe(true);
  });

  it('preserves the text verbatim, including internal newlines', () => {
    const [doc] = parseClaudeResponse(raw);
    expect(doc.text).toBe('שורה ראשונה\nשורה שנייה');
  });

  it('parses multiple documents', () => {
    const two = raw + '\n' + raw.replace('01/02/2025', '03/03/2025');
    expect(parseClaudeResponse(two)).toHaveLength(2);
  });

  it('skips a block missing ===END=== and returns [] when nothing valid', () => {
    expect(parseClaudeResponse('===DOCUMENT===\ndate: 01/01/2020\n===TEXT===\nfoo')).toEqual([]);
    expect(parseClaudeResponse('')).toEqual([]);
  });

  it('falls back to JSON when the model ignores the delimiter format', () => {
    const json = '{"documents":[{"date":"01/02/2025","text":"abc"}]}';
    expect(parseClaudeResponse(json)).toEqual([{ date: '01/02/2025', text: 'abc' }]);
  });
});

// ── deduplicateAndSort ──────────────────────────────────────────────────────
describe('deduplicateAndSort', () => {
  it('removes exact duplicates (same date + normalized text)', () => {
    const docs = [
      { date: '01/01/2025', text: 'אותו טקסט' },
      { date: '01/01/2025', text: 'אותו טקסט' },
    ];
    expect(deduplicateAndSort(docs)).toHaveLength(1);
  });

  it('treats punctuation/whitespace variants as duplicates', () => {
    const docs = [
      { date: '01/01/2025', text: 'כאב גב, ימין.' },
      { date: '01/01/2025', text: 'כאב גב ימין' },
    ];
    expect(deduplicateAndSort(docs)).toHaveLength(1);
  });

  it('drops records explicitly marked isDuplicate', () => {
    const docs = [
      { date: '01/01/2025', text: 'a', isDuplicate: true },
      { date: '02/01/2025', text: 'b' },
    ];
    const out = deduplicateAndSort(docs);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('b');
  });

  it('sorts chronologically with "לא ידוע" dates last', () => {
    const docs = [
      { date: '05/05/2025', text: 'b' },
      { date: 'לא ידוע', text: 'c' },
      { date: '01/01/2025', text: 'a' },
    ];
    expect(deduplicateAndSort(docs).map((d) => d.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('toTimestamp', () => {
  it('parses DD/MM/YYYY', () => {
    expect(toTimestamp('01/02/2025')).toBe(new Date(2025, 1, 1).getTime());
  });
  it('returns MAX for unknown/invalid', () => {
    expect(toTimestamp('לא ידוע')).toBe(Number.MAX_SAFE_INTEGER);
    expect(toTimestamp('garbage')).toBe(Number.MAX_SAFE_INTEGER);
    expect(toTimestamp('')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('normalizeForDedup', () => {
  it('collapses whitespace and strips punctuation', () => {
    expect(normalizeForDedup('שלום,   עולם!')).toBe('שלום עולם');
  });
});

// ── reconstructDocuments (digital path) ─────────────────────────────────────
describe('reconstructDocuments', () => {
  const pages = [
    { pageNum: 1, text: 'p1' },
    { pageNum: 2, text: 'p2' },
    { pageNum: 3, text: 'p3' },
  ];

  it('joins pages within the given boundary', () => {
    const [doc] = reconstructDocuments(
      [{ startPage: 1, endPage: 2, date: '01/01/2020', institution: 'A', visitType: 'אחר' }],
      pages
    );
    expect(doc.text).toBe('p1\n\np2');
  });

  it('falls back to the whole file as one document when no boundaries', () => {
    const out = reconstructDocuments([], pages);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('p1\n\np2\n\np3');
  });
});

// ── Clinical line-marker pipeline ───────────────────────────────────────────
describe('clinical line-marker reconstruction', () => {
  it('rebuilds content from original lines, never from model text', () => {
    const docs = [{ date: '01/02/2025', institution: 'מרפאה', text: 'שורה1\nשורה2\nשורה3' }];
    const { lineMap, docLineRange } = buildLineNumberedInput(docs);
    const events = [{ date: '01/02/2025', provider: 'מרפאה', lines: [1, 2] }];
    const [row] = reconstructClinicalRows(events, docs, lineMap, docLineRange);
    expect(row.content).toBe('שורה1\nשורה2');
    expect(row.fullContent).toBe('שורה1\nשורה2\nשורה3'); // verbatim original
  });

  it('emits a fallback row for any document with no event (never drops a doc)', () => {
    const docs = [{ date: '05/05/2020', institution: 'Y', text: 'תוכן' }];
    const { lineMap, docLineRange } = buildLineNumberedInput(docs);
    const [row] = reconstructClinicalRows([], docs, lineMap, docLineRange);
    expect(row.fallback).toBe(true);
    expect(row.content).toBe('תוכן');
  });
});

describe('parseClinicalLineResponse', () => {
  it('expands line ranges and normalizes en-dashes', () => {
    const raw = '===ROW===\ndate: 03/04/2025\nprovider: דר כהן\nlines: 3–5,8\n===END===';
    const [ev] = parseClinicalLineResponse(raw);
    expect(ev.date).toBe('03/04/2025');
    expect(ev.lines).toEqual([3, 4, 5, 8]);
  });
});

describe('batchByChars', () => {
  it('splits by document count cap', () => {
    const docs = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
    expect(batchByChars(docs, 20000, 2)).toEqual([[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]]);
  });

  it('splits by char budget', () => {
    const docs = [{ text: 'x'.repeat(10) }, { text: 'y'.repeat(10) }];
    expect(batchByChars(docs, 15, 12)).toHaveLength(2);
  });
});

describe('parseMetadataResponse', () => {
  it('parses a JSON object', () => {
    const out = parseMetadataResponse('{"documents":[{"startPage":1,"endPage":2}]}');
    expect(out).toEqual([{ startPage: 1, endPage: 2 }]);
  });
  it('parses JSON inside a code block', () => {
    const out = parseMetadataResponse('```json\n{"documents":[{"startPage":1}]}\n```');
    expect(out).toEqual([{ startPage: 1 }]);
  });
});
