import { Branch, WipMetricKey, WIP_METRICS } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface MetricsTableProps {
  branches: readonly Branch[];
  current: Record<WipMetricKey, Record<Branch, number>>;
  previous: Record<WipMetricKey, Record<Branch, number>>;
}

export function MetricsTable({ branches, current, previous }: MetricsTableProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
      <table className="w-full text-[9px]">
        <thead>
          <tr className="border-b-2 border-evs-green/20 bg-evs-green/5">
            <th className="text-left px-4 py-3 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">Branch</th>
            {WIP_METRICS.map((m) => (
              <th key={m.key} className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {branches.map((branch, rowIdx) => (
            <tr key={branch} className={`border-b border-border ${rowIdx % 2 === 1 ? 'bg-surface/60' : ''}`}>
              <td className="px-4 py-2.5 font-semibold text-ink">{branch}</td>
              {WIP_METRICS.map((m) => {
                const cur  = current[m.key as WipMetricKey]?.[branch]  ?? 0;
                const prev = previous[m.key as WipMetricKey]?.[branch] ?? 0;
                const isWorse = m.lowerIsBetter ? cur > prev : cur < prev;
                return (
                  <td key={m.key} className="px-3 py-2.5 text-right tabular-nums">
                    <span className={isWorse ? 'text-danger font-semibold' : 'text-ink'}>
                      {formatNumber(cur)}
                    </span>
                    {prev !== 0 && cur !== prev && (
                      <span className={`ml-1 text-[7px] ${isWorse ? 'text-danger' : 'text-evs-green-dark'}`}>
                        {cur > prev ? '↑' : '↓'}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-t-2 border-evs-green/20 bg-evs-green/5 font-semibold">
            <td className="px-4 py-2.5 text-evs-green-dark uppercase tracking-wide text-[8px]">Total</td>
            {WIP_METRICS.map((m) => {
              const total = branches.reduce((sum, b) => sum + (current[m.key as WipMetricKey]?.[b] ?? 0), 0);
              return (
                <td key={m.key} className="px-3 py-2.5 text-right tabular-nums text-ink">
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
