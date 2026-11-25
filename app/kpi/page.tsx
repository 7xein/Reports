import { Shell } from '@/components/Shell';
import { KPI_SUB_TABS } from '@/lib/nav';
import { KpiClient } from './KpiClient';
import { NoBranchAccess } from '@/components/NoBranchAccess';
import { getCurrentUser, hasTab } from '@/lib/auth';
import { branchAccessOf } from '@/lib/branch-scope';

export const dynamic = 'force-dynamic';

export default async function KpiPage() {
  const user = await getCurrentUser();
  const isAdmin = hasTab(user, 'admin');
  const access = branchAccessOf(user);
  // The tree itself is narrowed by /api/kpi; a user with no branch gets nothing to load.
  const noBranch = !access.all && access.branches.length === 0;
  return (
    <Shell
      breadcrumbSection="KPI"
      breadcrumbPage="Weekly KPIs"
      subTabs={KPI_SUB_TABS}
      hero={{
        eyebrow: 'KPI Dashboard · Live from Odoo · Saturday → Friday',
        title: 'Service',
        titleEm: 'KPIs',
        sub: 'Company → branch → service advisor · click through to see the exact records failing each rule',
      }}
    >
      {noBranch ? <NoBranchAccess /> : <KpiClient isAdmin={isAdmin} />}
    </Shell>
  );
}
