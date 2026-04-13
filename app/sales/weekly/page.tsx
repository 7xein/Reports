import { Shell } from '@/components/Shell';
import { SalesWeeklyClient } from './SalesWeeklyClient';
import { readData } from '@/lib/data-store';
import { BRANCHES } from '@/lib/types';

export const dynamic = 'force-dynamic';

const SALES_SUB_TABS = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export default async function SalesWeeklyPage() {
  const data = await readData();
  const { salesLog, branchConfig, weekStart } = data.regional;

  return (
    <Shell
      breadcrumbSection="Sales"
      breadcrumbPage="Weekly"
      subTabs={SALES_SUB_TABS}
      hero={{
        eyebrow: 'Sales Dashboard · Weekly Performance',
        title: 'Weekly Sales',
        titleEm: 'Performance',
        sub: 'Actual vs weekly target per branch · Select a week below',
      }}
    >
      <SalesWeeklyClient
        salesLog={salesLog}
        branchConfig={branchConfig}
        weekStartRef={weekStart}
        branches={BRANCHES}
      />
    </Shell>
  );
}
