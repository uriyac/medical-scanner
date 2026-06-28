import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import { hebrewLooksGarbled } from './readability.js';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MIN_CHARS_PER_PAGE = 40;
const RENDER_SCALE = 2.0;   // higher DPI → markedly better OCR on faint scans / handwriting
const JPEG_QUALITY = 0.72;

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

// Split a native sub-PDF (base64) into one base64 PDF per page. Used to RETRY a
// failed OCR unit page-by-page so a single bad/slow page can't lose the whole
// chunk. Returns the original (single-element) if it already has ≤1 page.
export async function splitBase64ToPages(base64) {
  const src = await PDFDocument.load(base64, { ignoreEncryption: true });
  const n = src.getPageCount();
  if (n <= 1) return [base64];
  const out = [];
  for (let i = 0; i < n; i++) {
    const doc = await PDFDocument.create();
    const [pg] = await doc.copyPages(src, [i]);
    doc.addPage(pg);
    out.push(await doc.saveAsBase64());
  }
  return out;
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
