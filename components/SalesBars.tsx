import { formatCurrency } from '@/lib/format';

export interface SalesBranchRow {
  branch: string;
  actual: number;
  target: number;
}

interface SalesBarsProps {
  rows: SalesBranchRow[];
}

export function SalesBars({ rows }: SalesBarsProps) {
  const maxActual = Math.max(...rows.map((r) => r.actual), 1);
  const sorted = [...rows].sort((a, b) => {
    const pctA = a.target > 0 ? a.actual / a.target : a.actual > 0 ? 1 : 0;
    const pctB = b.target > 0 ? b.actual / b.target : b.actual > 0 ? 1 : 0;
    return pctB - pctA;
  });

  return (
    <div className="space-y-3">
      {sorted.map((r) => {
        const pct = r.target > 0 ? (r.actual / r.target) * 100 : null;
        const isGood = pct !== null && pct >= 100;
        const barWidth = Math.min((r.actual / maxActual) * 100, 100);
        const targetWidth = r.target > 0 ? Math.min((r.target / maxActual) * 100, 100) : 0;

        return (
          <div key={r.branch} className="flex items-center gap-3">
            <span className="text-sm font-semibold text-ink min-w-[64px]">{r.branch}</span>
            <div className="flex-1 space-y-1">
              <div className="h-3 rounded-full bg-evs-green" style={{ width: `${barWidth}%` }} />
              <div className="h-3 rounded-full bg-border" style={{ width: `${targetWidth}%` }} />
            </div>
            <span className={`text-sm font-bold min-w-[44px] text-right tabular-nums ${isGood ? 'text-evs-green-dark' : 'text-danger'}`}>
              {pct !== null ? `${pct.toFixed(1)}%` : '—'}
            </span>
          </div>
        );
      })}
      <div className="flex gap-4 mt-2 pt-2 border-t border-border">
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <span className="w-3 h-3 rounded bg-evs-green inline-block" /> Actual ({formatCurrency(rows.reduce((s, r) => s + r.actual, 0))})
        </span>
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <span className="w-3 h-3 rounded bg-border inline-block" /> Target
        </span>
      </div>
    </div>
  );
}
