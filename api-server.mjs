import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import {
  SYSTEM_PROMPT, EXTRACTION_PROMPT, METADATA_PROMPT, CLINICAL_TABLE_PROMPT,
  parseClaudeResponse, parseMetadataResponse,
  reconstructDocuments, deduplicateAndSort, semaphore, toTimestamp,
  buildLineNumberedInput, parseClinicalLineResponse, reconstructClinicalRows, batchByChars,
} from './api/_shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
  }
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  חסר ANTHROPIC_API_KEY בקובץ .env');
  process.exit(1);
}

const MAX_BODY = 50 * 1024 * 1024;
const MAX_CONCURRENT = 5; // max simultaneous Claude calls across all files

// ── Single-file processors ───────────────────────────────────────────────────

async function processDigital(client, file) {
  const pagedText = file.pages
    .map((p) => `[עמוד ${p.pageNum}]\n${p.text}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: METADATA_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `---\n\n${pagedText}` },
      ],
    }],
  });

  const raw = response.content[0]?.text ?? '';
  const metadata = parseMetadataResponse(raw);
  console.log(`[digital] ${file.name}: ${metadata.length} docs`);
  return reconstructDocuments(metadata, file.pages);
}

async function processScanned(client, file) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.base64 } },
        { type: 'text', text: EXTRACTION_PROMPT },
      ],
    }],
  });
  const raw = response.content[0]?.text ?? '';
  const docs = parseClaudeResponse(raw);
  console.log(`[scanned] ${file.name}: ${docs.length} docs`);
  return docs;
}

async function processScannedBatch(client, batch) {
  // One batch of rendered page images (up to 10 pages).
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        ...batch.pageImages.map((p) => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: p.jpeg },
        })),
        { type: 'text', text: EXTRACTION_PROMPT },
      ],
    }],
  });
  return parseClaudeResponse(response.content[0]?.text ?? '');
}

// ── Route each file to the right processor ──────────────────────────────────

function buildTasksForFile(client, file) {
  if (file.type === 'digital') {
    console.log(`  ↳ דיגיטלי: ${file.name} (${file.pages.length} עמ')`);
    return [() => processDigital(client, file)];
  }

  if (file.type === 'scanned') {
    console.log(`  ↳ סרוק קטן: ${file.name}`);
    return [() => processScanned(client, file)];
  }

  if (file.type === 'scanned_batch') {
    console.log(`  ↳ אצוות סרוקה: ${file.name} (${file.pageImages.length} עמ')`);
    return [() => processScannedBatch(client, file)];
  }

  if (file.type === 'scanned_large') {
    const n = file.batches.length;
    console.log(`  ↳ סרוק גדול: ${file.name} (${n} באצ'ים)`);
    return file.batches.map((batch, i) => async () => {
      const docs = await processScannedBatch(client, batch);
      console.log(`     באץ' ${i + 1}/${n}: ${docs.length} מסמכים`);
      return docs;
    });
  }

  return [];
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function handleProcess(body) {
  const { files } = body;
  if (!Array.isArray(files) || files.length === 0) {
    throw Object.assign(new Error('לא נשלחו קבצים'), { status: 400 });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 8 });

  // Flatten all tasks (one file may produce multiple batch tasks)
  const taskMeta = []; // { fileIndex, taskFn }
  files.forEach((file, fi) => {
    buildTasksForFile(client, file).forEach((fn) => taskMeta.push({ fi, fn }));
  });

  console.log(`\n⚡ ${files.length} קבצים → ${taskMeta.length} משימות (מקס ${MAX_CONCURRENT} מקביל)`);

  const settled = await semaphore(taskMeta.map(({ fn }) => fn), MAX_CONCURRENT);

  // Group results back by file
  const allDocuments = [];
  const errors = [];

  files.forEach((file, fi) => {
    const fileTasks = taskMeta
      .map((m, ti) => ({ ...m, result: settled[ti] }))
      .filter((m) => m.fi === fi);

    const fileDocs = [];
    let fileError = false;

    fileTasks.forEach(({ result }) => {
      if (result.error) {
        console.error(`  ❌ ${file.name}:`, result.error.message);
        fileError = true;
      } else {
        fileDocs.push(...(result.value ?? []));
      }
    });

    if (fileDocs.length === 0) {
      errors.push(fileError
        ? `שגיאה בעיבוד ${file.name}`
        : `לא נמצאו מסמכים בקובץ: ${file.name}`);
    } else {
      console.log(`  ✓ ${file.name}: ${fileDocs.length} מסמכים`);
      allDocuments.push(...fileDocs);
    }
  });

  if (allDocuments.length === 0) {
    throw Object.assign(
      new Error('לא נמצאו מסמכים בקבצים שהועלו'),
      { status: 422, details: errors }
    );
  }

  const documents = deduplicateAndSort(allDocuments);
  console.log(`\n✓ סה"כ ${documents.length} מסמכים ייחודיים\n`);
  return { documents, warnings: errors.length ? errors : undefined };
}

// ── CLINICAL TABLE feature ───────────────────────────────────────────────────
// Takes the already-extracted documents and produces a filtered 3-column table
// (date / provider / clinical content). One Claude call per document.

// Guaranteed fallback rows for a whole batch (used only if a call fails).
function fallbackRows(docs) {
  return docs.map((doc) => {
    const full = (doc.text || '').trim();
    return {
      date:        doc.date || 'לא ידוע',
      provider:    doc.institution || '',
      content:     full,   // no filtering available → show full (never hide)
      fullContent: full,
      fallback:    true,
    };
  });
}

// Process a BATCH of documents in one call. The model returns line numbers;
// we rebuild text from the originals. Coverage check guarantees no doc is lost.
async function processClinicalBatch(client, docs) {
  const { input, lineMap, docLineRange } = buildLineNumberedInput(docs);
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096, // line numbers only → small output
    // #1 Prompt caching: static instructions cached, paid ~10% on repeat calls
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: CLINICAL_TABLE_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `---\n\n${input}` },
      ],
    }],
  });

  const u = response.usage ?? {};
  console.log(`    cache: write=${u.cache_creation_input_tokens ?? 0} read=${u.cache_read_input_tokens ?? 0} in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0}`);

  const events = parseClinicalLineResponse(response.content[0]?.text ?? '');
  return reconstructClinicalRows(events, docs, lineMap, docLineRange);
}

