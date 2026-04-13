'use client';

import { useState } from 'react';
import { KpiStrip } from '@/components/KpiStrip';
import { MetricsTable } from '@/components/MetricsTable';
import { BRANCHES, WIP_METRICS, WipWeeklyEntry, WipMetricKey, Branch } from '@/lib/types';

function emptyBranchValues(): Record<WipMetricKey, Record<Branch, number>> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [m.key, Object.fromEntries(BRANCHES.map((b) => [b, 0]))])
  ) as Record<WipMetricKey, Record<Branch, number>>;
}

function sumTotals(values: Record<WipMetricKey, Record<Branch, number>>): Record<WipMetricKey, number> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [
      m.key,
      BRANCHES.reduce((sum, b) => sum + (values[m.key]?.[b] ?? 0), 0),
    ])
  ) as Record<WipMetricKey, number>;
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function weekStartOf(weekEnding: string) {
  const d = new Date(weekEnding + 'T00:00:00');
  d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

export function WipWeeklyClient({ history }: { history: WipWeeklyEntry[] }) {
  const [selectedIdx, setSelectedIdx] = useState(history.length > 0 ? history.length - 1 : 0);

  if (history.length === 0) {
    return (
      <div className="bg-white rounded-lg p-8 text-center text-sm text-ink-muted shadow-sm">
        No weekly snapshots yet — enter this week&apos;s WIP numbers in Admin under <strong>WIP Weekly Snapshot</strong>.
      </div>
    );
  }

  const selected = history[selectedIdx];
  const prior    = selectedIdx > 0 ? history[selectedIdx - 1] : undefined;

  const currentValues  = selected.values as unknown as Record<WipMetricKey, Record<Branch, number>>;
  const previousValues = prior ? prior.values as unknown as Record<WipMetricKey, Record<Branch, number>> : emptyBranchValues();

  const currentTotals  = sumTotals(currentValues);
  const previousTotals = sumTotals(previousValues);

  const ws = weekStartOf(selected.weekEnding);

  return (
    <>
      {/* Week selector bar */}
      <div className="bg-white rounded-lg p-4 mb-4 shadow-sm flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span className="text-sm font-bold text-ink shrink-0">Showing week:</span>
          <span className="text-sm text-ink-muted font-medium">
            {fmtDate(ws)} – {fmtDate(selected.weekEnding)}
          </span>
          <span className="text-xs bg-evs-green/10 text-evs-green-dark font-semibold px-2.5 py-1 rounded-full shrink-0">
            {history.length} week{history.length !== 1 ? 's' : ''} on record
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setSelectedIdx(Math.max(0, selectedIdx - 1))}
            disabled={selectedIdx === 0}
            className="text-xs px-3 py-1.5 rounded border border-border text-ink-muted hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ← Prev
          </button>
          <select
            value={selectedIdx}
            onChange={(e) => setSelectedIdx(Number(e.target.value))}
            className="text-sm border border-border rounded px-3 py-1.5 text-ink bg-white"
          >
            {history.map((h, i) => {
              const s = weekStartOf(h.weekEnding);
              return (
                <option key={h.weekEnding} value={i}>
                  {fmtDate(s)} – {fmtDate(h.weekEnding)}
                </option>
              );
            })}
          </select>
          <button
            onClick={() => setSelectedIdx(Math.min(history.length - 1, selectedIdx + 1))}
            disabled={selectedIdx === history.length - 1}
            className="text-xs px-3 py-1.5 rounded border border-border text-ink-muted hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Next →
          </button>
        </div>
      </div>

      <KpiStrip current={currentTotals} previous={previousTotals} />

      <div className="mt-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">
            All WIP Metrics by Branch
          </span>
          {prior && (
            <span className="text-xs text-ink-muted">
              vs {fmtDate(weekStartOf(prior.weekEnding))} – {fmtDate(prior.weekEnding)}
            </span>
          )}
        </div>
        <MetricsTable branches={BRANCHES} current={currentValues} previous={previousValues} />
      </div>
    </>
  );
}
