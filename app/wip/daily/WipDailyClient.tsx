'use client';

import { useState } from 'react';
import { TrendChart } from '@/components/TrendChart';
import { BranchBreakdownBars } from '@/components/BranchBreakdownBars';
import { WipMetricsLegend } from '@/components/WipMetricsLegend';
import { BRANCHES, WIP_METRICS, WipDailyEntry, WipMetricKey, Branch } from '@/lib/types';
import { formatNumber } from '@/lib/format';
import { downloadMetricCsv } from '@/lib/export-csv';

function emptyMetricTotals(): Record<WipMetricKey, number> {
  return Object.fromEntries(WIP_METRICS.map((m) => [m.key, 0])) as Record<WipMetricKey, number>;
}

/** Sum all branches for every metric */
function sumAllBranches(entry: WipDailyEntry): Record<WipMetricKey, number> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [
      m.key,
      BRANCHES.reduce((sum, b) => sum + ((entry.values[m.key]?.[b]) ?? 0), 0),
    ])
  ) as Record<WipMetricKey, number>;
}

/** Values for a single branch across all metrics */
function singleBranchTotals(entry: WipDailyEntry, branch: Branch): Record<WipMetricKey, number> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [m.key, (entry.values[m.key]?.[branch]) ?? 0])
  ) as Record<WipMetricKey, number>;
}

const BRANCH_COLORS: Record<string, string> = {
  'All Branches': '#78C41A',
  Dubai:    '#78C41A',
  Ajman:    '#3B82F6',
  Sharjah:  '#F59E0B',
  'Abu Dhabi': '#8B5CF6',
  'Al Ain': '#EF4444',
  Qatar:    '#06B6D4',
};

