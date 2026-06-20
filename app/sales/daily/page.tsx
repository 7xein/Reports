import { Shell } from '@/components/Shell';
import { SalesDashboardClient } from '@/components/SalesDashboardClient';
import { WarrantyBranchRow } from '@/components/SalesWarrantyDashboard';
import { SalesTrendChart } from '@/components/SalesTrendChart';
import { readData } from '@/lib/data-store';
import { BRANCHES } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { getDailyTarget, sumSalesFor, sumNonWarrantyFor, latestLogDate } from '@/lib/sales-utils';

export const dynamic = 'force-dynamic';

const SALES_SUB_TABS = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export default async function SalesDailyPage() {
  const data = await readData();
  const { salesLog, branchConfig } = data.regional;
  const date = latestLogDate(salesLog);

  // Filter sales log to current month only (based on latest entry's month)
  const currentMonth = date ? date.slice(0, 7) : ''; // "YYYY-MM"
  const currentMonthSalesLog = currentMonth
    ? salesLog.filter((e) => e.date.startsWith(currentMonth))
    : salesLog;

  const onDay = (e: { date: string }) => e.date === date;

  const rows: WarrantyBranchRow[] = (BRANCHES as unknown as string[]).map((b) => {
    const cfg    = branchConfig[b] ?? { monthlyTarget: 0, daysInMonth: 26 };
    const overall = sumSalesFor(salesLog, b, onDay);
    const target  = getDailyTarget(cfg);
    return {
      branch: b,
      overall,
      withoutWarranty: sumNonWarrantyFor(salesLog, b, onDay),
      headlineTarget:  target,
      paceTarget:      target,
    };
  });

  const totalActual = rows.reduce((s, r) => s + r.overall, 0);
  const totalTarget = rows.reduce((s, r) => s + r.paceTarget, 0);
  const pct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;

  return (
    <Shell
      breadcrumbSection="Sales"
      breadcrumbPage="Daily"
      subTabs={SALES_SUB_TABS}
      hero={{
        eyebrow: `Sales Dashboard · Daily · ${date || '—'}`,
        title: 'Daily Sales',
        titleEm: 'Performance',
        sub: 'Revenue split by warranty attachment, vs daily target',
        stats: [
          { value: formatCurrency(totalActual), label: 'Actual' },
          ...(pct !== null ? [{ value: `${pct.toFixed(1)}%`, label: 'Of Target', sub: totalActual >= totalTarget ? 'On track' : 'Below target' }] : []),
        ],
      }}
    >
      <SalesDashboardClient
        rows={rows}
        salesLabel="Sales Today"
        targetLabel="Daily Target"
        pacingTitle="Today vs Daily Target"
        cap="today"
      />

      <div className="mt-4" />

      <div className="bg-white rounded-lg p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-bold uppercase tracking-wide text-ink-muted">Sales Trend</div>
            <div className="text-xs text-ink-muted mt-0.5">Daily actual sales per branch over time</div>
          </div>
          <span className="text-xs bg-evs-green/10 text-evs-green-dark font-semibold px-3 py-1 rounded-full">
            {currentMonth ? new Date(currentMonth + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'Current Month'}
          </span>
        </div>
        <SalesTrendChart salesLog={currentMonthSalesLog} branches={BRANCHES} />
      </div>
    </Shell>
  );
}
