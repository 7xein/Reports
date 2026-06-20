/**
 * /api/export-odoo
 *
 * POST { metric, branch? } — pulls the ACTUAL records behind a WIP metric
 * (optionally for one branch) live from Odoo, using the same filter as the
 * dashboard count, and returns them as a downloadable CSV.
 *
 * Auth: same site cookie as the rest of the app (isAuthenticated).
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchMetricRecords } from '@/lib/odoo';
import { isAuthenticated } from '@/lib/auth';
import { WIP_METRICS, WipMetricKey, BRANCHES, Branch } from '@/lib/types';

export const maxDuration = 60;

const VALID_METRICS = new Set(WIP_METRICS.map((m) => m.key));

/** Flatten an Odoo cell to a CSV-safe string (many2one [id, "Name"] → "Name"). */
function cell(v: unknown): string {
  let s: string;
  if (v == null || v === false) s = '';
  else if (Array.isArray(v)) s = String(v[1] ?? v[0] ?? ''); // [id, name] tuple
  else s = String(v);
  if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return 'No records found\n';
  const headers = Object.keys(rows[0]).filter((h) => h !== 'id');
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => cell(r[h])).join(','));
  return lines.join('\n');
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Export failed', detail: `Missing environment variables: ${missing.join(', ')}` },
      { status: 500 }
    );
  }

  let body: { metric?: string; branch?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const metric = body.metric as WipMetricKey;
  if (!metric || !VALID_METRICS.has(metric)) {
    return NextResponse.json({ error: 'Invalid metric' }, { status: 400 });
  }
  const branch = body.branch && (BRANCHES as readonly string[]).includes(body.branch)
    ? (body.branch as Branch)
    : undefined;

  try {
    const records = await fetchMetricRecords(metric, branch);
    const csv = toCsv(records);
    const date = new Date().toISOString().split('T')[0];
    const slug = `${metric}-${branch ? branch.replace(/\s+/g, '') : 'all'}-${date}`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug}.csv"`,
      },
    });
  } catch (error) {
    console.error('❌ [export-odoo] failed:', error);
    return NextResponse.json(
      { error: 'Export failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
