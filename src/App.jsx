import { useState, useCallback, useRef } from 'react';
import { generateWordDocument } from './utils/wordGenerator.js';
import { extractPdfInfo, splitPdfBatches, renderPageBatches } from './utils/pdfExtractor.js';
import LoginPage from './components/LoginPage.jsx';
import DocumentPreview from './components/DocumentPreview.jsx';

const MAX_FILE_MB = 15;
const REQUEST_CONCURRENCY = 5;          // best reliable value at current API tier (measured); raise after tier upgrade
const WHOLE_PDF_MAX_BYTES = 2.7 * 1024 * 1024; // below this, a tiny PDF may be sent whole
const WHOLE_PDF_MAX_PAGES = 2;          // ...but only up to 2 pages — a dense page OCRs in ~22s,
                                        // so 2 pages (~43s) stays under Vercel's 60s function limit
const SCANNED_PAGES_PER_CHUNK = 2;      // pages per native sub-PDF; measured: 3 dense pages = ~65s (>60s → killed)

const STEPS = [
  'מחלץ וממיר קבצים...',
  'שולח ל-Claude AI לניתוח...',
  'מזהה מסמכים ומזהה גבולות...',
  'מסדר כרונולוגית ומסנן כפילויות...',
];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Client-side dedupe + chronological sort (results are merged from many requests)
function toTimestamp(dateStr) {
  if (!dateStr || dateStr === 'לא ידוע') return Number.MAX_SAFE_INTEGER;
  const [d, m, y] = dateStr.split('/').map(Number);
  if (!d || !m || !y) return Number.MAX_SAFE_INTEGER;
  return new Date(y, m - 1, d).getTime();
}

