/**
 * /api/export-odoo
 *
 * Two modes:
 *   POST { metric, branch?, start?, end? } — WIP dashboard CSV: the records
 *     behind a metric, same filter as the count (site-auth).
 *   POST { type: 'wip' | 'received', date? } — Admin Excel export: repair orders
 *     for a Gulf day, one sheet per branch (admin-auth). Returns an .xlsx file.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx-js-style';
import { fetchMetricRecords, fetchRepairOrdersForExport, RepairOrderExportRow } from '@/lib/odoo';
import { isAuthenticated, isAdminAuthenticated } from '@/lib/auth';
import { WIP_METRICS, WipMetricKey, BRANCHES, Branch } from '@/lib/types';

export const maxDuration = 60;

const VALID_METRICS = new Set(WIP_METRICS.map((m) => m.key));

// ── Excel (repair-order) export helpers ────────────────────────────
const XLSX_COLS = ['RO Number', 'Tags', 'Created By', 'Created On', 'Customer Name', 'Customer Mobile', 'Vehicle', 'Stage', 'Priority Matrix Status'];

function rowToArr(r: RepairOrderExportRow): string[] {
  return [r.roNumber, r.tags, r.createdBy, r.createdOn, r.customerName, r.customerMobile, r.vehicle, r.stage, r.priorityMatrixStatus];
}

function autoWidth(aoa: (string | number)[][]): { wch: number }[] {
  const widths: number[] = [];
  for (const row of aoa) {
    row.forEach((c, i) => {
      const len = c == null ? 0 : String(c).length;
      widths[i] = Math.max(widths[i] || 10, Math.min(len + 2, 60));
    });
  }
  return widths.map((w) => ({ wch: w }));
}

const HEADER_STYLE = { font: { bold: true }, fill: { fgColor: { rgb: 'EEEEEE' } } };

/** Bold + shade the first (header) row of a worksheet. */
function boldHeaderRow(ws: XLSX.WorkSheet) {
  const ref = ws['!ref'];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = HEADER_STYLE;
  }
}

function branchSheet(rows: RepairOrderExportRow[], type: 'wip' | 'received') {
  const aoa: (string | number)[][] = [XLSX_COLS, ...rows.map(rowToArr), []];
  if (type === 'wip') {
    aoa.push([`Total: ${rows.length} repair orders`]);
  } else {
    const closed = rows.filter((r) => r.closed).length;
    aoa.push([`Total Received: ${rows.length}`], [`Closed (X status): ${closed}`], [`Unclosed: ${rows.length - closed}`]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = autoWidth(aoa);
  boldHeaderRow(ws);
  return ws;
}

function buildWorkbook(rows: RepairOrderExportRow[], type: 'wip' | 'received'): ArrayBuffer {
  const wb = XLSX.utils.book_new();

  if (type === 'received') {
    const sum: (string | number)[][] = [['Branch', 'Total Received', 'Closed', 'Unclosed']];
    let tR = 0, tC = 0, tU = 0;
    for (const b of BRANCHES) {
      const br = rows.filter((r) => r.branch === b);
      const c = br.filter((r) => r.closed).length;
      sum.push([b, br.length, c, br.length - c]);
      tR += br.length; tC += c; tU += br.length - c;
    }
    sum.push(['Total', tR, tC, tU]);
    const ws = XLSX.utils.aoa_to_sheet(sum);
    ws['!cols'] = autoWidth(sum);
    boldHeaderRow(ws);
    // Bold the final Total row too.
    const lastRow = sum.length - 1;
    for (let c = 0; c < 4; c++) {
      const addr = XLSX.utils.encode_cell({ r: lastRow, c });
      if (ws[addr]) ws[addr].s = { font: { bold: true } };
    }
    XLSX.utils.book_append_sheet(wb, ws, 'Summary');
  }

  for (const b of BRANCHES) {
    XLSX.utils.book_append_sheet(wb, branchSheet(rows.filter((r) => r.branch === b), type), b);
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

/** Yesterday's date in Gulf time (UTC+4) as YYYY-MM-DD. */
function yesterdayGulf(): string {
  const gulf = new Date(Date.now() + 4 * 3600 * 1000);
  gulf.setUTCDate(gulf.getUTCDate() - 1);
  return gulf.toISOString().slice(0, 10);
}

/** Flatten an Odoo cell to a CSV-safe string (many2one [id, "Name"] → "Name"). */
function cell(v: unknown): string {
  let s: string;
  if (v == null || v === false) s = '';
  else if (Array.isArray(v)) s = String(v[1] ?? v[0] ?? ''); // [id, name] tuple
  else s = String(v);
  if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const HEADER_LABELS: Record<string, string> = {
  name: 'Reference',
  display_name: 'Name',
  company_id: 'Company / Branch',
  partner_id: 'Customer',
  create_date: 'Created On',
  write_date: 'Updated On',
  date_order: 'Order Date',
  amount_total: 'Amount',
  state: 'Status',
  create_uid: 'Created By',
  user_id: 'Responsible',
};

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return 'No records found\n';
  const headers = Object.keys(rows[0]).filter((h) => h !== 'id');
  const lines = [headers.map((h) => cell(HEADER_LABELS[h] ?? h)).join(',')];
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

  let body: { metric?: string; branch?: string; start?: string; end?: string; type?: string; date?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ── Admin Excel export (repair orders, one sheet per branch) ──────
  if (body.type === 'wip' || body.type === 'received') {
    if (!isAdminAuthenticated()) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const dateStr = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : yesterdayGulf();
    try {
      const rows = await fetchRepairOrdersForExport(dateStr, { wipOnly: body.type === 'wip' });
      const buffer = buildWorkbook(rows, body.type);
      const filename = body.type === 'wip' ? `WIP_Export_${dateStr}.xlsx` : `Received_JCs_${dateStr}.xlsx`;
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    } catch (error) {
      console.error('❌ [export-odoo xlsx] failed:', error);
      return NextResponse.json(
        { error: 'Export failed', detail: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  const metric = body.metric as WipMetricKey;
  if (!metric || !VALID_METRICS.has(metric)) {
    return NextResponse.json({ error: 'Invalid metric' }, { status: 400 });
  }
  const branch = body.branch && (BRANCHES as readonly string[]).includes(body.branch)
    ? (body.branch as Branch)
    : undefined;
  const range = body.start && body.end ? { start: body.start, end: body.end } : undefined;

  try {
    const records = await fetchMetricRecords(metric, branch, range);
    const csv = toCsv(records);
    const date = range ? range.end : new Date().toISOString().split('T')[0];
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
