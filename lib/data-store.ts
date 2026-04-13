import { ReportData } from './types';
import defaultData from '../data/data.json';

const DATA_KEY = 'evs_report_data';

/**
 * Production (Vercel): data lives in Vercel KV (Redis).
 * Local dev: falls back to data/data.json — no KV setup needed.
 *
 * On first production boot, if KV is empty, we auto-seed from the bundled
 * data/data.json so no manual seeding step is required.
 */
const useKV = !!process.env.KV_REST_API_URL;

// ── KV helpers ────────────────────────────────────────────────────────────────
async function kvGet(): Promise<ReportData> {
  const { kv } = await import('@vercel/kv');
  let data = await kv.get<ReportData>(DATA_KEY);

  if (!data) {
    // First deploy — auto-seed from the bundled data.json
    console.log('[data-store] KV empty — seeding from bundled data.json');
    data = defaultData as unknown as ReportData;
    await kv.set(DATA_KEY, data);
  }

  return data;
}

async function kvSet(data: ReportData): Promise<void> {
  const { kv } = await import('@vercel/kv');
  await kv.set(DATA_KEY, data);
}

// ── File-system helpers (local dev only) ──────────────────────────────────────
function fsGet(): ReportData {
  const fs   = require('fs')   as typeof import('fs');
  const path = require('path') as typeof import('path');
  const DATA_PATH = path.join(process.cwd(), 'data', 'data.json');
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')) as ReportData;
  } catch (err) {
    console.error('[data-store] Failed to read data.json:', err);
    throw new Error('Could not read data.json. Make sure the file exists and is valid JSON.');
  }
}

function fsSet(data: ReportData): void {
  const fs   = require('fs')   as typeof import('fs');
  const path = require('path') as typeof import('path');
  const DATA_PATH = path.join(process.cwd(), 'data', 'data.json');
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[data-store] Failed to write data.json:', err);
    throw new Error('Could not save data.json. Check disk permissions.');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function readData(): Promise<ReportData> {
  if (useKV) return kvGet();
  return fsGet();
}

export async function writeData(data: ReportData): Promise<void> {
  if (useKV) return kvSet(data);
  fsSet(data);
}
