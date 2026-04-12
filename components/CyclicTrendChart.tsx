'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip,
} from 'recharts';
import { formatCurrency, formatNumber } from '@/lib/format';

export interface MetricSeries {
  key: string;
  label: string;
  format: 'number' | 'currency';
  data: { label: string; value: number }[];
}

export function CyclicTrendChart({ metrics }: { metrics: MetricSeries[] }) {
  const [idx, setIdx] = useState(0);
  if (!metrics.length) return null;
  const current = metrics[idx];

  return (
    <div className="bg-white border border-rule">
      {/* Metric selector tabs */}
      <div className="border-b border-rule overflow-x-auto">
        <div className="flex min-w-max">
          {metrics.map((m, i) => (
            <button
              key={m.key}
              onClick={() => setIdx(i)}
              className={`px-4 py-3 smallcaps text-[10px] whitespace-nowrap transition-colors border-b-2 ${
                i === idx
                  ? 'text-evs-green border-evs-green'
                  : 'text-ink-muted border-transparent hover:text-ink'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Nav arrows + chart */}
      <div className="p-8">
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={() => setIdx((idx - 1 + metrics.length) % metrics.length)}
            className="w-8 h-8 flex items-center justify-center border border-rule text-ink-muted hover:text-ink hover:border-ink transition-colors text-sm"
          >
            ←
          </button>
          <div className="text-center">
            <div className="smallcaps text-[10px] text-ink-muted mb-1">
              {idx + 1} / {metrics.length}
            </div>
            <div className="font-display text-lg text-ink">{current.label}</div>
          </div>
          <button
            onClick={() => setIdx((idx + 1) % metrics.length)}
            className="w-8 h-8 flex items-center justify-center border border-rule text-ink-muted hover:text-ink hover:border-ink transition-colors text-sm"
          >
            →
          </button>
        </div>
        <div style={{ height: 220 }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={current.data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#3d4651' }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#3d4651' }} tickFormatter={current.format === 'currency' ? formatCurrency : formatNumber} width={60} />
              <Tooltip contentStyle={{ background: '#fafaf7', border: '1px solid #d8d4ca', borderRadius: 0, fontSize: 12 }} formatter={(v: number) => (current.format === 'currency' ? formatCurrency(v) : formatNumber(v))} />
              <Line type="monotone" dataKey="value" stroke="#78C41A" strokeWidth={2} dot={{ fill: '#78C41A', r: 3 }} activeDot={{ r: 5, fill: '#5a9015' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
