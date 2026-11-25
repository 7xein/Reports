import { Shell } from '@/components/Shell';
import { WIP_SUB_TABS } from '@/lib/nav';
import { WipDailyClient } from './WipDailyClient';
import { NoBranchAccess } from '@/components/NoBranchAccess';
import { readData } from '@/lib/data-store';
import { currentBranchAccess } from '@/lib/branch-access';
import { restrictData, visibleBranches } from '@/lib/branch-scope';
import { Branch, WORKSHOP_BRANCHES, WIP_METRICS, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

export const dynamic = 'force-dynamic';

function emptyWipTotals(): Record<WipMetricKey, number> {
  return Object.fromEntries(WIP_METRICS.map((m) => [m.key, 0])) as Record<WipMetricKey, number>;
}

function sumTotals(entry: { values: Record<string, Record<string, number>> }, branches: readonly Branch[]): Record<WipMetricKey, number> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [
      m.key,
      branches.reduce((sum, b) => sum + ((entry.values[m.key]?.[b]) ?? 0), 0),
    ])
  ) as Record<WipMetricKey, number>;
}

function deltaLabel(cur: number, prev: number): string {
  const d = cur - prev;
  if (d === 0) return '— no change';
  return `${d > 0 ? '↑' : '↓'} ${formatNumber(Math.abs(d))} vs prev`;
}

export default async function WipDailyPage() {
  // A restricted user's blob carries only their branches, so every total below is theirs.
  const access = await currentBranchAccess();
  const data = restrictData(await readData(), access);
  const branches = visibleBranches(access, WORKSHOP_BRANCHES);
  const noBranch = !access.all && access.branches.length === 0;
  const history = [...(data.wipHistory ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  const latest = history[history.length - 1];
  const prior  = history[history.length - 2];

  const currentTotals  = latest ? sumTotals(latest, branches)  : emptyWipTotals();
  const previousTotals = prior  ? sumTotals(prior, branches)   : emptyWipTotals();

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
        eyebrow: [
          'WIP Dashboard',
          // A restricted user is told which branches the figures cover, not a network count.
          access.all ? 'All 6 Branches' : branches.join(', '),
          `${history.length} data point${history.length !== 1 ? 's' : ''}`,
        ].filter(Boolean).join(' · '),
        title: 'Work In',
        titleEm: 'Progress',
        sub: 'Accumulative totals from July 2025 to date · click any metric card to change the chart',
        stats: noBranch ? undefined : heroStats,
      }}
    >
      {noBranch
        ? <NoBranchAccess />
        : <WipDailyClient wipHistory={data.wipHistory ?? []} branches={access.all ? undefined : access.branches} />}
    </Shell>
  );
}
