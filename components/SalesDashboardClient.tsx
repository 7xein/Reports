'use client';

import { useState } from 'react';
import { SalesWarrantyDashboard, WarrantyBranchRow } from './SalesWarrantyDashboard';
import { formatCurrency, formatCurrencySigned } from '@/lib/format';

const BRANCH_COLORS: Record<string, string> = {
  Dubai:    '#78C41A',
  Ajman:    '#3B82F6',
  Sharjah:  '#F59E0B',
  'Abu Dhabi': '#8B5CF6',
  'Al Ain': '#EF4444',
  Qatar:    '#06B6D4',
};

interface Config {
  salesLabel: string;
  targetLabel: string;
  pacingTitle: string;
  cap: string;
  isMonthly?: boolean;
  mtdNote?: string;
}

interface Props extends Config {
  rows: WarrantyBranchRow[];
}

function achColor(ach: number): string {
  if (ach >= 100) return 'text-evs-green-dark';
  if (ach >= 80) return 'text-amber-600';
  return 'text-danger';
}

export function SalesDashboardClient({ rows, ...config }: Props) {
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const branches = rows.map((r) => r.branch);

  return (
    <>
      {/* Branch selector */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-sm font-semibold text-ink-muted mr-1">Branch:</span>
        {(['all', ...branches]).map((b) => {
          const active = branchFilter === b;
          const color = b === 'all' ? '#78C41A' : (BRANCH_COLORS[b] ?? '#78C41A');
          return (
            <button
              key={b}
              onClick={() => setBranchFilter(b)}
              className={`text-sm font-semibold px-4 py-1.5 rounded-full border transition-all cursor-pointer ${
                active ? 'text-white border-transparent shadow-sm' : 'bg-white text-ink-muted border-border hover:border-gray-400'
              }`}
              style={active ? { backgroundColor: color, borderColor: color } : {}}
            >
              {b === 'all' ? 'All Branches' : b}
            </button>
          );
        })}
      </div>

      {branchFilter === 'all' ? (
        <SalesWarrantyDashboard rows={rows} {...config} />
      ) : (
        <SingleBranchDetail row={rows.find((r) => r.branch === branchFilter)!} rows={rows} {...config} />
      )}
    </>
  );
}

function SingleBranchDetail({ row, rows, salesLabel, targetLabel, cap, isMonthly }: Props & { row: WarrantyBranchRow }) {
  const color = BRANCH_COLORS[row.branch] ?? '#78C41A';

  const groupTotal = rows.reduce((s, r) => s + r.overall, 0);
  const share = groupTotal > 0 ? (row.overall / groupTotal) * 100 : 0;
  const rank = [...rows].sort((a, b) => b.overall - a.overall).findIndex((r) => r.branch === row.branch) + 1;

  const ach = row.paceTarget > 0 ? (row.overall / row.paceTarget) * 100 : 0;
  const variance = row.overall - row.paceTarget;
  const woShare = row.overall > 0 ? (row.withoutWarranty / row.overall) * 100 : 0;

  const tiles: { label: string; value: string; cls?: string }[] = [
    { label: salesLabel, value: formatCurrency(row.overall) },
    { label: 'Without Warranty', value: formatCurrency(row.withoutWarranty), cls: 'text-ink-muted' },
    ...(isMonthly ? [{ label: 'Monthly Target', value: formatCurrency(row.headlineTarget), cls: 'text-ink-muted' }] : []),
    { label: isMonthly ? 'MTD Target' : targetLabel, value: formatCurrency(row.paceTarget), cls: 'text-ink-muted' },
    { label: 'Variance', value: row.paceTarget > 0 ? formatCurrencySigned(variance) : '—', cls: variance >= 0 ? 'text-evs-green-dark' : 'text-danger' },
    { label: 'Achievement', value: row.paceTarget > 0 ? `${ach.toFixed(0)}%` : '—', cls: achColor(ach) },
  ];

  return (
    <div className="bg-white rounded-lg shadow-sm" style={{ padding: '24px 26px' }}>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full inline-block" style={{ background: color }} />
          <span className="text-lg font-bold text-ink">{row.branch}</span>
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-surface text-ink-muted">
            Rank #{rank} of {rows.length} · {share.toFixed(0)}% of group sales
          </span>
        </div>
        <span className="text-xs text-ink-muted">{cap} · {woShare.toFixed(0)}% without warranty</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg bg-surface p-4">
            <div className="text-[10px] uppercase tracking-wider text-ink-muted font-semibold">{t.label}</div>
            <div className={`text-2xl font-black tabular-nums mt-1.5 leading-none ${t.cls ?? 'text-ink'}`}>{t.value}</div>
          </div>
        ))}
      </div>

      {/* Achievement bar */}
      {row.paceTarget > 0 && (
        <div>
          <div className="h-3 bg-surface rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${ach >= 100 ? 'bg-evs-green' : ach >= 80 ? 'bg-amber-500' : 'bg-danger'}`}
              style={{ width: `${Math.min(ach, 100).toFixed(1)}%` }}
            />
          </div>
          <div className={`text-xs mt-2 font-semibold ${achColor(ach)}`}>
            {ach.toFixed(0)}% of {isMonthly ? 'MTD target' : 'target'} · {formatCurrency(row.overall)} of {formatCurrency(row.paceTarget)}
          </div>
        </div>
      )}
    </div>
  );
}
