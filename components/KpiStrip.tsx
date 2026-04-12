import { WIP_METRICS, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface KpiStripProps {
  current: Record<WipMetricKey, number>;
  previous: Record<WipMetricKey, number>;
}

export function KpiStrip({ current, previous }: KpiStripProps) {
  return (
    <div className="grid grid-cols-7 gap-1.5 mb-3">
      {WIP_METRICS.map((m) => {
        const cur = current[m.key as WipMetricKey] ?? 0;
        const prev = previous[m.key as WipMetricKey] ?? 0;
        const delta = cur - prev;
        const isWorse = m.lowerIsBetter ? delta > 0 : delta < 0;
        const isBetter = m.lowerIsBetter ? delta < 0 : delta > 0;
        const borderColor = isWorse ? 'border-t-danger' : 'border-t-evs-green';

        return (
          <div
            key={m.key}
            className={`bg-white rounded-lg p-2.5 shadow-sm border-t-2 ${borderColor}`}
          >
            <div className="text-lg font-black text-ink tabular-nums leading-none">
              {formatNumber(cur)}
            </div>
            <div className="text-[7.5px] text-ink-muted mt-1 leading-tight">{m.label}</div>
            {prev !== 0 && (
              <div className={`text-[8px] font-semibold mt-1 ${isBetter ? 'text-evs-green-dark' : isWorse ? 'text-danger' : 'text-ink-muted'}`}>
                {delta > 0 ? '↑' : delta < 0 ? '↓' : '—'}{' '}
                {delta !== 0 ? formatNumber(Math.abs(delta)) : 'No change'}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
