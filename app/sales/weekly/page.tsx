import { Shell } from '@/components/Shell';
import { SALES_SUB_TABS } from '@/lib/nav';
import { SalesWeeklyClient } from './SalesWeeklyClient';
import { NoBranchAccess } from '@/components/NoBranchAccess';
import { readData } from '@/lib/data-store';
import { currentBranchAccess } from '@/lib/branch-access';
import { restrictData, visibleBranches } from '@/lib/branch-scope';
import { BRANCHES } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function SalesWeeklyPage() {
  // A restricted user's log and targets carry only their branches, so every figure on the page is theirs.
  const access = await currentBranchAccess();
  const data = restrictData(await readData(), access);
  const noBranch = !access.all && access.branches.length === 0;
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
      {noBranch ? <NoBranchAccess /> : (
        <SalesWeeklyClient
          salesLog={salesLog}
          branchConfig={branchConfig}
          weekStartRef={weekStart}
          branches={visibleBranches(access, BRANCHES)}
        />
      )}
    </Shell>
  );
}
