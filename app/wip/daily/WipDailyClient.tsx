'use client';

import { useState } from 'react';
import { TrendChart } from '@/components/TrendChart';
import {
  BRANCHES, WIP_METRICS, WipDailyEntry, WipMetricKey, Branch,
  getSubBranches, subKey,
} from '@/lib/types';
import { formatNumber } from '@/lib/format';

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
        <AllBranchesPanel
          latest={latest}
          prior={prior}
          selectedMetric={selectedMetric}
        />
      ) : (
        <SingleBranchPanel
          branch={branchFilter}
          currentTotals={currentTotals}
          previousTotals={previousTotals}
          selectedMetric={selectedMetric}
          onSelectMetric={setSelectedMetric}
        />
      )}
    </>
  );
}

/* ─── All-branches view: expandable bar breakdown for the selected metric ─ */
function AllBranchesPanel({
  latest,
  prior,
  selectedMetric,
}: {
  latest: WipDailyEntry | undefined;
  prior: WipDailyEntry | undefined;
  selectedMetric: WipMetricKey;
}) {
  const meta = WIP_METRICS.find((m) => m.key === selectedMetric)!;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const current  = latest ? (latest.values[selectedMetric] as unknown as Record<Branch, number>) : {} as Record<Branch, number>;
  const previous = prior  ? (prior.values[selectedMetric]  as unknown as Record<Branch, number>) : {} as Record<Branch, number>;

  // Only show expand affordance when this snapshot actually carries sub-branch detail
  const hasSubData = !!latest?.subValues?.[selectedMetric];
  const subVal = (branch: string, sub: string) =>
    latest?.subValues?.[selectedMetric]?.[subKey(branch, sub)] ?? 0;

  const ordered = [...BRANCHES].sort((a, b) => (current[b] ?? 0) - (current[a] ?? 0));
  const maxVal = Math.max(...BRANCHES.map((b) => current[b] ?? 0), 1);

  const toggle = (b: string) => setExpanded((p) => ({ ...p, [b]: !p[b] }));

  return (
    <div className="bg-white rounded-lg shadow-sm" style={{ padding: '24px 26px' }}>
      <div className="flex items-center justify-between mb-[22px]">
        <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">Branch Breakdown — {meta.label}</span>
        {hasSubData && (
          <span className="text-xs text-evs-green-dark font-semibold">click a branch to reveal its sites ↓</span>
        )}
      </div>

      <div className="flex flex-col" style={{ gap: 26 }}>
        {ordered.map((branch) => {
          const cur   = current[branch]  ?? 0;
          const prev  = previous[branch] ?? 0;
          const delta = cur - prev;
          const isWorse = meta.lowerIsBetter ? delta > 0 : delta < 0;
          const color = BRANCH_COLORS[branch] ?? '#78C41A';
          const subs = getSubBranches(branch);
          const canExpand = hasSubData && subs.length > 0;
          const isOpen = !!expanded[branch];

          return (
            <div key={branch} className="py-0.5">
              <div
                className={`flex items-center gap-3 ${canExpand ? 'cursor-pointer' : ''}`}
                onClick={canExpand ? () => toggle(branch) : undefined}
              >
                <span
                  className="inline-block w-3 text-ink-muted transition-transform"
                  style={{ transform: isOpen ? 'rotate(90deg)' : 'none', opacity: canExpand ? 1 : 0 }}
                >
                  ▸
                </span>
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
                <span className="font-bold text-ink whitespace-nowrap">{branch}</span>
                {subs.length > 0 && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted border border-border rounded-full px-2 py-0.5">
                    {subs.length} sites
                  </span>
                )}
                <span className="flex-1" />
                <span className="font-bold text-base tabular-nums text-ink">{formatNumber(cur)}</span>
                <span className="w-[78px] text-right text-xs font-semibold">
                  {delta === 0 ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <span className={isWorse ? 'text-danger' : 'text-evs-green-dark'}>
                      {delta > 0 ? '▲' : '▼'} {formatNumber(Math.abs(delta))}
                    </span>
                  )}
                </span>
              </div>

              <div className="h-2 bg-surface rounded-full overflow-hidden" style={{ marginTop: 11 }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${(cur / maxVal * 100).toFixed(1)}%`, background: color }}
                />
              </div>

              {canExpand && isOpen && (
                <div className="border-t border-dashed border-border flex flex-col" style={{ marginTop: 18, paddingTop: 16, gap: 16 }}>
                  {subs.map((s) => {
                    const sv = subVal(branch, s);
                    const share = cur > 0 ? (sv / cur) * 100 : 0;
                    return (
                      <div key={s} className="flex items-center gap-[10px] text-[13px]" style={{ paddingLeft: 26 }}>
                        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                        <span className="flex-1 text-ink-soft">{s}</span>
                        <span className="w-16 text-right font-semibold tabular-nums text-ink">{formatNumber(sv)}</span>
                        <span className="w-[54px] text-right text-ink-muted text-xs tabular-nums">{share.toFixed(0)}%</span>
                        <div className="h-1.5 bg-surface rounded-full overflow-hidden" style={{ flex: '0 0 160px', marginLeft: 14 }}>
                          <div className="h-full rounded-full" style={{ width: `${(sv / maxVal * 100).toFixed(1)}%`, background: color, opacity: 0.55 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Single-branch view: show all 7 metrics for the selected branch ──── */
function SingleBranchPanel({
  branch,
  currentTotals,
  previousTotals,
  selectedMetric,
  onSelectMetric,
}: {
  branch: Branch;
  currentTotals: Record<WipMetricKey, number>;
  previousTotals: Record<WipMetricKey, number>;
  selectedMetric: WipMetricKey;
  onSelectMetric: (k: WipMetricKey) => void;
}) {
  const color = BRANCH_COLORS[branch] ?? '#78C41A';

  return (
    <div className="bg-white rounded-lg p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">All Metrics — {branch}</span>
        <span className="text-xs font-semibold px-3 py-1 rounded-full text-white" style={{ backgroundColor: color }}>
          {branch}
        </span>
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