// Normalize text for dedup: collapse all whitespace and strip punctuation/quotes
// so OCR/formatting variance between copies doesn't prevent matching.
function normalizeForDedup(text) {
  return (text ?? '')
    .replace(/[\s]+/g, ' ')
    .replace(/["'`.,;:!?\-–—()[\]{}]/g, '')
    .trim()
    .toLowerCase();
}

function dedupeAndSort(docs) {
  const seen = new Set();
  const unique = docs.filter((doc) => {
    if (doc.isDuplicate) return false;
    const key = `${(doc.date ?? '').trim()}::${normalizeForDedup(doc.text)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => toTimestamp(a.date) - toTimestamp(b.date));
  return unique;
}

// Run async tasks with a concurrency cap; calls onDone() after each completes.
async function runPool(tasks, concurrency, onDone) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const my = idx++;
      await tasks[my]();
      onDone?.();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [nonPdfAlert, setNonPdfAlert] = useState(false);
  const [status, setStatus] = useState('idle');
  const [stepIndex, setStepIndex] = useState(0);
  const [progressNote, setProgressNote] = useState('');
  const [documents, setDocuments] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const stepTimerRef = useRef(null);

  const addFiles = useCallback((incoming) => {
    const all  = Array.from(incoming);
    const pdfs = all.filter((f) => f.type === 'application/pdf');
    if (all.length > pdfs.length) {
      setNonPdfAlert(true);
      setTimeout(() => setNonPdfAlert(false), 3500);
    }
    if (!pdfs.length) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...pdfs.filter((f) => !existing.has(f.name + f.size))];
    });
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const startStepAnimation = (startAt = 0) => {
    setStepIndex(startAt);
    let i = startAt;
    stepTimerRef.current = setInterval(() => {
      i = Math.min(i + 1, STEPS.length - 1);
      setStepIndex(i);
      if (i === STEPS.length - 1) clearInterval(stepTimerRef.current);
    }, 5000);
  };

  // POST a single small unit ( < 4MB ) and return its documents.
  const postUnit = async (unitFiles) => {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: unitFiles }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'שגיאת שרת' }));
      throw new Error(err.error || 'שגיאה לא ידועה');
    }
    const data = await res.json();
    return data.documents ?? [];
  };

  const handleProcess = async () => {
    setStatus('processing');
    setError('');
    setDocuments(null);
    setWarnings([]);
    setStepIndex(0);
    setProgressNote('');

    try {
      // ── Step 0: Client-side analysis → build small per-unit requests ──────
      // Each unit stays under Vercel's 4.5MB body limit (digital text, or a
      // size-packed batch of rendered JPEG pages for scanned files).
      const units = []; // each: array of one payload item for /api/process

      for (const f of files) {
        const { pages, numPages, isDigital, garbled } = await extractPdfInfo(f);

        if (isDigital) {
          units.push([{ name: f.name, type: 'digital', pages }]);
          continue;
        }

        // Broken text layer (scrambled Hebrew): the page renders correctly, so
        // OCR the rendered images. Skip the native-PDF path — Claude must not
        // see the corrupt text layer, only the real pixels.
        if (garbled) {
          setProgressNote(`סורק ${f.name} (טקסט פגום)...`);
          const batches = await renderPageBatches(f, numPages, (n, total) => {
            setProgressNote(`ממיר עמודים ${n}/${total}: ${f.name}`);
          });
          if (batches.length === 0) {
            const base64 = await fileToBase64(f);
            units.push([{ name: f.name, type: 'scanned', base64 }]);
          } else {
            for (const b of batches) {
              units.push([{ name: f.name, type: 'scanned_batch', pageImages: b.pageImages }]);
            }
          }
          continue;
        }

        // Scanned + tiny (≤2 pages) → send whole in ONE native call (stays under 60s).
        if (numPages <= WHOLE_PDF_MAX_PAGES && f.size <= WHOLE_PDF_MAX_BYTES) {
          const base64 = await fileToBase64(f);
          units.push([{ name: f.name, type: 'scanned', base64 }]);
          continue;
        }

        // Large scanned → split into small NATIVE sub-PDFs (fast, no rendering)
        // so many OCR calls run in parallel. Falls back to JPEG rendering if
        // the PDF can't be split (corrupted/encrypted structure).
        setProgressNote(`מכין ${f.name}...`);
        try {
          const chunks = await splitPdfBatches(f, SCANNED_PAGES_PER_CHUNK);
          for (const c of chunks) {
            units.push([{ name: f.name, type: 'scanned', base64: c.base64 }]);
          }
        } catch {
          const batches = await renderPageBatches(f, numPages, (n, total) => {
            setProgressNote(`ממיר עמודים ${n}/${total}: ${f.name}`);
          });
          if (batches.length === 0) {
            const base64 = await fileToBase64(f);
            units.push([{ name: f.name, type: 'scanned', base64 }]);
          } else {
            for (const b of batches) {
              units.push([{ name: f.name, type: 'scanned_batch', pageImages: b.pageImages }]);
            }
          }
        }
      }
      setProgressNote('');

      // ── Steps 1-3: send units in parallel (concurrency-capped) ────────────
      startStepAnimation(1);

      const allDocs = [];
      const unitWarnings = [];
      let done = 0;
      const total = units.length;

      const tasks = units.map((unitFiles) => async () => {
        try {
          const docs = await postUnit(unitFiles);
          allDocs.push(...docs);
        } catch (e) {
          unitWarnings.push(`שגיאה בעיבוד ${unitFiles[0]?.name ?? ''}: ${e.message}`);
        }
      });

      await runPool(tasks, REQUEST_CONCURRENCY, () => {
        done += 1;
        setProgressNote(`מעבד יחידות ${done}/${total}`);
      });

      clearInterval(stepTimerRef.current);
      setProgressNote('');

      const documents = dedupeAndSort(allDocs);
      if (!documents.length) throw new Error('לא נמצאו מסמכים בקבצים שהועלו');

      setDocuments(documents);
      setWarnings(unitWarnings);
      setStatus('done');

    } catch (err) {
      clearInterval(stepTimerRef.current);
      setStatus('error');
      setError(err.message);
    }
  };

  const handleDownload = async () => {
    const blob = await generateWordDocument(documents);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `תיק_רפואי_${new Date().toLocaleDateString('he-IL').replace(/\//g, '-')}.docx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    clearInterval(stepTimerRef.current);
    setFiles([]);
    setStatus('idle');
    setDocuments(null);
    setWarnings([]);
    setError('');
    setStepIndex(0);
    setProgressNote('');
  };

  const oversizedFiles = files.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);

  if (!authenticated) return <LoginPage onLogin={() => setAuthenticated(true)} />;

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-brand">
          <div className="header-badge">MR</div>
          <span className="header-name">MediRecord</span>
          <span className="header-tag">BETA</span>
        </div>
        <button className="btn-logout" onClick={() => setAuthenticated(false)}>יציאה</button>
      </header>

      <main className="app-content">

        {/* ══ IDLE ══ */}
        {status === 'idle' && (
          <>
            <p className="section-label">העלאת מסמכים</p>
            <p className="page-title">ארגון תיק רפואי</p>
            <p className="page-desc">
              העלה קבצי PDF — המערכת תזהה כל מסמך, תסדר כרונולוגית, תסנן כפילויות ותייצר קובץ Word מסודר.
            </p>

            {nonPdfAlert && (
              <div className="alert-banner">
                ⚠ קבצים שאינם PDF הושמטו. רק קבצי .pdf נתמכים.
              </div>
            )}

            <div
              className={`upload-zone${dragOver ? ' drag-over' : ''}`}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,application/pdf"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => addFiles(e.target.files)}
              />
              <div className="upload-icon-wrap">📄</div>
              <h3>גרור קבצי PDF לכאן</h3>
              <p>או לחץ לבחירה מהמחשב · מספר קבצים בבת אחת</p>
            </div>

            {files.length > 0 && (
              <div className="file-list">
                <div className="file-list-header">
                  <span>{files.length} {files.length === 1 ? 'קובץ' : 'קבצים'} נבחרו</span>
                  <button className="btn-clear-all" onClick={() => setFiles([])}>נקה הכל</button>
                </div>
                {files.map((f, i) => (
                  <div key={i} className="file-item">
                    <span className="file-dot" style={f.size > MAX_FILE_MB * 1024 * 1024 ? { background: '#f59e0b' } : {}} />
                    <span className="file-name">{f.name}</span>
                    <span className="file-size" style={f.size > MAX_FILE_MB * 1024 * 1024 ? { color: '#f59e0b', borderColor: '#f59e0b' } : {}}>
                      {(f.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                    <button className="file-remove" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {oversizedFiles.length > 0 && (
              <div className="warning-banner" style={{ marginTop: 10 }}>
                <span className="warning-icon">⚠</span>
                <div>{oversizedFiles.length} קובץ/ים גדולים מ-{MAX_FILE_MB}MB — העיבוד עשוי להיות חלקי.</div>
              </div>
            )}

            {files.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <button className="btn-primary" onClick={handleProcess}>
                  ⚡ עבד מסמכים
                </button>
                <div className="btn-row">
                  <button className="btn-secondary" onClick={() => inputRef.current?.click()}>
                    + הוסף קבצים
                  </button>
                  <button className="btn-secondary" onClick={() => setFiles([])}>
                    ✕ נקה הכל
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ══ PROCESSING ══ */}
        {status === 'processing' && (
          <div className="status-card">
            <div className="spinner" />
            <div className="step-track">
              {STEPS.map((s, i) => (
                <div key={i} className={`step-item${i === stepIndex ? ' active' : ''}${i < stepIndex ? ' done' : ''}`}>
                  <span className="step-dot" />
                  <span className="step-label">
                    {i === 0 && progressNote ? progressNote : s}
                  </span>
                </div>
              ))}
            </div>
            {progressNote && stepIndex > 0 && (
              <div className="progress-note">{progressNote}</div>
            )}
          </div>
        )}

        {/* ══ DONE ══ */}
        {status === 'done' && documents && (
          <DocumentPreview
            documents={documents}
            warnings={warnings}
            onDownload={handleDownload}
            onReset={reset}
          />
        )}

        {/* ══ ERROR ══ */}
        {status === 'error' && (
          <div className="status-card error">
            <div className="error-icon">⚠</div>
            <p className="error-text">{error}</p>
            <button className="btn-secondary" onClick={() => setStatus('idle')}>
              ↩ חזור ונסה שוב
            </button>
          </div>
        )}

      </main>
    </div>
  );
}