export function WipDailyClient({ wipHistory }: { wipHistory: WipDailyEntry[] }) {
  const [selectedMetric, setSelectedMetric] = useState<WipMetricKey>('openRepairOrders');
  const [branchFilter, setBranchFilter] = useState<'all' | Branch>('all');
  const [exportingKey, setExportingKey] = useState<string | null>(null);

  const history = [...wipHistory].sort((a, b) => a.date.localeCompare(b.date));
  const latest = history[history.length - 1];
  const prior  = history[history.length - 2];

  const currentTotals = latest
    ? (branchFilter === 'all' ? sumAllBranches(latest) : singleBranchTotals(latest, branchFilter))
    : emptyMetricTotals();

  const previousTotals = prior
    ? (branchFilter === 'all' ? sumAllBranches(prior) : singleBranchTotals(prior, branchFilter))
    : emptyMetricTotals();

  const selectedMeta = WIP_METRICS.find((m) => m.key === selectedMetric)!;

  return (
    <>
      {/* Branch selector */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-sm font-semibold text-ink-muted mr-1">Branch:</span>
        {(['all', ...BRANCHES] as const).map((b) => {
          const active = branchFilter === b;
          const color = BRANCH_COLORS[b === 'all' ? 'All Branches' : b] ?? '#78C41A';
          return (
            <button
              key={b}
              onClick={() => setBranchFilter(b)}
              className={`text-sm font-semibold px-4 py-1.5 rounded-full border transition-all ${
                active
                  ? 'text-white border-transparent shadow-sm'
                  : 'bg-white text-ink-muted border-border hover:border-gray-400'
              }`}
              style={active ? { backgroundColor: color, borderColor: color } : {}}
            >
              {b === 'all' ? 'All Branches' : b}
            </button>
          );
        })}
      </div>

      {/* All-metrics KPI grid */}
      <div className="grid grid-cols-7 gap-2 mb-4">
        {WIP_METRICS.map((m) => {
          const cur   = currentTotals[m.key as WipMetricKey] ?? 0;
          const prev  = previousTotals[m.key as WipMetricKey] ?? 0;
          const delta = cur - prev;
          const isWorse  = m.lowerIsBetter ? delta > 0 : delta < 0;
          const isBetter = m.lowerIsBetter ? delta < 0 : delta > 0;
          const borderColor = isWorse ? 'border-t-danger' : 'border-t-evs-green';
          const isSelected = selectedMetric === m.key;

          return (
            <div
              key={m.key}
              onClick={() => setSelectedMetric(m.key as WipMetricKey)}
              className={`bg-white rounded-lg p-3 shadow-sm border-t-2 ${borderColor} cursor-pointer transition-all hover:shadow-md ${
                isSelected ? 'ring-2 ring-evs-green shadow-md' : ''
              }`}
            >
              <div className="text-2xl font-black text-ink tabular-nums leading-none">
                {formatNumber(cur)}
              </div>
              <div className={`text-xs mt-1.5 leading-tight ${
                isSelected ? 'text-evs-green-dark font-semibold' : 'text-ink-muted'
              }`}>
                {m.label}
              </div>
              {prev !== 0 && (
                <div className={`text-xs font-semibold mt-1.5 ${
                  isBetter ? 'text-evs-green-dark' : isWorse ? 'text-danger' : 'text-ink-muted'
                }`}>
                  {delta > 0 ? '↑' : delta < 0 ? '↓' : '—'}{' '}
                  {delta !== 0 ? formatNumber(Math.abs(delta)) : 'No change'}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Trend chart — full width */}
      <div className="bg-white rounded-lg p-5 shadow-sm mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">Daily Trend</span>
          <span className="text-xs text-ink-muted">Click a metric card above to change</span>
        </div>
        <div className="text-base font-bold text-ink mb-3">{selectedMeta.label}</div>
        <TrendChart
          entries={wipHistory}
          metric={selectedMetric}
          branch={branchFilter}
          onBranchChange={setBranchFilter}
        />
      </div>

      {/* Branch breakdown — all metrics for selected branch, or all branches for selected metric */}
      {branchFilter === 'all' ? (
        <BranchBreakdownBars
          meta={selectedMeta}
          current={(latest?.values[selectedMetric] ?? {}) as Record<string, number>}
          previous={prior?.values[selectedMetric] as Record<string, number> | undefined}
          subValues={latest?.subValues?.[selectedMetric]}
          onExport={(branch) => downloadMetricCsv(selectedMetric, branch as Branch | undefined, setExportingKey)}
          exportingKey={exportingKey}
        />
      ) : (
        <SingleBranchPanel
          branch={branchFilter}
          currentTotals={currentTotals}
          previousTotals={previousTotals}
          selectedMetric={selectedMetric}
          onSelectMetric={setSelectedMetric}
          onExport={() => downloadMetricCsv(selectedMetric, branchFilter, setExportingKey)}
          exporting={exportingKey === branchFilter}
        />
      )}

      <WipMetricsLegend />
    </>
  );
}

/* ─── Single-branch view: show all 7 metrics for the selected branch ──── */
function SingleBranchPanel({
  branch,
  currentTotals,
  previousTotals,
  selectedMetric,
  onSelectMetric,
  onExport,
  exporting,
}: {
  branch: Branch;
  currentTotals: Record<WipMetricKey, number>;
  previousTotals: Record<WipMetricKey, number>;
  selectedMetric: WipMetricKey;
  onSelectMetric: (k: WipMetricKey) => void;
  onExport: () => void;
  exporting: boolean;
}) {
  const color = BRANCH_COLORS[branch] ?? '#78C41A';
  const selectedMeta = WIP_METRICS.find((m) => m.key === selectedMetric)!;

  return (
    <div className="bg-white rounded-lg p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4 gap-3">
        <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">All Metrics — {branch}</span>
        <div className="flex items-center gap-3">
          <button
            onClick={onExport}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-evs-green-dark border border-border hover:border-evs-green rounded-md px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50"
            title={`Export ${branch} — ${selectedMeta.label} records (live from Odoo)`}
          >
            {exporting ? (
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M10 3v9m0 0l-3.5-3.5M10 12l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 14v2a1 1 0 001 1h10a1 1 0 001-1v-2" strokeLinecap="round" />
              </svg>
            )}
            Export {selectedMeta.short}
          </button>
          <span className="text-xs font-semibold px-3 py-1 rounded-full text-white" style={{ backgroundColor: color }}>
            {branch}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {WIP_METRICS.map((m) => {
          const cur   = currentTotals[m.key as WipMetricKey]  ?? 0;
          const prev  = previousTotals[m.key as WipMetricKey] ?? 0;
          const delta = cur - prev;
          const isWorse  = m.lowerIsBetter ? delta > 0 : delta < 0;
          const isBetter = m.lowerIsBetter ? delta < 0 : delta > 0;
          const isSelected = selectedMetric === m.key;
          const borderColor = isWorse ? 'border-t-danger' : 'border-t-evs-green';

          return (
            <div
              key={m.key}
              onClick={() => onSelectMetric(m.key as WipMetricKey)}
              className={`rounded-lg p-3 border-t-2 ${borderColor} cursor-pointer transition-all hover:shadow-md bg-surface ${
                isSelected ? 'ring-2 ring-evs-green shadow-md bg-white' : ''
              }`}
            >
              <div className="text-xl font-black tabular-nums text-ink leading-none">{formatNumber(cur)}</div>
              <div className={`text-xs mt-1.5 leading-tight ${isSelected ? 'text-evs-green-dark font-semibold' : 'text-ink-muted'}`}>
                {m.label}
              </div>
              {prev !== 0 && (
                <div className={`text-xs font-semibold mt-1 ${isBetter ? 'text-evs-green-dark' : isWorse ? 'text-danger' : 'text-ink-muted'}`}>
                  {delta > 0 ? '↑' : delta < 0 ? '↓' : '—'} {delta !== 0 ? formatNumber(Math.abs(delta)) : 'No change'}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
