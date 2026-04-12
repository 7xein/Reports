'use client';

import { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { WipDailyEntry, WipMetricKey, WIP_METRICS, BRANCHES } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface TrendChartProps {
  entries: WipDailyEntry[];
  defaultMetric?: WipMetricKey;
}

function sumBranches(values: Record<string, Record<string, number>>, key: string): number {
  return BRANCHES.reduce((sum, b) => sum + ((values[key]?.[b]) ?? 0), 0);
}

export function TrendChart({ entries, defaultMetric = 'openRepairOrders' }: TrendChartProps) {
  const [metric, setMetric] = useState<WipMetricKey>(defaultMetric);
  const metaMeta = WIP_METRICS.find((m) => m.key === metric)!;

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-muted text-sm">
        No trend data yet — save a WIP snapshot in Admin to start building the chart.
      </div>
    );
  }

  const chartData = [...entries]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({
      date: e.date,
      value: sumBranches(e.values as Record<string, Record<string, number>>, metric),
    }));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">
          {metaMeta.label}
        </span>
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as WipMetricKey)}
          className="text-sm border border-border rounded px-3 py-1 text-ink-muted bg-white"
        >
          {WIP_METRICS.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id="wipGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#78C41A" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#78C41A" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: '#aaa' }}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis tick={{ fontSize: 11, fill: '#aaa' }} />
          <Tooltip
            formatter={(v: number) => [formatNumber(v), metaMeta.label]}
            labelStyle={{ fontSize: 12 }}
            contentStyle={{ fontSize: 12, borderRadius: 6 }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#78C41A"
            strokeWidth={2}
            fill="url(#wipGradient)"
            dot={{ r: 3, fill: '#78C41A' }}
            activeDot={{ r: 5 }}
          />
        </AreaChart>
      </ResponsiveContainer>

      <div className="text-xs text-ink-muted mt-2 text-right">
        Total across all 6 branches · {entries.length} data point{entries.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
