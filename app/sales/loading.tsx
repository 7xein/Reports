import { ShellSkeleton } from '@/components/ShellSkeleton';
import { SALES_SUB_TABS } from '@/lib/nav';

export default function SalesLoading() {
  return <ShellSkeleton breadcrumbSection="Sales" subTabs={SALES_SUB_TABS} cards={4} />;
}
