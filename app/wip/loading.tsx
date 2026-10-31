import { ShellSkeleton } from '@/components/ShellSkeleton';
import { WIP_SUB_TABS } from '@/lib/nav';

export default function WipLoading() {
  return <ShellSkeleton breadcrumbSection="WIP" subTabs={WIP_SUB_TABS} cards={6} />;
}
