import { Shell } from '@/components/Shell';
import { KpiStrip } from '@/components/KpiStrip';
import { TrendChart } from '@/components/TrendChart';
import { BranchBreakdownGrid } from '@/components/BranchBreakdownGrid';
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

export default function WipDailyPage() {
  const data = readData();
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

  const latestBranchValues = (key: WipMetricKey) =>
    latest
      ? (latest.values[key] as Record<typeof BRANCHES[number], number>)
      : Object.fromEntries(BRANCHES.map((b) => [b, 0])) as Record<typeof BRANCHES[number], number>;

  const priorBranchValues = (key: WipMetricKey) =>
    prior
      ? (prior.values[key] as Record<typeof BRANCHES[number], number>)
      : Object.fromEntries(BRANCHES.map((b) => [b, 0])) as Record<typeof BRANCHES[number], number>;

  return (
    <Shell
      breadcrumbSection="WIP"
      breadcrumbPage="Daily Trends"
      subTabs={WIP_SUB_TABS}
      hero={{
        eyebrow: `WIP Dashboard · All 6 Branches · ${history.length} data point${history.length !== 1 ? 's' : ''}`,
        title: 'Work In',
        titleEm: 'Progress',
        sub: 'Trend builds daily as you save WIP snapshots in Admin',
        stats: heroStats,
      }}
    >
      <KpiStrip current={currentTotals} previous={previousTotals} />

      <div className="grid lg:grid-cols-[1.6fr_1fr] gap-4">
        <div className="bg-white rounded-lg p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">Daily Trend</span>
            <span className="text-xs bg-evs-green/10 text-evs-green-dark font-semibold px-3 py-1 rounded-full">All Branches</span>
          </div>
          <TrendChart entries={data.wipHistory ?? []} />
        </div>

        <div className="bg-white rounded-lg p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">Branch Breakdown</span>
            <span className="text-xs bg-evs-green/10 text-evs-green-dark font-semibold px-3 py-1 rounded-full">Open ROs</span>
          </div>
          <BranchBreakdownGrid
            metricKey="openRepairOrders"
            metricLabel="Open ROs"
            lowerIsBetter
            current={latestBranchValues('openRepairOrders')}
            previous={priorBranchValues('openRepairOrders')}
            branches={BRANCHES}
          />
        </div>
      </div>
    </Shell>
  );
}