async function handleClinical(body) {
  const { documents } = body;
  if (!Array.isArray(documents) || documents.length === 0) {
    throw Object.assign(new Error('לא נשלחו מסמכים'), { status: 400 });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 8 });
  const batches = batchByChars(documents);

  console.log(`\n📋 טבלה קלינית: ${documents.length} מסמכים → ${batches.length} אצוות (מקס ${MAX_CONCURRENT} מקביל)`);

  const settled = await semaphore(
    batches.map((docs) => async () => {
      try {
        return await processClinicalBatch(client, docs);
      } catch (e) {
        console.error(`  ⚠ אצווה נכשלה: ${e.message} — שורות גיבוי`);
        return fallbackRows(docs);
      }
    }),
    MAX_CONCURRENT
  );

  const rows = [];
  settled.forEach((r) => { if (!r.error) rows.push(...(r.value ?? [])); });

  if (rows.length === 0) {
    throw Object.assign(new Error('לא חולצו שורות קליניות'), { status: 422 });
  }

  rows.sort((a, b) => toTimestamp(a.date) - toTimestamp(b.date));
  const fallbackCount = rows.filter((r) => r.fallback).length;
  console.log(`✓ טבלה קלינית: ${rows.length} שורות (${fallbackCount} גיבוי) מתוך ${documents.length} מסמכים\n`);
  return { rows, fallbackCount };
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const routes = {
    '/api/process':  handleProcess,
    '/api/clinical': handleClinical,
  };

  if (req.method === 'POST' && routes[req.url]) {
    const handler = routes[req.url];
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'הקבצים גדולים מדי (מקסימום 50MB)' }));
        req.resume();
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const result = await handler(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const status = err.status ?? 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, details: err.details }));
      }
    });

    req.on('error', () => { if (!res.writableEnded) { res.writeHead(400); res.end(); } });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays up):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server stays up):', err?.message ?? err);
});

const PORT = 3001;
server.listen(PORT, () => console.log(`✓ API server: http://localhost:${PORT}\n`));
