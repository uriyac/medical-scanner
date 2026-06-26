import {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  TextRun, WidthType, AlignmentType, PageBreak,
  BorderStyle, HeadingLevel, convertInchesToTwip,
} from 'docx';

// ─── Borders ─────────────────────────────────────────────
const THIN  = { style: BorderStyle.SINGLE, size: 4,  color: '000000' };
const THICK = { style: BorderStyle.SINGLE, size: 8,  color: '000000' };
const NONE  = { style: BorderStyle.NONE,   size: 0,  color: 'FFFFFF' };

const TABLE_BORDERS = {
  top: THICK, bottom: THIN, left: THIN, right: THIN,
  insideHorizontal: THIN, insideVertical: THIN,
};

// Column widths (DXA = twips; A4 usable ≈ 8918 twips with 0.75" margins)
const COL_DATE  = 1500;  // ~2.6cm
const COL_INST  = 4600;  // ~8.1cm
const COL_TYPE  = 2818;  // ~5cm

// ─── Helpers ─────────────────────────────────────────────
function rtl(children, opts = {}) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    ...opts,
    children,
  });
}

function run(text, opts = {}) {
  return new TextRun({ text: text ?? '', font: 'David', ...opts });
}

function headerCell(text, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: TABLE_BORDERS,
    shading: { fill: 'F0F4F8' },
    children: [rtl([run(text, { bold: true, size: 20 })])],
  });
}

function dataCell(text, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: TABLE_BORDERS,
    children: [rtl([run(text || 'לא ידוע', { size: 20 })])],
  });
}

// ─── Summary Table ────────────────────────────────────────
function buildSummaryTable(documents) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      headerCell('תאריך',    COL_DATE),
      headerCell('מוסד רפואי', COL_INST),
      headerCell('סוג מסמך',  COL_TYPE),
    ],
  });

  const dataRows = documents.map(
    (doc, idx) =>
      new TableRow({
        children: [
          dataCell(doc.date,        COL_DATE),
          dataCell(doc.institution, COL_INST),
          dataCell(doc.visitType,   COL_TYPE),
        ],
      })
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

// ─── Record Section ───────────────────────────────────────
function buildRecord(doc, isFirst) {
  const headerText =
    `${doc.date || 'לא ידוע'}   ·   ${doc.institution || 'לא ידוע'}   ·   ${doc.visitType || 'לא ידוע'}`;

  const textLines = (doc.text || '').split('\n').map((line) =>
    rtl([run(line, { size: 20 })], { spacing: { after: 20 } })
  );

  return [
    // Document header
    rtl(
      [run(headerText, { bold: true, size: 22, color: '1e3a5f' })],
      {
        pageBreakBefore: !isFirst,
        spacing: { before: isFirst ? 0 : 0, after: 120 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: '1e3a5f', space: 4 },
        },
      }
    ),
    // Spacer
    rtl([], { spacing: { after: 120 } }),
    // Verbatim text
    ...textLines,
    // Section end spacer
    rtl([], { spacing: { after: 480 } }),
  ];
}

// ═══ CLINICAL TABLE feature (3 columns: date / provider / content) ═══════════
const CLIN_COL_DATE     = 1400;  // ~2.5cm
const CLIN_COL_PROVIDER = 2600;  // ~4.6cm
const CLIN_COL_CONTENT  = 4918;  // remaining width

// A cell whose text may contain multiple lines (clinical content).
function multilineCell(text, width, opts = {}) {
  const lines = (text || '').split('\n');
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: TABLE_BORDERS,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: lines.map((line) => rtl([run(line, { size: 20 })], { spacing: { after: 20 } })),
    ...opts,
  });
}

function buildClinicalTable(rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      headerCell('תאריך',         CLIN_COL_DATE),
      headerCell('הגורם המטפל',   CLIN_COL_PROVIDER),
      headerCell('תוכן',          CLIN_COL_CONTENT),
    ],
  });

  const dataRows = rows.map(
    (r) =>
      new TableRow({
        children: [
          dataCell(r.date,     CLIN_COL_DATE),
          dataCell(r.provider, CLIN_COL_PROVIDER),
          multilineCell(r.content, CLIN_COL_CONTENT),
        ],
      })
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

export async function generateClinicalTableDocument(rows) {
  const today = new Date().toLocaleDateString('he-IL');

  const doc = new Document({
    creator:     'MediRecord',
    description: 'טבלה קלינית',
    sections: [{
      properties: {
        bidi: true,
        page: {
          margin: {
            top:    convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            right:  convertInchesToTwip(0.75),
            left:   convertInchesToTwip(0.75),
          },
        },
      },
      children: [
        rtl(
          [run('טבלה קלינית', { bold: true, size: 36, color: '1e3a5f' })],
          { heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }
        ),
        rtl(
          [
            run(`תאריך הפקה: ${today}`, { size: 20, color: '64748b' }),
            run('     |     ', { size: 20, color: 'b0b8c4' }),
            run(`סה"כ רשומות: ${rows.length}`, { size: 20, color: '64748b' }),
          ],
          { spacing: { after: 320 } }
        ),
        buildClinicalTable(rows),
      ],
    }],
  });

  return Packer.toBlob(doc);
}

// ═══ SUMMARY PAGE feature (date / institution / type — table only) ════════════
export async function generateSummaryDocument(documents) {
  const today = new Date().toLocaleDateString('he-IL');

  const doc = new Document({
    creator:     'MediRecord',
    description: 'דף סיכום',
    sections: [{
      properties: {
        bidi: true,
        page: {
          margin: {
            top:    convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            right:  convertInchesToTwip(0.75),
            left:   convertInchesToTwip(0.75),
          },
        },
      },
      children: [
        rtl(
          [run('דף סיכום מסמכים רפואיים', { bold: true, size: 36, color: '1e3a5f' })],
          { heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }
        ),
        rtl(
          [
            run(`תאריך הפקה: ${today}`, { size: 20, color: '64748b' }),
            run('     |     ', { size: 20, color: 'b0b8c4' }),
            run(`סה"כ מסמכים: ${documents.length}`, { size: 20, color: '64748b' }),
          ],
          { spacing: { after: 320 } }
        ),
        buildSummaryTable(documents),
      ],
    }],
  });

  return Packer.toBlob(doc);
}

// ─── Main export ─────────────────────────────────────────
export async function generateWordDocument(documents) {
  const today = new Date().toLocaleDateString('he-IL');

  const doc = new Document({
    creator:     'MediRecord',
    description: 'תיק רפואי מאוחד',
    sections: [
      {
        properties: {
          bidi: true,
          page: {
            margin: {
              top:    convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              right:  convertInchesToTwip(0.75),
              left:   convertInchesToTwip(0.75),
            },
          },
        },
        children: [
          // ── Cover heading ──
          rtl(
            [run('ריכוז מסמכים רפואיים', { bold: true, size: 40, color: '1e3a5f' })],
            { heading: HeadingLevel.HEADING_1, spacing: { after: 160 } }
          ),
          rtl(
            [
              run(`תאריך הפקה: ${today}`, { size: 20, color: '64748b' }),
              run('     |     ', { size: 20, color: 'b0b8c4' }),
              run(`סה"כ מסמכים: ${documents.length}`, { size: 20, color: '64748b' }),
            ],
            { spacing: { after: 480 } }
          ),

          // ── Summary table ──
          buildSummaryTable(documents),

          // ── Page break before records ──
          new Paragraph({ children: [new PageBreak()] }),

          // ── Records ──
          ...documents.flatMap((d, idx) => buildRecord(d, idx === 0)),
        ],
      },
    ],
  });

  return Packer.toBlob(doc);
}
