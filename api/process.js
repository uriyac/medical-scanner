import Anthropic from '@anthropic-ai/sdk';
import {
  SYSTEM_PROMPT, EXTRACTION_PROMPT, METADATA_PROMPT,
  parseClaudeResponse, parseMetadataResponse,
  reconstructDocuments, deduplicateAndSort, semaphore,
} from './_shared.js';

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};

// Vercel kills functions at 10s by default (Hobby) — raise to the 60s max so a
// slow OCR call has room to finish. Each unit is page-capped to stay under this.
export const maxDuration = 60;

const MAX_CONCURRENT = 5;

// ── Single-file processors ────────────────────────────────────────────────────

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

  const metadata = parseMetadataResponse(response.content[0]?.text ?? '');
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
  return parseClaudeResponse(response.content[0]?.text ?? '');
}

async function processScannedBatch(client, batch) {
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

// ── Route each file to the right processor(s) ────────────────────────────────

function buildTasksForFile(client, file) {
  if (file.type === 'digital')       return [() => processDigital(client, file)];
  if (file.type === 'scanned')       return [() => processScanned(client, file)];
  if (file.type === 'scanned_batch') return [() => processScannedBatch(client, file)];
  if (file.type === 'scanned_large') return file.batches.map((b) => () => processScannedBatch(client, b));
  return [];
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'מפתח API חסר בהגדרות השרת' });

  const { files } = req.body ?? {};
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'לא נשלחו קבצים' });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 8 });

  const taskMeta = [];
  files.forEach((file, fi) => {
    buildTasksForFile(client, file).forEach((fn) => taskMeta.push({ fi, fn }));
  });

  const settled = await semaphore(taskMeta.map(({ fn }) => fn), MAX_CONCURRENT);

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
        console.error(`Error: ${file.name}:`, result.error.message);
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
      allDocuments.push(...fileDocs);
    }
  });

  if (allDocuments.length === 0) {
    return res.status(422).json({ error: 'לא נמצאו מסמכים בקבצים שהועלו', details: errors });
  }

  const documents = deduplicateAndSort(allDocuments);
  return res.status(200).json({ documents, warnings: errors.length ? errors : undefined });
}
