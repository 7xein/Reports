import { Branch, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface BranchBreakdownGridProps {
  metricKey: WipMetricKey;
  metricLabel: string;
  lowerIsBetter: boolean;
  current: Record<Branch, number>;
  previous: Record<Branch, number>;
  branches: readonly Branch[];
}

export function BranchBreakdownGrid({
  metricKey: _metricKey,
  metricLabel,
  lowerIsBetter,
  current,
  previous,
  branches,
}: BranchBreakdownGridProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-1.5">
      {branches.map((branch) => {
        const cur = current[branch] ?? 0;
        const prev = previous[branch] ?? 0;
        const delta = cur - prev;
        const isWorse = lowerIsBetter ? delta > 0 : delta < 0;
        const borderColor = isWorse ? 'border-l-danger' : 'border-l-evs-green';
        const statusLabel = delta === 0 ? '— Stable' : isWorse ? '▲ Rising' : '▼ Improving';
        const statusColor = delta === 0 ? 'text-ink-muted' : isWorse ? 'text-danger' : 'text-evs-green-dark';

        return (
          <div key={branch} className={`bg-surface rounded-md p-2 border-l-[3px] ${borderColor}`}>
            <div className="text-[9px] font-bold text-ink mb-1">{branch}</div>
            <div className="flex justify-between text-[7.5px] text-ink-muted">
              <span>{metricLabel}</span>
              <span className="font-semibold text-ink tabular-nums">{formatNumber(cur)}</span>
            </div>
            <div className={`text-[7px] font-bold mt-0.5 ${statusColor}`}>{statusLabel}</div>
          </div>
        );
      })}
    </div>
  );
}
