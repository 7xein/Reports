'use client';

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { BRANCHES, WIP_METRICS, WipMetricKey, WipWeeklyEntry } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface Props {
  history: WipWeeklyEntry[];
  metric: WipMetricKey;
}

function weekTotal(entry: WipWeeklyEntry, metric: WipMetricKey): number {
  return BRANCHES.reduce((sum, b) => sum + ((entry.values[metric]?.[b]) ?? 0), 0);
}

function fmtWeek(weekEnding: string): string {
  return new Date(weekEnding + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function WipWeeklyTrend({ history, metric }: Props) {
  const meta = WIP_METRICS.find((m) => m.key === metric)!;

  if (history.length < 2) {
    return (
      <div className="flex items-center justify-center h-[200px] rounded-lg bg-surface border-2 border-dashed border-border text-ink-muted text-sm">
        Save at least two weekly snapshots to see the week-over-week trend.
      </div>
    );
  }

  const data = [...history]
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding))
    .map((e) => ({ week: fmtWeek(e.weekEnding), value: weekTotal(e, metric) }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="wipWeeklyFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#78C41A" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#78C41A" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="week" tick={{ fontSize: 11, fill: '#aaa' }} />
        <YAxis
          tick={{ fontSize: 11, fill: '#aaa' }}
          tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
        />
        <Tooltip
          formatter={(v: number) => [formatNumber(v), meta.label]}
          labelStyle={{ fontSize: 12, fontWeight: 600 }}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Area type="monotone" dataKey="value" stroke="#78C41A" strokeWidth={2.5} fill="url(#wipWeeklyFill)" dot={{ r: 3 }} activeDot={{ r: 5 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
