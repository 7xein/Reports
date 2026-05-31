import { formatCurrency, formatCurrencySigned } from '@/lib/format';

const W_GREEN = '#78C41A';
const W_GREY = '#c4c9cc';

const BRANCH_COLORS: Record<string, string> = {
  Dubai:       '#78C41A',
  Ajman:       '#3B82F6',
  Sharjah:     '#F59E0B',
  'Abu Dhabi': '#8B5CF6',
  'Al Ain':    '#EF4444',
  Qatar:       '#06B6D4',
};

export interface WarrantyBranchRow {
  branch: string;
  overall: number;
  withWarranty: number;
  withoutWarranty: number;
  headlineTarget: number; // the period's headline target (daily / weekly / monthly)
  paceTarget: number;     // comparable target for Ach% & Variance (daily / weekly / MTD)
}

interface Props {
  rows: WarrantyBranchRow[];
  salesLabel: string;   // "Sales Today" | "Sales This Week" | "MTD Sales"
  targetLabel: string;  // "Daily Target" | "Weekly Target" | "Monthly Target"
  pacingTitle: string;  // "Today vs Daily Target" | ...
  cap: string;          // "today" | "this week" | "MTD"
  isMonthly?: boolean;  // show Monthly Target + MTD Target tiles/columns
  mtdNote?: string;     // e.g. "Day 12 of 26" — shown in the monthly pacing footer
}

function achColor(ach: number): string {
  if (ach >= 100) return 'text-evs-green-dark';
  if (ach >= 80) return 'text-amber-600';
  return 'text-danger';
}

