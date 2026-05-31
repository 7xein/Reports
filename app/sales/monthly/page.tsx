import { Shell } from '@/components/Shell';
import { SalesWarrantyDashboard, WarrantyBranchRow } from '@/components/SalesWarrantyDashboard';
import { SalesTrendChart } from '@/components/SalesTrendChart';
import { readData } from '@/lib/data-store';
import { BRANCHES } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { sumSalesFor, sumWarrantyFor, sumNonWarrantyFor, latestLogDate, getMonthStart } from '@/lib/sales-utils';

export const dynamic = 'force-dynamic';

const SALES_SUB_TABS = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export default async function SalesMonthlyPage() {
  const data = await readData();
  const { salesLog, branchConfig } = data.regional;
  const latestDate = latestLogDate(salesLog);
  const monthStart = latestDate ? getMonthStart(latestDate) : '';

  const mtdDay = latestDate ? new Date(latestDate + 'T00:00:00').getDate() : new Date().getDate();
  const inMonth = (e: { date: string }) => monthStart ? e.date >= monthStart && e.date <= latestDate : false;

  const rows: WarrantyBranchRow[] = (BRANCHES as unknown as string[]).map((b) => {
    const cfg    = branchConfig[b] ?? { monthlyTarget: 0, daysInMonth: 26 };
    const mtdTarget = cfg.daysInMonth > 0 ? (cfg.monthlyTarget / cfg.daysInMonth) * mtdDay : 0;
    return {
      branch: b,
      overall:         sumSalesFor(salesLog, b, inMonth),
      withWarranty:    sumWarrantyFor(salesLog, b, inMonth),
      withoutWarranty: sumNonWarrantyFor(salesLog, b, inMonth),
      headlineTarget:  cfg.monthlyTarget, // Monthly Target
      paceTarget:      mtdTarget,         // MTD Target (used for Ach% / Variance)
    };
  });

  const totalActual = rows.reduce((s, r) => s + r.overall, 0);
  const totalTarget = rows.reduce((s, r) => s + r.headlineTarget, 0);
  const pct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;
  const daysInMonth = branchConfig[BRANCHES[0]]?.daysInMonth ?? 26;

  return (
    <Shell
      breadcrumbSection="Sales"
      breadcrumbPage="Monthly"
      subTabs={SALES_SUB_TABS}
      hero={{
        eyebrow: `Sales Dashboard · ${monthStart?.slice(0, 7) || '—'}`,
        title: 'Monthly Sales',
        titleEm: 'Performance',
        sub: 'Revenue split by warranty attachment, month-to-date',
        stats: [
          { value: formatCurrency(totalActual), label: 'Actual MTD' },
          { value: formatCurrency(totalTarget), label: 'Target', sub: pct !== null ? `${pct.toFixed(1)}% achieved` : undefined },
        ],
      }}
    >
      <SalesWarrantyDashboard
        rows={rows}
        salesLabel="MTD Sales"
        targetLabel="Monthly Target"
        pacingTitle="Month-to-Date Pacing"
        cap="MTD"
        isMonthly
        mtdNote={`Day ${mtdDay} of ${daysInMonth}`}
      />

      <div className="mt-4" />

      <div className="bg-white rounded-lg p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-bold uppercase tracking-wide text-ink-muted">Sales Trend</div>
            <div className="text-xs text-ink-muted mt-0.5">Monthly actual sales per branch over time</div>
          </div>
          <span className="text-xs bg-evs-green/10 text-evs-green-dark font-semibold px-3 py-1 rounded-full">All Months</span>
        </div>
        <SalesTrendChart salesLog={salesLog} branches={BRANCHES} groupBy="month" />
      </div>
    </Shell>
  );
}
