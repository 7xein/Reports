'use client';

import { Fragment, useState } from 'react';
import {
  Branch, WipMetricKey, WIP_METRICS, WipSubValues,
  getSubBranches, hasSubBranches, subKey,
} from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface MetricsTableProps {
  branches: readonly Branch[];
  current: Record<WipMetricKey, Record<Branch, number>>;
  previous: Record<WipMetricKey, Record<Branch, number>>;
  subValues?: WipSubValues;
}

export function MetricsTable({ branches, current, previous, subValues }: MetricsTableProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (b: string) => setExpanded((p) => ({ ...p, [b]: !p[b] }));

  // Only offer expansion when this snapshot actually carries sub-branch detail
  const hasSubData = !!subValues;
  const subVal = (metric: WipMetricKey, branch: string, sub: string) =>
    subValues?.[metric]?.[subKey(branch, sub)] ?? 0;

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-2 border-evs-green/20 bg-evs-green/5">
            <th className="text-left px-4 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">Branch</th>
            {WIP_METRICS.map((m) => (
              <th key={m.key} className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {branches.map((branch, rowIdx) => {
            const subs = getSubBranches(branch);
            const canExpand = hasSubData && hasSubBranches(branch);
            const isOpen = !!expanded[branch];

            return (
              <Fragment key={branch}>
                <tr
                  className={`border-b border-border ${rowIdx % 2 === 1 ? 'bg-surface/60' : ''} ${canExpand ? 'cursor-pointer hover:bg-evs-green/5' : ''}`}
                  onClick={canExpand ? () => toggle(branch) : undefined}
                >
                  <td className="px-4 py-3 font-semibold text-ink whitespace-nowrap">
                    <span
                      className="inline-block w-3 mr-1 text-ink-muted transition-transform"
                      style={{ transform: isOpen ? 'rotate(90deg)' : 'none', opacity: canExpand ? 1 : 0 }}
                    >
                      ▸
                    </span>
                    {branch}
                    {subs.length > 0 && (
                      <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted border border-border rounded-full px-2 py-0.5">
                        {subs.length} sites
                      </span>
                    )}
                  </td>
                  {WIP_METRICS.map((m) => {
                    const cur  = current[m.key as WipMetricKey]?.[branch]  ?? 0;
                    const prev = previous[m.key as WipMetricKey]?.[branch] ?? 0;
                    const isWorse = m.lowerIsBetter ? cur > prev : cur < prev;
                    return (
                      <td key={m.key} className="px-3 py-3 text-right tabular-nums">
                        <span className={isWorse ? 'text-danger font-semibold' : 'text-ink'}>
                          {formatNumber(cur)}
                        </span>
                        {prev !== 0 && cur !== prev && (
                          <span className={`ml-1 text-xs ${isWorse ? 'text-danger' : 'text-evs-green-dark'}`}>
                            {cur > prev ? '↑' : '↓'}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>

                {canExpand && isOpen && subs.map((s) => (
                  <tr key={s} className="border-b border-border bg-surface/40">
                    <td className="px-4 py-2 pl-9 text-ink-soft whitespace-nowrap">↳ {s}</td>
                    {WIP_METRICS.map((m) => (
                      <td key={m.key} className="px-3 py-2 text-right tabular-nums text-ink-soft">
                        {formatNumber(subVal(m.key, branch, s))}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            );
          })}

          <tr className="border-t-2 border-evs-green/20 bg-evs-green/5 font-semibold">
            <td className="px-4 py-3 text-evs-green-dark uppercase tracking-wide text-xs">Total</td>
            {WIP_METRICS.map((m) => {
              const total = branches.reduce((sum, b) => sum + (current[m.key as WipMetricKey]?.[b] ?? 0), 0);
              return (
                <td key={m.key} className="px-3 py-3 text-right tabular-nums text-ink">
                  {formatNumber(total)}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
