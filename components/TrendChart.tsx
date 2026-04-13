'use client';

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { WipDailyEntry, WipMetricKey, WIP_METRICS, BRANCHES, Branch } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface TrendChartProps {
  entries: WipDailyEntry[];
  metric: WipMetricKey;
  branch: 'all' | Branch;
  onBranchChange: (b: 'all' | Branch) => void;
}

function sumBranches(values: Record<string, Record<string, number>>, key: string): number {
  return BRANCHES.reduce((sum, b) => sum + ((values[key]?.[b]) ?? 0), 0);
}

export function TrendChart({ entries, metric, branch, onBranchChange }: TrendChartProps) {
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
      value:
        branch === 'all'
          ? sumBranches(e.values as Record<string, Record<string, number>>, metric)
          : ((e.values[metric] as unknown as Record<string, number>)?.[branch] ?? 0),
    }));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-ink-muted">
          {branch === 'all' ? `Total across all ${BRANCHES.length} branches` : `Branch: ${branch}`}
        </span>
        {/* Branch selector styled as a pill */}
        <select
          value={branch}
          onChange={(e) => onBranchChange(e.target.value as 'all' | Branch)}
          className="text-xs bg-evs-green/10 text-evs-green-dark font-semibold px-3 py-1.5 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-evs-green/30 appearance-none pr-6"
          style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%2378C41A\' strokeWidth=\'1.5\' fill=\'none\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}
        >
          <option value="all">All Branches</option>
          {BRANCHES.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>

      <ResponsiveContainer width="100%" height={200}>
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
        {entries.length} data point{entries.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
