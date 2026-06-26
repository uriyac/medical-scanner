import Anthropic from '@anthropic-ai/sdk';
import {
  SYSTEM_PROMPT, CLINICAL_TABLE_PROMPT,
  semaphore, toTimestamp,
  buildLineNumberedInput, parseClinicalLineResponse, reconstructClinicalRows, batchByChars,
} from './_shared.js';

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};

const MAX_CONCURRENT = 5;

function fallbackRows(docs) {
  return docs.map((doc) => {
    const full = (doc.text || '').trim();
    return {
      date:        doc.date || 'לא ידוע',
      provider:    doc.institution || '',
      content:     full,
      fullContent: full,
      fallback:    true,
    };
  });
}

async function processClinicalBatch(client, docs) {
  const { input, lineMap, docLineRange } = buildLineNumberedInput(docs);
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: CLINICAL_TABLE_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `---\n\n${input}` },
      ],
    }],
  });
  const events = parseClinicalLineResponse(response.content[0]?.text ?? '');
  return reconstructClinicalRows(events, docs, lineMap, docLineRange);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'מפתח API חסר בהגדרות השרת' });

  const { documents } = req.body ?? {};
  if (!Array.isArray(documents) || documents.length === 0) {
    return res.status(400).json({ error: 'לא נשלחו מסמכים' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 8 });
  const batches = batchByChars(documents);

  const settled = await semaphore(
    batches.map((docs) => async () => {
      try {
        return await processClinicalBatch(client, docs);
      } catch {
        return fallbackRows(docs);
      }
    }),
    MAX_CONCURRENT
  );

  const rows = [];
  settled.forEach((r) => { if (!r.error) rows.push(...(r.value ?? [])); });

  if (rows.length === 0) {
    return res.status(422).json({ error: 'לא חולצו שורות קליניות' });
  }

  rows.sort((a, b) => toTimestamp(a.date) - toTimestamp(b.date));
  const fallbackCount = rows.filter((r) => r.fallback).length;
  return res.status(200).json({ rows, fallbackCount });
}
