'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { RegionalSalesEntry } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { getWeekStart } from '@/lib/sales-utils';

type GroupBy = 'day' | 'week' | 'month';

interface SalesTrendChartProps {
  salesLog: RegionalSalesEntry[];
  branches: readonly string[];
  groupBy?: GroupBy;
  /** Required when groupBy='week' to align weeks correctly */
  weekStartRef?: string;
}

const BRANCH_COLORS: Record<string, string> = {
  Dubai:      '#78C41A',
  Ajman:      '#3B82F6',
  Sharjah:    '#F59E0B',
  'Abu Dhabi':'#8B5CF6',
  'Al Ain':   '#EF4444',
  Qatar:      '#06B6D4',
};

function groupKey(date: string, groupBy: GroupBy, weekStartRef?: string): string {
  if (groupBy === 'month') return date.slice(0, 7); // YYYY-MM
  if (groupBy === 'week')  return weekStartRef ? getWeekStart(date, weekStartRef) : date.slice(0, 10);
  return date; // day
}

function fmtKey(key: string, groupBy: GroupBy): string {
  if (groupBy === 'month') {
    // YYYY-MM → "MMM YY"
    const [y, m] = key.split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  }
  if (groupBy === 'week') {
    // week start date → "DD MMM"
    const d = new Date(key + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  // day → "MM-DD"
  return key.slice(5);
}

export function SalesTrendChart({ salesLog, branches, groupBy = 'day', weekStartRef }: SalesTrendChartProps) {
  const [visibleBranches, setVisibleBranches] = useState<Set<string>>(new Set());

  if (salesLog.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-ink-muted text-sm">
        No sales data yet — add entries in Admin to build the trend.
      </div>
    );
  }

  // Build chart data: one row per group key, columns per branch
  const keyMap = new Map<string, Record<string, number>>();
  for (const entry of salesLog) {
    const key = groupKey(entry.date, groupBy, weekStartRef);
    if (!keyMap.has(key)) keyMap.set(key, {});
    const row = keyMap.get(key)!;
    row[entry.branch] = (row[entry.branch] ?? 0) + entry.actualSales;
  }

  const chartData = [...keyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, vals]) => ({ key, label: fmtKey(key, groupBy), ...vals }));

  const toggleBranch = (branch: string) => {
    setVisibleBranches((prev) => {
      const next = new Set(prev);
      if (next.has(branch)) next.delete(branch);
      else next.add(branch);
      return next;
    });
  };

  const noneVisible = visibleBranches.size === 0;

  const pointLabel =
    groupBy === 'month' ? 'month' :
    groupBy === 'week'  ? 'week'  : 'day';

  return (
    <div>
      {/* Branch toggle buttons */}
      <div className="flex flex-wrap gap-2 mb-1">
        {branches.map((b) => {
          const active = visibleBranches.has(b);
          const color = BRANCH_COLORS[b] ?? '#999';
          return (
            <button
              key={b}
              onClick={() => toggleBranch(b)}
              className={`flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg border-2 shadow-sm transition-all select-none ${
                active
                  ? 'text-white border-transparent shadow-md scale-[1.02]'
                  : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-700 hover:shadow'
              }`}
              style={active ? { backgroundColor: color, borderColor: color } : {}}
            >
              <span
                className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                style={{ backgroundColor: active ? 'rgba(255,255,255,0.7)' : color }}
              />
              {b}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-ink-muted mb-4">
        {noneVisible
          ? 'Click a branch to show it on the chart'
          : `${visibleBranches.size} branch${visibleBranches.size !== 1 ? 'es' : ''} selected`}
      </p>

      {noneVisible ? (
        <div className="flex items-center justify-center h-[220px] rounded-lg bg-surface border-2 border-dashed border-border text-ink-muted text-sm">
          Select one or more branches above to view the trend
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: '#aaa' }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#aaa' }}
              tickFormatter={(v: number) =>
                v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
                : v >= 1_000 ? `${(v / 1_000).toFixed(0)}k`
                : String(v)
              }
            />
            <Tooltip
              formatter={(v: number, name: string) => [formatCurrency(v), name]}
              labelStyle={{ fontSize: 12, fontWeight: 600 }}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            {branches.map((b) =>
              !visibleBranches.has(b) ? null : (
                <Line
                  key={b}
                  type="monotone"
                  dataKey={b}
                  stroke={BRANCH_COLORS[b] ?? '#999'}
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls
                />
              )
            )}
          </LineChart>
        </ResponsiveContainer>
      )}

      <div className="text-xs text-ink-muted mt-2 text-right">
        {chartData.length} {pointLabel}{chartData.length !== 1 ? 's' : ''} of data
      </div>
    </div>
  );
}
