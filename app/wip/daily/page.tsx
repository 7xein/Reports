import { Shell } from '@/components/Shell';
import { WipDailyClient } from './WipDailyClient';
import { readData } from '@/lib/data-store';
import { BRANCHES, WIP_METRICS, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

export const dynamic = 'force-dynamic';

const WIP_SUB_TABS = [
  { href: '/wip/daily',  label: 'Daily Trends' },
  { href: '/wip/weekly', label: 'Weekly Snapshot' },
];

function emptyWipTotals(): Record<WipMetricKey, number> {
  return Object.fromEntries(WIP_METRICS.map((m) => [m.key, 0])) as Record<WipMetricKey, number>;
}

function sumTotals(entry: { values: Record<string, Record<string, number>> }): Record<WipMetricKey, number> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [
      m.key,
      BRANCHES.reduce((sum, b) => sum + ((entry.values[m.key]?.[b]) ?? 0), 0),
    ])
  ) as Record<WipMetricKey, number>;
}

function deltaLabel(cur: number, prev: number): string {
  const d = cur - prev;
  if (d === 0) return '— no change';
  return `${d > 0 ? '↑' : '↓'} ${formatNumber(Math.abs(d))} vs prev`;
}

export default async function WipDailyPage() {
  const data = await readData();
  const history = [...(data.wipHistory ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  const latest = history[history.length - 1];
  const prior  = history[history.length - 2];

  const currentTotals  = latest ? sumTotals(latest)  : emptyWipTotals();
  const previousTotals = prior  ? sumTotals(prior)   : emptyWipTotals();

  const heroStats = [
    { value: formatNumber(currentTotals.openRepairOrders),    label: 'Open ROs',    sub: prior ? deltaLabel(currentTotals.openRepairOrders,    previousTotals.openRepairOrders)    : undefined },
    { value: formatNumber(currentTotals.saleOrdersToInvoice), label: 'Sale Orders', sub: prior ? deltaLabel(currentTotals.saleOrdersToInvoice, previousTotals.saleOrdersToInvoice) : undefined },
    { value: formatNumber(currentTotals.warrantiesActivated), label: 'Warranties',  sub: prior ? deltaLabel(currentTotals.warrantiesActivated, previousTotals.warrantiesActivated)  : undefined },
  ];

  return (
    <Shell
      breadcrumbSection="WIP"
      breadcrumbPage="Daily Trends"
      subTabs={WIP_SUB_TABS}
      hero={{
        eyebrow: `WIP Dashboard · All 6 Branches · ${history.length} data point${history.length !== 1 ? 's' : ''}`,
        title: 'Work In',
        titleEm: 'Progress',
        sub: 'Click any metric card to change the chart · select a branch in the trend',
        stats: heroStats,
      }}
    >
      <WipDailyClient wipHistory={data.wipHistory ?? []} />
    </Shell>
  );
}
