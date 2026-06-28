import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MIN_CHARS_PER_PAGE = 40;
const RENDER_SCALE = 1.2;
const JPEG_QUALITY = 0.72;

// Common Hebrew words that appear in virtually any real Hebrew medical text.
// A broken font encoding (missing/wrong ToUnicode map) yields real Hebrew
// LETTERS scrambled into nonsense words — character counts look fine, so the
// file passes the "isDigital" check, but the extracted text is gibberish.
// The tell: almost none of these common words survive the scramble.
const COMMON_HEBREW_WORDS = new Set([
  'של', 'את', 'על', 'לא', 'עם', 'או', 'אל', 'כי', 'גם', 'זה', 'יש', 'כל',
  'אם', 'כך', 'אך', 'רק', 'הוא', 'היא', 'אני', 'אבל', 'אחרי', 'לפני', 'ללא',
  'יותר', 'מאוד', 'בית', 'חולים', 'בדיקה', 'טיפול', 'רופא', 'מטופל', 'תאריך',
  'תלונה', 'ימין', 'שמאל', 'כאב', 'ללא', 'תקין', 'ביקור', 'מרפאה',
]);

// Detect a broken text layer: real Hebrew running text is full of common words,
// scrambled/reversed text has essentially none. Returns true only with enough
// signal (so short or non-Hebrew docs are never falsely flagged).
function hebrewLooksGarbled(text) {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/[^א-ת]/g, '')) // keep Hebrew letters only
    .filter((w) => w.length >= 2);                   // ignore single letters/noise
  if (words.length < 15) return false;               // too little to judge
  const hits = words.filter((w) => COMMON_HEBREW_WORDS.has(w)).length;
  return hits / words.length < 0.02;                 // <2% common words → broken
}

// Keep each request well under Vercel's 4.5MB body limit (base64 + JSON overhead)
const MAX_BATCH_BYTES = 3_300_000;
const MAX_BATCH_PAGES = 15;

// Extract text from a digital PDF page-by-page.
// Returns error:string if the PDF is encrypted/corrupted — caller falls back to scanned mode.
export async function extractPdfInfo(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const numPages = pdf.numPages;
    const pages = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) {
          text += item.str;
          text += item.hasEOL ? '\n' : ' ';
        }
      }
      pages.push({ pageNum: i, text: text.trim() });
    }

    const totalChars = pages.reduce((s, p) => s + p.text.length, 0);
    const avgCharsPerPage = numPages > 0 ? totalChars / numPages : 0;
    const hasEnoughText = avgCharsPerPage >= MIN_CHARS_PER_PAGE;

    // A PDF can have plenty of text yet a broken encoding (scrambled Hebrew).
    // In that case the visual page is fine, so treat it as scanned → OCR the
    // rendered pixels instead of trusting the corrupt text layer.
    const fullText = pages.map((p) => p.text).join(' ');
    const garbled = hasEnoughText && hebrewLooksGarbled(fullText);
    const isDigital = hasEnoughText && !garbled;

    return { pages, numPages, isDigital, garbled, error: null };
  } catch (err) {
    return { pages: [], numPages: 0, isDigital: false, garbled: false, error: err.message };
  }
}

// Render pages of a scanned PDF to JPEG base64 images, packed into batches that
// each stay under MAX_BATCH_BYTES (so every request fits Vercel's 4.5MB limit).
// onProgress(renderedCount, totalPages) called after each page for UI updates.
export async function renderPageBatches(file, numPages, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;

  const batches = [];
  let cur = [];
  let curBytes = 0;
  let rendered = 0;

  const flush = () => {
    if (cur.length) {
      batches.push({
        startPage: cur[0].pageNum,
        endPage:   cur[cur.length - 1].pageNum,
        pageImages: cur,
      });
      cur = [];
      curBytes = 0;
    }
  };

  // Render in small parallel chunks to avoid UI jank, then pack by size.
  for (let i = 1; i <= numPages; i += 3) {
    const chunkEnd = Math.min(i + 2, numPages);
    const chunk = await Promise.all(
      Array.from({ length: chunkEnd - i + 1 }, (_, j) => renderPage(pdf, i + j))
    );
    for (const img of chunk) {
      const bytes = img.jpeg.length;
      // Start a new batch if adding this page would exceed budget or page cap.
      if (cur.length && (curBytes + bytes > MAX_BATCH_BYTES || cur.length >= MAX_BATCH_PAGES)) {
        flush();
      }
      cur.push(img);
      curBytes += bytes;
    }
    rendered += chunk.length;
    onProgress?.(rendered, numPages);
  }
  flush();

  return batches;
}

// Split a scanned PDF into small native sub-PDFs (no rendering — fast, and
// Claude OCRs native PDFs directly with high quality). Each chunk stays well
// under Vercel's 4.5MB body limit. Returns [{ startPage, endPage, base64 }].
export async function splitPdfBatches(file, pagesPerChunk = 4) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const n = src.getPageCount();

  const chunks = [];
  for (let start = 0; start < n; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, n);
    const out = await PDFDocument.create();
    const idx = Array.from({ length: end - start }, (_, k) => start + k);
    const pages = await out.copyPages(src, idx);
    pages.forEach((p) => out.addPage(p));
    const outBytes = await out.save();
    chunks.push({ startPage: start + 1, endPage: end, base64: uint8ToBase64(outBytes) });
  }
  return chunks;
}

// Base64-encode a Uint8Array in chunks (avoids call-stack limits on big arrays).
function uint8ToBase64(u8) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function renderPage(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const jpeg = canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
  return { pageNum, jpeg };
}
