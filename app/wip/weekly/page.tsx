import { Shell } from '@/components/Shell';
import { KpiStrip } from '@/components/KpiStrip';
import { MetricsTable } from '@/components/MetricsTable';
import { readData } from '@/lib/data-store';
import { BRANCHES, WIP_METRICS, WipMetricKey, Branch } from '@/lib/types';
import { formatNumber } from '@/lib/format';

export const dynamic = 'force-dynamic';

const WIP_SUB_TABS = [
  { href: '/wip/daily',  label: 'Daily Trends' },
  { href: '/wip/weekly', label: 'Weekly Snapshot' },
];

function emptyBranchValues(): Record<WipMetricKey, Record<Branch, number>> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [m.key, Object.fromEntries(BRANCHES.map((b) => [b, 0]))])
  ) as Record<WipMetricKey, Record<Branch, number>>;
}

function sumTotals(values: Record<WipMetricKey, Record<Branch, number>>): Record<WipMetricKey, number> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [
      m.key,
      BRANCHES.reduce((sum, b) => sum + (values[m.key]?.[b] ?? 0), 0),
    ])
  ) as Record<WipMetricKey, number>;
}

export default function WipWeeklyPage() {
  const data = readData();
  const history = [...(data.wipHistory ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  const latest = history[history.length - 1];
  const prior  = history.length >= 2 ? history[history.length - 2] : undefined;

  const currentValues  = latest ? (latest.values as unknown as Record<WipMetricKey, Record<Branch, number>>) : emptyBranchValues();
  const previousValues = prior  ? (prior.values  as unknown as Record<WipMetricKey, Record<Branch, number>>) : emptyBranchValues();

  const currentTotals  = sumTotals(currentValues);
  const previousTotals = sumTotals(previousValues);

  return (
    <Shell
      breadcrumbSection="WIP"
      breadcrumbPage="Weekly Snapshot"
      subTabs={WIP_SUB_TABS}
      hero={{
        eyebrow: `WIP Dashboard · Week ending ${latest?.date ?? '—'}`,
        title: 'Weekly',
        titleEm: 'Snapshot',
        sub: 'Current entry vs previous entry across all branches',
        stats: [
          { value: formatNumber(currentTotals.openRepairOrders),    label: 'Open ROs'    },
          { value: formatNumber(currentTotals.saleOrdersToInvoice), label: 'Sale Orders' },
          { value: formatNumber(currentTotals.warrantiesActivated), label: 'Warranties'  },
        ],
      }}
    >
      <KpiStrip current={currentTotals} previous={previousTotals} />

      <div className="mt-3">
        <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-2">
          All WIP Metrics by Branch
        </div>
        <MetricsTable
          branches={BRANCHES}
          current={currentValues}
          previous={previousValues}
        />
      </div>
    </Shell>
  );
}
