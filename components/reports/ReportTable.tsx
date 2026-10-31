'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CellValue, ReportColumn, ReportRow, Tone } from '@/lib/reports/types';
import { Cell, NUMERIC_KINDS, isEmpty } from './cells';

const ROW_LIMIT = 300;

type Sort = { key: string; dir: 'asc' | 'desc' } | null;

function compare(a: CellValue | undefined, b: CellValue | undefined): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

export function ReportTable({
  columns,
  rows,
  totalRows,
  badgeTones,
  dimmed,
  resetKey,
}: {
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Row count before client-side filters, for the footer. */
  totalRows: number;
  badgeTones?: Record<string, Record<string, Tone>>;
  dimmed: boolean;
  /** Changes whenever the filters change; collapses "show all" back to the limit. */
  resetKey: string;
}) {
  const [sort, setSort] = useState<Sort>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => setShowAll(false), [resetKey]);

  // Drop a sort on a column the current report does not have.
  const activeSort = sort && columns.some((c) => c.key === sort.key) ? sort : null;

  const sorted = useMemo(() => {
    if (!activeSort) return rows;
    const { key, dir } = activeSort;
    const sign = dir === 'asc' ? 1 : -1;
    return rows
      .map((row, i) => ({ row, i }))
      .sort((x, y) => {
        const a = x.row[key];
        const b = y.row[key];
        const ae = isEmpty(a);
        const be = isEmpty(b);
        if (ae || be) return ae && be ? x.i - y.i : ae ? 1 : -1; // nulls always last
        return sign * compare(a, b) || x.i - y.i;
      })
      .map((x) => x.row);
  }, [rows, activeSort]);

  function onHeaderClick(col: ReportColumn) {
    if (activeSort?.key === col.key) {
      setSort({ key: col.key, dir: activeSort.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      setSort({ key: col.key, dir: NUMERIC_KINDS.has(col.kind) ? 'desc' : 'asc' });
    }
  }

  const visible = showAll ? sorted : sorted.slice(0, ROW_LIMIT);

  return (
    <div>
      <div className={`bg-white rounded-lg shadow-sm overflow-auto max-h-[70vh] transition-opacity ${dimmed ? 'opacity-60' : ''}`}>
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr>
              {columns.map((col, ci) => {
                const numeric = NUMERIC_KINDS.has(col.kind);
                const isSorted = activeSort?.key === col.key;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    onClick={() => onHeaderClick(col)}
                    aria-sort={isSorted ? (activeSort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`bg-[#f3f8ec] border-b-2 border-evs-green/20 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-muted whitespace-nowrap cursor-pointer select-none hover:text-ink ${
                      numeric ? 'text-right' : 'text-left'
                    } ${ci === 0 ? 'px-4 sticky left-0 z-20' : 'px-3'}`}
                  >
                    {col.label}
                    {isSorted && <span className="ml-1">{activeSort!.dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-ink-muted">
                  Nothing to show for this selection.
                </td>
              </tr>
            ) : (
              visible.map((row, ri) => {
                const odd = ri % 2 === 1;
                return (
                  <tr key={ri} className={odd ? 'bg-surface/60' : 'bg-white'}>
                    {columns.map((col, ci) => {
                      const numeric = NUMERIC_KINDS.has(col.kind);
                      const nowrap = numeric || col.kind === 'date' ? 'whitespace-nowrap' : '';
                      // The sticky first column needs an opaque fill (surface/60 over white).
                      const sticky = ci === 0 ? `px-4 sticky left-0 ${odd ? 'bg-[#fafbfa]' : 'bg-white'}` : 'px-3';
                      return (
                        <td
                          key={col.key}
                          className={`py-2.5 border-b border-border ${sticky} ${nowrap} ${
                            numeric ? 'text-right tabular-nums' : 'text-left'
                          }`}
                        >
                          <Cell col={col} value={row[col.key]} tones={badgeTones?.[col.key]} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
            {!showAll && sorted.length > ROW_LIMIT && (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="w-full py-3 text-sm font-semibold text-evs-green-dark hover:bg-evs-green/5"
                  >
                    Show all {sorted.length.toLocaleString('en-US')} rows
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Showing {visible.length.toLocaleString('en-US')} of {totalRows.toLocaleString('en-US')} rows
      </p>
    </div>
  );
}
