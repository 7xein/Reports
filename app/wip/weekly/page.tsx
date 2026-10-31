import { Shell } from '@/components/Shell';
import { WIP_SUB_TABS } from '@/lib/nav';
import { WipWeeklyClient } from './WipWeeklyClient';
import { readData } from '@/lib/data-store';

export const dynamic = 'force-dynamic';

export default async function WipWeeklyPage() {
  const data = await readData();
  const history = [...(data.wipWeeklyHistory ?? [])].sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));

  return (
    <Shell
      breadcrumbSection="WIP"
      breadcrumbPage="Weekly Snapshot"
      subTabs={WIP_SUB_TABS}
      hero={{
        eyebrow: `WIP Dashboard · ${history.length} week${history.length !== 1 ? 's' : ''} on record`,
        title: 'Weekly',
        titleEm: 'Snapshot',
        sub: "This week's counts only — not cumulative. Entered every Thursday. Select a week below.",
      }}
    >
      <WipWeeklyClient history={history} />
    </Shell>
  );
}
