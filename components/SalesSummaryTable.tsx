import { formatCurrency } from '@/lib/format';
import { SalesBranchRow } from './SalesBars';

interface SalesSummaryTableProps {
  rows: SalesBranchRow[];
}

export function SalesSummaryTable({ rows }: SalesSummaryTableProps) {
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const totalPct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;
  const totalGood = totalPct !== null && totalPct >= 100;

  function pctStr(actual: number, target: number) {
    if (target === 0) return '—';
    return ((actual / target) * 100).toFixed(1) + '%';
  }

  return (
    <div>
      <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-evs-green/20 bg-evs-green/5">
              {['Branch', 'Actual', 'Target', 'Ach %', 'Variance'].map((h) => (
                <th key={h} className={`px-4 py-3 font-semibold uppercase tracking-wide text-ink-muted text-xs ${h === 'Branch' ? 'text-left' : 'text-right'}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const isGood = r.target > 0 && r.actual >= r.target;
              const variance = r.actual - r.target;
              return (
                <tr key={r.branch} className={`border-b border-border ${idx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="px-4 py-3 font-semibold text-ink">{r.branch}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink">{formatCurrency(r.actual)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-muted">{r.target > 0 ? formatCurrency(r.target) : '—'}</td>
                  <td className={`px-4 py-3 text-right tabular-nums font-semibold ${isGood ? 'text-evs-green-dark' : 'text-danger'}`}>
                    {pctStr(r.actual, r.target)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums ${isGood ? 'text-evs-green-dark' : 'text-danger'}`}>
                    {r.target > 0 ? `${variance >= 0 ? '+' : ''}${formatCurrency(variance)}` : '—'}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-evs-green/20 bg-evs-green/5 font-bold">
              <td className="px-4 py-3 text-evs-green-dark uppercase tracking-wide text-xs">Total</td>
              <td className="px-4 py-3 text-right tabular-nums text-ink">{formatCurrency(totalActual)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-muted">{formatCurrency(totalTarget)}</td>
              <td className={`px-4 py-3 text-right tabular-nums font-bold ${totalGood ? 'text-evs-green-dark' : 'text-danger'}`}>
                {totalPct !== null ? totalPct.toFixed(1) + '%' : '—'}
              </td>
              <td className={`px-4 py-3 text-right tabular-nums ${totalGood ? 'text-evs-green-dark' : 'text-danger'}`}>
                {totalTarget > 0 ? `${totalActual >= totalTarget ? '+' : ''}${formatCurrency(totalActual - totalTarget)}` : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {totalPct !== null && (
        <div className="mt-2">
          <div className="h-2 bg-border rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${totalGood ? 'bg-evs-green' : 'bg-danger'}`}
              style={{ width: `${Math.min(totalPct, 100)}%` }}
            />
          </div>
          <div className="text-xs text-ink-muted mt-1">{totalPct.toFixed(1)}% of target achieved</div>
        </div>
      )}
    </div>
  );
}
