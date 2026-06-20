'use client';

import { useState } from 'react';
import { BRANCHES, WIP_METRICS, getSubBranches, subKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

const BRANCH_COLORS: Record<string, string> = {
  Dubai:    '#78C41A',
  Ajman:    '#3B82F6',
  Sharjah:  '#F59E0B',
  'Abu Dhabi': '#8B5CF6',
  'Al Ain': '#EF4444',
  Qatar:    '#06B6D4',
};

type Meta = (typeof WIP_METRICS)[number];

interface Props {
  meta: Meta;
  current: Record<string, number>;
  previous?: Record<string, number>;
  /** Sub-branch values for the selected metric, keyed `${branch}__${sub}`. */
  subValues?: Record<string, number>;
  title?: string;
  /** When provided, renders an "Export all" header button + per-branch download icons. */
  onExport?: (branch?: string) => void;
  /** Key of the export currently in flight: '__all__' or a branch name. */
  exportingKey?: string | null;
}

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 3v9m0 0l-3.5-3.5M10 12l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 14v2a1 1 0 001 1h10a1 1 0 001-1v-2" strokeLinecap="round" />
    </svg>
  );
}

export function BranchBreakdownBars({ meta, current, previous, subValues, title, onExport, exportingKey }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (b: string) => setExpanded((p) => ({ ...p, [b]: !p[b] }));

  const hasSubData = !!subValues;
  const subVal = (branch: string, sub: string) => subValues?.[subKey(branch, sub)] ?? 0;

  const ordered = [...BRANCHES].sort((a, b) => (current[b] ?? 0) - (current[a] ?? 0));
  const maxVal = Math.max(...BRANCHES.map((b) => current[b] ?? 0), 1);

  return (
    <div className="bg-white rounded-lg shadow-sm" style={{ padding: '24px 26px' }}>
      <div className="flex items-center justify-between mb-[22px] gap-3">
        <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">{title ?? `Branch Breakdown — ${meta.label}`}</span>
        <div className="flex items-center gap-3">
          {hasSubData && (
            <span className="text-xs text-evs-green-dark font-semibold hidden sm:inline">click a branch to reveal its sites ↓</span>
          )}
          {onExport && (
            <button
              onClick={() => onExport(undefined)}
              disabled={exportingKey === '__all__'}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-evs-green-dark border border-border hover:border-evs-green rounded-md px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50"
              title="Export all branches for this metric (live from Odoo)"
            >
              {exportingKey === '__all__' ? <Spinner /> : <DownloadIcon />}
              Export all
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col" style={{ gap: 26 }}>
        {ordered.map((branch) => {
          const cur   = current[branch]  ?? 0;
          const prev  = previous?.[branch] ?? 0;
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
                  {previous && delta !== 0 ? (
                    <span className={isWorse ? 'text-danger' : 'text-evs-green-dark'}>
                      {delta > 0 ? '▲' : '▼'} {formatNumber(Math.abs(delta))}
                    </span>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </span>
                {onExport && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onExport(branch); }}
                    disabled={exportingKey === branch}
                    className="text-ink-muted hover:text-evs-green-dark p-1 rounded transition-colors cursor-pointer disabled:opacity-50"
                    title={`Export ${branch} records for this metric (live from Odoo)`}
                  >
                    {exportingKey === branch ? <Spinner /> : <DownloadIcon />}
                  </button>
                )}
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
