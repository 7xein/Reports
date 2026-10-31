/**
 * Shared workbook styling, so every export in the app looks like the same tool
 * made it — the Admin repair-order export and the EVHUB report downloads alike.
 */

import * as XLSX from 'xlsx-js-style';

export function autoWidth(aoa: (string | number)[][]): { wch: number }[] {
  const widths: number[] = [];
  for (const row of aoa) {
    row.forEach((c, i) => {
      const len = c == null ? 0 : String(c).length;
      widths[i] = Math.max(widths[i] || 10, Math.min(len + 2, 60));
    });
  }
  return widths.map((w) => ({ wch: w }));
}

export const HEADER_STYLE = { font: { bold: true }, fill: { fgColor: { rgb: 'EEEEEE' } } };

/** Bold + shade the first (header) row of a worksheet. */
export function boldHeaderRow(ws: XLSX.WorkSheet) {
  const ref = ws['!ref'];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = HEADER_STYLE;
  }
}
