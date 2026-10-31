'use client';

import { usePathname } from 'next/navigation';
import { Shell } from './Shell';
import { BREADCRUMB_PAGES, type SubTab } from '@/lib/nav';

interface ShellSkeletonProps {
  breadcrumbSection: string;
  subTabs: SubTab[];
  /** Short placeholder cards in the first row (4-7). */
  cards?: number;
}

const GRID_COLS: Record<number, string> = {
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
  6: 'lg:grid-cols-6',
  7: 'lg:grid-cols-7',
};

// Loading frame for a section: the real Shell (sidebar, top bar with live
// sub-tabs, hero band) with pulsing placeholders where the data goes.
export function ShellSkeleton({ breadcrumbSection, subTabs, cards = 5 }: ShellSkeletonProps) {
  const pathname = usePathname();
  const count = Math.min(7, Math.max(4, cards));

  return (
    <Shell
      loading
      breadcrumbSection={breadcrumbSection}
      breadcrumbPage={BREADCRUMB_PAGES[pathname]}
      subTabs={subTabs}
    >
      <div aria-busy="true" aria-label="Loading">
        <div className={`grid grid-cols-2 sm:grid-cols-3 ${GRID_COLS[count]} gap-4`}>
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="h-24 bg-white rounded-lg shadow-sm animate-pulse" />
          ))}
        </div>
        <div className="mt-4 h-96 bg-white rounded-lg shadow-sm animate-pulse" />
      </div>
    </Shell>
  );
}
