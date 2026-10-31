import { Shell } from '@/components/Shell';
import { KPI_SUB_TABS } from '@/lib/nav';
import { KpiClient } from './KpiClient';
import { isAdminAuthenticated } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default function KpiPage() {
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
      <KpiClient isAdmin={isAdminAuthenticated()} />
    </Shell>
  );
}
