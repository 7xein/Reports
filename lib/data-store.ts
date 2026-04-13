import { ReportData } from './types';

const DATA_KEY = 'evs_report_data';

/**
 * In production (Vercel) data lives in Vercel KV.
 * In local development it falls back to data/data.json so no KV setup is needed.
 */
const useKV = !!process.env.KV_REST_API_URL;

// ── KV helpers (loaded lazily so local dev doesn't require the env vars) ─────
async function kvGet(): Promise<ReportData> {
  const { kv } = await import('@vercel/kv');
  const data = await kv.get<ReportData>(DATA_KEY);
  if (!data) throw new Error('KV store is empty — run /api/seed to initialise.');
  return data;
}

async function kvSet(data: ReportData): Promise<void> {
  const { kv } = await import('@vercel/kv');
  await kv.set(DATA_KEY, data);
}

// ── File-system helpers (local dev only) ─────────────────────────────────────
function fsGet(): ReportData {
  const fs   = require('fs')   as typeof import('fs');
  const path = require('path') as typeof import('path');
  const DATA_PATH = path.join(process.cwd(), 'data', 'data.json');
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')) as ReportData;
  } catch (err) {
    console.error('[data-store] Failed to read data.json:', err);
    throw new Error('Could not read data.json. Make sure the file exists and contains valid JSON.');
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

/** Reads report data. Async in production (KV), sync-wrapped for local dev. */
export async function readData(): Promise<ReportData> {
  if (useKV) return kvGet();
  return fsGet();
}

/** Writes report data. */
export async function writeData(data: ReportData): Promise<void> {
  if (useKV) return kvSet(data);
  fsSet(data);
}
