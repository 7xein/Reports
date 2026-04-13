'use client';

import { useState, useMemo } from 'react';
import { SalesBars } from '@/components/SalesBars';
import { SalesSummaryTable } from '@/components/SalesSummaryTable';
import { SalesTrendChart } from '@/components/SalesTrendChart';
import { RegionalSalesEntry, RegionalBranchConfig } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { getDailyTarget, sumSalesFor, getWeekStart } from '@/lib/sales-utils';

interface Props {
  salesLog: RegionalSalesEntry[];
  branchConfig: Record<string, RegionalBranchConfig>;
  weekStartRef: string;
  branches: readonly string[];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export function SalesWeeklyClient({ salesLog, branchConfig, weekStartRef, branches }: Props) {
  const allWeekStarts = useMemo(() => {
    const weeks = new Set(salesLog.map((e) => getWeekStart(e.date, weekStartRef)));
    return [...weeks].sort();
  }, [salesLog, weekStartRef]);

  const [selectedWeekStart, setSelectedWeekStart] = useState(
    allWeekStarts[allWeekStarts.length - 1] ?? ''
  );

  const weekEnd = selectedWeekStart ? addDays(selectedWeekStart, 6) : '';
  const selectedIdx = allWeekStarts.indexOf(selectedWeekStart);

  const rows = branches.map((b) => {
    const cfg    = branchConfig[b] ?? { monthlyTarget: 0, daysInMonth: 26 };
    const actual = sumSalesFor(salesLog, b, (e) =>
      selectedWeekStart ? getWeekStart(e.date, weekStartRef) === selectedWeekStart : false
    );
    const target = getDailyTarget(cfg) * 7;
    return { branch: b, actual, target };
  });

  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const pct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;

  if (allWeekStarts.length === 0) {
    return (
      <div className="bg-white rounded-lg p-8 text-center text-sm text-ink-muted shadow-sm">
        No sales data yet — add sales entries in Admin to see weekly breakdowns.
      </div>
    );
  }

  return (
    <>
      {/* Week selector bar */}
      <div className="bg-white rounded-lg p-4 mb-4 shadow-sm flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span className="text-sm font-bold text-ink shrink-0">Showing week:</span>
          <span className="text-sm text-ink-muted font-medium">
            {selectedWeekStart ? `${fmtDate(selectedWeekStart)} – ${fmtDate(weekEnd)}` : '—'}
          </span>
          {pct !== null && (
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full shrink-0 ${
              pct >= 100 ? 'bg-evs-green/10 text-evs-green-dark' : 'bg-amber-50 text-amber-700'
            }`}>
              {formatCurrency(totalActual)} · {pct.toFixed(1)}% of target
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => selectedIdx > 0 && setSelectedWeekStart(allWeekStarts[selectedIdx - 1])}
            disabled={selectedIdx <= 0}
            className="text-xs px-3 py-1.5 rounded border border-border text-ink-muted hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ← Prev
          </button>
          <select
            value={selectedWeekStart}
            onChange={(e) => setSelectedWeekStart(e.target.value)}
            className="text-sm border border-border rounded px-3 py-1.5 text-ink bg-white"
          >
            {allWeekStarts.map((ws) => {
              const we = addDays(ws, 6);
              return (
                <option key={ws} value={ws}>
                  {fmtDate(ws)} – {fmtDate(we)}
                </option>
              );
            })}
          </select>
          <button
            onClick={() => selectedIdx < allWeekStarts.length - 1 && setSelectedWeekStart(allWeekStarts[selectedIdx + 1])}
            disabled={selectedIdx >= allWeekStarts.length - 1}
            className="text-xs px-3 py-1.5 rounded border border-border text-ink-muted hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Next →
          </button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4 mb-4">
        <div className="bg-white rounded-lg p-5 shadow-sm">
          <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-4">Actual vs Target</div>
          <SalesBars rows={rows} />
        </div>
        <div>
          <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-3">Branch Summary</div>
          <SalesSummaryTable rows={rows} />
        </div>
      </div>

      <div className="bg-white rounded-lg p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-bold uppercase tracking-wide text-ink-muted">Sales Trend</div>
            <div className="text-xs text-ink-muted mt-0.5">Weekly actual sales per branch over time</div>
          </div>
          <span className="text-xs bg-evs-green/10 text-evs-green-dark font-semibold px-3 py-1 rounded-full">All Weeks</span>
        </div>
        <SalesTrendChart salesLog={salesLog} branches={branches} groupBy="week" weekStartRef={weekStartRef} />
      </div>
    </>
  );
}
