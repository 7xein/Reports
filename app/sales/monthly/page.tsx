import { Shell } from '@/components/Shell';
import { SalesBars } from '@/components/SalesBars';
import { SalesSummaryTable } from '@/components/SalesSummaryTable';
import { readData } from '@/lib/data-store';
import { BRANCHES } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { sumSalesFor, latestLogDate, getMonthStart } from '@/lib/sales-utils';

export const dynamic = 'force-dynamic';

const SALES_SUB_TABS = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export default function SalesMonthlyPage() {
  const data = readData();
  const { salesLog, branchConfig } = data.regional;
  const latestDate = latestLogDate(salesLog);
  const monthStart = latestDate ? getMonthStart(latestDate) : '';

  const rows = (BRANCHES as unknown as string[]).map((b) => {
    const cfg    = branchConfig[b] ?? { monthlyTarget: 0, daysInMonth: 26 };
    const actual = sumSalesFor(
      salesLog,
      b,
      (e) => monthStart ? e.date >= monthStart && e.date <= latestDate : false
    );
    return { branch: b, actual, target: cfg.monthlyTarget };
  });

  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const pct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;

  return (
    <Shell
      breadcrumbSection="Sales"
      breadcrumbPage="Monthly"
      subTabs={SALES_SUB_TABS}
      hero={{
        eyebrow: `Sales Dashboard · ${monthStart?.slice(0, 7) || '—'}`,
        title: 'Monthly Sales',
        titleEm: 'Performance',
        sub: 'Month-to-date actual vs monthly target',
        stats: [
          { value: formatCurrency(totalActual), label: 'Actual MTD' },
          { value: formatCurrency(totalTarget), label: 'Target', sub: pct !== null ? `${pct.toFixed(1)}% achieved` : undefined },
        ],
      }}
    >
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4">
        <div className="bg-white rounded-lg p-5 shadow-sm">
          <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-4">Actual vs Target</div>
          <SalesBars rows={rows} />
        </div>
        <div>
          <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-3">Branch Summary</div>
          <SalesSummaryTable rows={rows} />
        </div>
      </div>
    </Shell>
  );
}
