import { ShellSkeleton } from '@/components/ShellSkeleton';
import { KPI_SUB_TABS } from '@/lib/nav';

export default function KpiLoading() {
  return <ShellSkeleton breadcrumbSection="KPI" subTabs={KPI_SUB_TABS} cards={5} />;
}