export function SalesWarrantyDashboard({
  rows, salesLabel, targetLabel, pacingTitle, cap, isMonthly = false, mtdNote,
}: Props) {
  const ordered = [...rows].sort((a, b) => b.overall - a.overall);

  const overall    = rows.reduce((s, r) => s + r.overall, 0);
  const withW      = rows.reduce((s, r) => s + r.withWarranty, 0);
  const withoutW   = rows.reduce((s, r) => s + r.withoutWarranty, 0);
  const headlineT  = rows.reduce((s, r) => s + r.headlineTarget, 0);
  const paceT      = rows.reduce((s, r) => s + r.paceTarget, 0);
  const attach     = overall > 0 ? (withW / overall) * 100 : 0;
  const att        = paceT > 0 ? (overall / paceT) * 100 : 0;
  const maxOverall = Math.max(...rows.map((r) => r.overall), 1);

  const attBarColor = att >= 100 ? 'bg-evs-green' : att >= 80 ? 'bg-amber-500' : 'bg-danger';
  const attTextColor = achColor(att);

  const cards = [
    { lab: 'Overall Sales',          val: overall,  foot: `all branches · ${cap}`,                     accent: '#1a1a1a' },
    { lab: 'Sales With Warranty',    val: withW,    foot: `${attach.toFixed(0)}% of revenue`,          accent: W_GREEN },
    { lab: 'Sales Without Warranty', val: withoutW, foot: `${(100 - attach).toFixed(0)}% of revenue`,  accent: W_GREY },
  ];

  return (
    <>
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {cards.map((c) => (
          <div key={c.lab} className="bg-white rounded-lg shadow-sm p-4 border-t-2" style={{ borderTopColor: c.accent }}>
            <div className="text-2xl font-black text-ink tabular-nums leading-none">{formatCurrency(c.val)}</div>
            <div className="text-xs text-ink-muted mt-1.5">{c.lab}</div>
            <div className="text-xs text-ink-muted mt-1.5 font-semibold">{c.foot}</div>
          </div>
        ))}
      </div>

      {/* Pacing card */}
      <div className="bg-white rounded-lg shadow-sm mb-4" style={{ padding: '24px 26px' }}>
        <div className="flex justify-between items-start gap-6 flex-wrap">
          <div className="min-w-[240px] flex-1">
            <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-3">{pacingTitle}</div>
            <div className="flex items-baseline gap-2.5">
              <span className="text-[28px] font-extrabold tracking-tight tabular-nums whitespace-nowrap">{formatCurrency(overall)}</span>
              <span className="text-ink-muted text-[13px]">
                {cap} actual · of {formatCurrency(paceT)} {isMonthly ? 'MTD target' : 'target'}
              </span>
            </div>
            <div className="h-4 bg-surface rounded-full overflow-hidden mt-3.5 max-w-[440px]">
              <div className={`h-full rounded-full ${attBarColor}`} style={{ width: `${Math.min(att, 100).toFixed(1)}%` }} />
            </div>
            <div className={`text-xs mt-2 font-semibold ${attTextColor}`}>
              {att.toFixed(0)}% of {isMonthly ? `pace${mtdNote ? ` · ${mtdNote}` : ''}` : 'target'}
            </div>
          </div>
          <div className="flex gap-3 flex-wrap">
            {(isMonthly
              ? [[targetLabel, headlineT], ['MTD Target', paceT]] as const
              : [[targetLabel, headlineT]] as const
            ).map(([lab, val]) => (
              <div key={lab} className="border border-border rounded-[10px] px-4 py-3 min-w-[128px] text-right">
                <div className="text-[10px] uppercase tracking-wider text-ink-muted font-semibold">{lab}</div>
                <div className="text-lg font-bold tabular-nums mt-1.5">{formatCurrency(val as number)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Warranty-split stacked bars */}
      <div className="bg-white rounded-lg shadow-sm mb-4" style={{ padding: '24px 26px' }}>
        <div className="flex items-center justify-between mb-5">
          <div className="text-sm font-bold uppercase tracking-wide text-ink-muted">Sales by Branch — Warranty Split</div>
          <div className="flex gap-4 text-xs text-ink-muted">
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] inline-block" style={{ background: W_GREEN }} />With warranty</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] inline-block" style={{ background: W_GREY }} />Without warranty</span>
          </div>
        </div>
        {ordered.map((r) => {
          const fillPct = (r.overall / maxOverall) * 100;
          const wiPct = r.overall > 0 ? (r.withWarranty / r.overall) * 100 : 0;
          const woPct = 100 - wiPct;
          const ach = r.paceTarget > 0 ? (r.overall / r.paceTarget) * 100 : 0;
          return (
            <div key={r.branch} className="mb-[18px] last:mb-0">
              <div className="flex items-center gap-2.5 mb-[7px]">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: BRANCH_COLORS[r.branch] ?? '#999' }} />
                <span className="font-bold whitespace-nowrap">{r.branch}</span>
                <span className="flex-1" />
                <span className="font-bold tabular-nums">{formatCurrency(r.overall)}</span>
                <span className={`w-32 text-right text-xs tabular-nums font-semibold ${achColor(ach)}`}>
                  {r.paceTarget > 0 ? `${ach.toFixed(0)}% of target` : '—'}
                </span>
              </div>
              <div className="h-4 bg-surface rounded-full overflow-hidden">
                <div className="h-full flex rounded-full overflow-hidden" style={{ width: `${fillPct.toFixed(1)}%`, minWidth: 2 }}>
                  <div className="h-full" style={{ width: `${wiPct.toFixed(1)}%`, background: W_GREEN }} />
                  <div className="h-full" style={{ width: `${woPct.toFixed(1)}%`, background: W_GREY }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Branch detail table */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-5 pt-4 pb-3">
          <div className="text-sm font-bold uppercase tracking-wide text-ink-muted">
            Branch Detail · {targetLabel.replace(' Target', '')}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-evs-green/20 bg-evs-green/5">
                <th className="text-left px-4 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">Branch</th>
                <th className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">{salesLabel}</th>
                <th className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">With Warranty</th>
                <th className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">Without Warranty</th>
                {isMonthly && <th className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">Monthly Target</th>}
                <th className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">{isMonthly ? 'MTD Target' : targetLabel}</th>
                <th className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">Variance</th>
                <th className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs">Ach %</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r, idx) => {
                const variance = r.overall - r.paceTarget;
                const ach = r.paceTarget > 0 ? (r.overall / r.paceTarget) * 100 : 0;
                return (
                  <tr key={r.branch} className={`border-b border-border ${idx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                    <td className="px-4 py-3 font-semibold text-ink whitespace-nowrap">
                      <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: BRANCH_COLORS[r.branch] ?? '#999' }} />
                      {r.branch}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold text-ink">{formatCurrency(r.overall)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-evs-green-dark">{formatCurrency(r.withWarranty)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-ink-muted">{formatCurrency(r.withoutWarranty)}</td>
                    {isMonthly && <td className="px-3 py-3 text-right tabular-nums text-ink-muted">{formatCurrency(r.headlineTarget)}</td>}
                    <td className="px-3 py-3 text-right tabular-nums text-ink-muted">{formatCurrency(r.paceTarget)}</td>
                    <td className={`px-3 py-3 text-right tabular-nums ${variance >= 0 ? 'text-evs-green-dark' : 'text-danger'}`}>
                      {r.paceTarget > 0 ? formatCurrencySigned(variance) : '—'}
                    </td>
                    <td className={`px-3 py-3 text-right tabular-nums font-semibold ${achColor(ach)}`}>
                      {r.paceTarget > 0 ? `${ach.toFixed(0)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-evs-green/20 bg-evs-green/5 font-bold">
                <td className="px-4 py-3 text-evs-green-dark uppercase tracking-wide text-xs">Total</td>
                <td className="px-3 py-3 text-right tabular-nums text-ink">{formatCurrency(overall)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-evs-green-dark">{formatCurrency(withW)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-ink-muted">{formatCurrency(withoutW)}</td>
                {isMonthly && <td className="px-3 py-3 text-right tabular-nums text-ink-muted">{formatCurrency(headlineT)}</td>}
                <td className="px-3 py-3 text-right tabular-nums text-ink-muted">{formatCurrency(paceT)}</td>
                <td className={`px-3 py-3 text-right tabular-nums ${overall - paceT >= 0 ? 'text-evs-green-dark' : 'text-danger'}`}>
                  {paceT > 0 ? formatCurrencySigned(overall - paceT) : '—'}
                </td>
                <td className={`px-3 py-3 text-right tabular-nums ${achColor(att)}`}>{paceT > 0 ? `${att.toFixed(0)}%` : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
