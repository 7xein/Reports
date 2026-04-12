import { Shell } from '@/components/Shell';
import { SalesBars } from '@/components/SalesBars';
import { SalesSummaryTable } from '@/components/SalesSummaryTable';
import { readData } from '@/lib/data-store';
import { BRANCHES } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { getDailyTarget, sumSalesFor, latestLogDate, getWeekStart } from '@/lib/sales-utils';

export const dynamic = 'force-dynamic';

const SALES_SUB_TABS = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export default function SalesWeeklyPage() {
  const data = readData();
  const { salesLog, branchConfig, weekStart } = data.regional;
  const latestDate = latestLogDate(salesLog);
  const curWeekStart = latestDate ? getWeekStart(latestDate, weekStart) : '';

  const rows = (BRANCHES as unknown as string[]).map((b) => {
    const cfg    = branchConfig[b] ?? { monthlyTarget: 0, daysInMonth: 26 };
    const actual = sumSalesFor(salesLog, b, (e) => curWeekStart ? getWeekStart(e.date, weekStart) === curWeekStart : false);
    const target = getDailyTarget(cfg) * 7;
    return { branch: b, actual, target };
  });

  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const pct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;

  return (
    <Shell
      breadcrumbSection="Sales"
      breadcrumbPage="Weekly"
      subTabs={SALES_SUB_TABS}
      hero={{
        eyebrow: `Sales Dashboard · Week of ${curWeekStart || '—'}`,
        title: 'Weekly Sales',
        titleEm: 'Performance',
        sub: 'Current week cumulative vs weekly target',
        stats: [
          { value: formatCurrency(totalActual), label: 'Actual' },
          ...(pct !== null ? [{ value: `${pct.toFixed(1)}%`, label: 'Of Target' }] : []),
        ],
      }}
    >
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-3">
        <div className="bg-white rounded-lg p-4 shadow-sm">
          <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-3">Actual vs Target</div>
          <SalesBars rows={rows} />
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-2">Branch Summary</div>
          <SalesSummaryTable rows={rows} />
        </div>
      </div>
    </Shell>
  );
}
