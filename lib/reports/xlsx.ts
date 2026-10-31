/**
 * Any EVHUB report → a two-sheet workbook.
 *
 * "Report" is the table as shown; "About" carries what the table alone cannot:
 * when it was computed, which window and scope it covers, the summary tiles,
 * and the caveats. A spreadsheet travels without the page around it, so the
 * context has to travel inside it.
 */

import * as XLSX from 'xlsx-js-style';
import { autoWidth, boldHeaderRow } from '../xlsx';
import { parseScope, scopeLabel } from '../types';
import type { CellValue, ReportResult } from './types';

/** 'All branches', the branch, or the station with its branch: 'Emarat - Altwar (Dubai)'. */
function scopeText(scope: string): string {
  if (scope === 'all') return 'All branches';
  const { branch, sub } = parseScope(scope);
  return sub && branch ? `${scopeLabel(scope)} (${branch})` : scopeLabel(scope);
}

/** ISO time → 'YYYY-MM-DD HH:MM' in Gulf time (UTC+4, no DST). */
function gulfStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t + 4 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** Numbers stay numbers so Excel can sum and sort them; null stays a truly empty cell. */
function cell(v: CellValue | undefined): string | number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return String(v);
}

/** autoWidth measures text; an empty cell measures as nothing. */
const forWidth = (aoa: (string | number | null)[][]): (string | number)[][] =>
  aoa.map((r) => r.map((c) => (c == null ? '' : c)));

function sheet(aoa: (string | number | null)[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = autoWidth(forWidth(aoa));
  boldHeaderRow(ws);
  return ws;
}

export function reportWorkbook(result: ReportResult): ArrayBuffer {
  const wb = XLSX.utils.book_new();

  const table: (string | number | null)[][] = [
    result.columns.map((c) => c.label),
    ...result.rows.map((r) => result.columns.map((c) => cell(r[c.key]))),
  ];
  XLSX.utils.book_append_sheet(wb, sheet(table), 'Report');

  const about: (string | number | null)[][] = [
    ['Title', result.title],
    ['Description', result.description],
    ['Generated', gulfStamp(result.generatedAt)],
    ['Window', result.windowDays != null ? `${result.windowDays} days` : result.slug === 'cost' ? 'Last 12 months' : 'Current backlog'],
    ['Scope', scopeText(result.scope)],
    [],
    ...result.summary.map((s) => (s.hint ? [s.label, s.value, s.hint] : [s.label, s.value])),
    [],
    ...result.notes.map((n) => [n]),
  ];
  XLSX.utils.book_append_sheet(wb, sheet(about), 'About');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
