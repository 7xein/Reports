'use client';

import { WIP_METRICS, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface KpiStripProps {
  current: Record<WipMetricKey, number>;
  previous: Record<WipMetricKey, number>;
  selectedMetric?: WipMetricKey;
  onSelect?: (key: WipMetricKey) => void;
}

export function KpiStrip({ current, previous, selectedMetric, onSelect }: KpiStripProps) {
  return (
    <div className="grid grid-cols-7 gap-2 mb-4">
      {WIP_METRICS.map((m) => {
        const cur = current[m.key as WipMetricKey] ?? 0;
        const prev = previous[m.key as WipMetricKey] ?? 0;
        const delta = cur - prev;
        const isWorse  = m.lowerIsBetter ? delta > 0 : delta < 0;
        const isBetter = m.lowerIsBetter ? delta < 0 : delta > 0;
        const borderColor = isWorse ? 'border-t-danger' : 'border-t-evs-green';
        const isSelected = selectedMetric === m.key;

        return (
          <div
            key={m.key}
            onClick={() => onSelect?.(m.key as WipMetricKey)}
            className={`bg-white rounded-lg p-3 shadow-sm border-t-2 ${borderColor} transition-all ${
              onSelect ? 'cursor-pointer hover:shadow-md' : ''
            } ${isSelected ? 'ring-2 ring-evs-green shadow-md' : ''}`}
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
  );
}
