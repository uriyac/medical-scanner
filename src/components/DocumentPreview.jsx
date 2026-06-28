import { Fragment, useState } from 'react';
import {
  generateClinicalTableDocument,
  generateSummaryDocument,
} from '../utils/wordGenerator.js';
import { assessReadability } from '../utils/readability.js';

export default function DocumentPreview({ documents, warnings, onDownload, onReset }) {
  const [expanded, setExpanded] = useState(null);

  // Objective readability of each document's OCR output (high | partial | low).
  const readability = documents.map((d) =>
    assessReadability(d.text, { isHandwritten: d.isHandwritten })
  );

  // Reasons a document warrants a manual check against the source.
  // A header-less fragment (e.g. a record cut across a chunk boundary) comes
  // back with neither date nor institution — flag it for review rather than
  // silently merging, which could mis-attribute one provider's note to another.
  const reviewReasons = documents.map((d, i) => {
    const reasons = [];
    if (d.isHandwritten) reasons.push('כתב יד');
    if (readability[i].level === 'low' && !d.isHandwritten) reasons.push('קריאות נמוכה');
    const noDate = !d.date || d.date === 'לא ידוע';
    const noInst = !d.institution || d.institution === 'לא ידוע';
    if (noDate && noInst && (d.text || '').trim().length > 40) {
      reasons.push('ללא תאריך/מוסד — ייתכן מקטע שנחתך');
    }
    return reasons;
  });
  const reviewIdx = reviewReasons
    .map((r, i) => (r.length ? i : -1))
    .filter((i) => i >= 0);

  // Clinical-table feature state
  const [clinicalRows, setClinicalRows] = useState(null);
  const [clinicalStatus, setClinicalStatus] = useState('idle'); // idle | loading | done | error
  const [clinicalError, setClinicalError] = useState('');
  const [clinicalProgress, setClinicalProgress] = useState('');
  const [clinicalMode, setClinicalMode] = useState('filtered'); // filtered | full

  const toggle = (i) => setExpanded(expanded === i ? null : i);

  const saveBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const dateStamp = () => new Date().toLocaleDateString('he-IL').replace(/\//g, '-');

  const handleSummaryDownload = async () => {
    const blob = await generateSummaryDocument(documents);
    saveBlob(blob, `דף_סיכום_${dateStamp()}.docx`);
  };

  const dateToTs = (d) => {
    if (!d || d === 'לא ידוע') return Number.MAX_SAFE_INTEGER;
    const [dd, mm, yy] = d.split('/').map(Number);
    if (!dd || !mm || !yy) return Number.MAX_SAFE_INTEGER;
    return new Date(yy, mm - 1, dd).getTime();
  };

  const handleClinicalTable = async () => {
    setClinicalStatus('loading');
    setClinicalError('');
    setClinicalProgress('');

    // Send in chunks so we can show real progress; the server batches internally.
    const CHUNK = 8;
    const chunks = [];
    for (let i = 0; i < documents.length; i += CHUNK) {
      chunks.push(documents.slice(i, i + CHUNK));
    }

    try {
      const allRows = [];
      let done = 0;
      for (const chunk of chunks) {
        const res = await fetch('/api/clinical', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documents: chunk }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'שגיאת שרת' }));
          throw new Error(err.error || 'שגיאה לא ידועה');
        }
        const data = await res.json();
        allRows.push(...(data.rows ?? []));
        done += chunk.length;
        setClinicalProgress(`${done}/${documents.length}`);
      }

      if (!allRows.length) throw new Error('לא חולצו שורות קליניות');
      allRows.sort((a, b) => dateToTs(a.date) - dateToTs(b.date));
      setClinicalRows(allRows);
      setClinicalStatus('done');
      setClinicalMode('filtered');
    } catch (err) {
      setClinicalStatus('error');
      setClinicalError(err.message);
    }
  };

  // Pick the content field for the active mode (filtered vs full verbatim)
  const rowContent = (r) =>
    clinicalMode === 'full' ? (r.fullContent || r.content) : r.content;

  const handleClinicalDownload = async () => {
    const exportRows = clinicalRows.map((r) => ({ ...r, content: rowContent(r) }));
    const blob = await generateClinicalTableDocument(exportRows);
    const suffix = clinicalMode === 'full' ? 'מלא' : 'מסונן';
    saveBlob(blob, `טבלה_קלינית_${suffix}_${dateStamp()}.docx`);
  };

  return (
    <div>
      {/* Section label */}
      <p className="section-label">תוצאות עיבוד</p>

      {/* Header */}
      <div className="preview-header">
        <div className="preview-check">✓</div>
        <div>
          <p className="preview-title">נמצאו {documents.length} מסמכים</p>
          <p className="preview-subtitle">מסודרים כרונולוגית · ללא כפילויות · מוכנים להורדה</p>
        </div>
      </div>

      {/* Warnings (partial failures) */}
      {warnings?.length > 0 && (
        <div className="warning-banner">
          <span className="warning-icon">⚠</span>
          <div>
            <strong>הערות עיבוד:</strong>
            {warnings.map((w, i) => <p key={i} className="warning-line">{w}</p>)}
          </div>
        </div>
      )}

      {/* Review report — documents the system isn't confident about */}
      {reviewIdx.length > 0 && (
        <div className="warning-banner" style={{ background: '#fef2f2', borderColor: '#fecaca' }}>
          <span className="warning-icon">⚠</span>
          <div>
            <strong>{reviewIdx.length} מסמכים מומלצים לבדיקה ידנית מול המקור:</strong>
            {reviewIdx.map((i) => (
              <p key={i} className="warning-line">
                #{i + 1} · {documents[i].date || 'לא ידוע'} · {documents[i].institution || 'מוסד לא ידוע'}
                {documents[i].isHandwritten ? ' (כתב יד)' : ''} — {reviewReasons[i].join(' · ')}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Documents table */}
      <table className="doc-table">
        <thead>
          <tr>
            <th style={{ width: 28 }}>#</th>
            <th>תאריך</th>
            <th>מוסד רפואי</th>
            <th>סוג מסמך</th>
            <th style={{ width: 72 }}></th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc, i) => (
            <Fragment key={i}>
              <tr>
                <td className="doc-index">{i + 1}</td>
                <td className="doc-date">{doc.date || 'לא ידוע'}</td>
                <td className="doc-institution">{doc.institution || '—'}</td>
                <td>
                  <span className="doc-type">{doc.visitType || '—'}</span>
                  {readability[i].level === 'low' ? (
                    <span
                      className="doc-type"
                      title={`טקסט בקריאות נמוכה (${readability[i].illegible} מילים לא ברורות) — ה-OCR אינו אמין כאן, בדוק מול המקור`}
                      style={{ marginInlineStart: 6, background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}
                    >
                      ⚠ {doc.isHandwritten ? 'כתב יד — ' : ''}לא קריא, בדוק ידנית
                    </span>
                  ) : doc.isHandwritten ? (
                    <span
                      className="doc-type"
                      title="המסמך כתוב בכתב יד — ה-OCR עלול לטעות, מומלץ לאמת מול המקור"
                      style={{ marginInlineStart: 6, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
                    >
                      ✍ כתב יד — אמת מול המקור
                    </span>
                  ) : reviewReasons[i].some((r) => r.startsWith('ללא תאריך')) ? (
                    <span
                      className="doc-type"
                      title="לא זוהו תאריך/מוסד — ייתכן מקטע שנחתך מעמוד אחר; בדוק מול המקור"
                      style={{ marginInlineStart: 6, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
                    >
                      ללא תאריך/מוסד — בדוק
                    </span>
                  ) : readability[i].level === 'partial' ? (
                    <span
                      className="doc-type"
                      title={`${readability[i].illegible} מילים סומנו [לא ברור]`}
                      style={{ marginInlineStart: 6, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
                    >
                      {readability[i].illegible} מילים לא ברורות
                    </span>
                  ) : null}
                </td>
                <td>
                  <button
                    className={`btn-expand${expanded === i ? ' open' : ''}`}
                    onClick={() => toggle(i)}
                  >
                    {expanded === i ? '▲ סגור' : '▼ טקסט'}
                  </button>
                </td>
              </tr>
              {expanded === i && (
                <tr className="doc-text-row">
                  <td colSpan={5}>
                    <div className="doc-text-box">
                      {doc.text || '(אין טקסט)'}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* Primary action — full V2 Word */}
      <button className="btn-blue" onClick={onDownload}>
        ⬇ הורד קובץ Word (מלא)
      </button>

      {/* Extra outputs */}
      <div className="btn-row">
        <button className="btn-secondary" onClick={handleSummaryDownload}>
          📄 דף סיכום
        </button>
        <button
          className="btn-secondary"
          onClick={handleClinicalTable}
          disabled={clinicalStatus === 'loading'}
        >
          {clinicalStatus === 'loading'
            ? `⏳ מעבד ${clinicalProgress || '...'}`
            : '📋 טבלה קלינית (3 עמודות)'}
        </button>
      </div>

      {clinicalStatus === 'error' && (
        <div className="warning-banner" style={{ marginTop: 12 }}>
          <span className="warning-icon">⚠</span>
          <div>שגיאה ביצירת טבלה קלינית: {clinicalError}</div>
        </div>
      )}

      {/* Clinical table result */}
      {clinicalStatus === 'done' && clinicalRows && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <p className="section-label" style={{ margin: 0 }}>
              טבלה קלינית — {clinicalRows.length} שורות מתוך {documents.length} מסמכים
            </p>
            {/* Filter / show-all toggle */}
            <div className="clinical-toggle">
              <button
                className={`toggle-btn${clinicalMode === 'filtered' ? ' active' : ''}`}
                onClick={() => setClinicalMode('filtered')}
              >
                מסונן
              </button>
              <button
                className={`toggle-btn${clinicalMode === 'full' ? ' active' : ''}`}
                onClick={() => setClinicalMode('full')}
              >
                הצג הכל
              </button>
            </div>
          </div>

          {clinicalMode === 'full' && (
            <p className="page-desc" style={{ marginTop: 6, fontSize: 13 }}>
              מצב "הצג הכל" מציג את הטקסט המקורי שחולץ (verbatim), כולל מידע אדמיניסטרטיבי — להשוואה ובדיקה.
            </p>
          )}

          {clinicalRows.some((r) => r.fallback) && (
            <div className="warning-banner" style={{ marginTop: 8 }}>
              <span className="warning-icon">ℹ</span>
              <div>
                {clinicalRows.filter((r) => r.fallback).length} שורות סומנו בגיבוי — לא זוהה בהן תוכן קליני מובהק,
                ולכן הן מוצגות <strong>במלואן</strong> (ללא סינון) כדי שלא יושמט מידע. בדוק אותן ידנית.
              </div>
            </div>
          )}

          <table className="doc-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th style={{ width: 90 }}>תאריך</th>
                <th style={{ width: 160 }}>הגורם המטפל</th>
                <th>תוכן</th>
              </tr>
            </thead>
            <tbody>
              {clinicalRows.map((r, i) => (
                <tr key={i} style={r.fallback ? { background: '#fffbeb' } : undefined}>
                  <td className="doc-date">
                    {r.date || 'לא ידוע'}
                    {r.fallback && <span className="doc-type" style={{ marginInlineStart: 6, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>גיבוי</span>}
                  </td>
                  <td className="doc-institution">{r.provider || '—'}</td>
                  <td>
                    <div className="doc-text-box" style={{ margin: 0, maxHeight: 'none' }}>
                      {rowContent(r) || '(אין תוכן)'}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn-blue" onClick={handleClinicalDownload} style={{ marginTop: 12 }}>
            ⬇ הורד טבלה קלינית ({clinicalMode === 'full' ? 'מלאה' : 'מסוננת'}) — Word
          </button>
        </div>
      )}

      {/* Reset */}
      <div className="btn-row">
        <button className="btn-secondary" onClick={onReset}>
          ↩ עיבוד תיק חדש
        </button>
      </div>
    </div>
  );
}
