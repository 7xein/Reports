'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { HeroBanner, HeroBannerSkeleton } from './HeroBanner';

interface SubTab {
  href: string;
  label: string;
}

interface HeroStat {
  value: string;
  label: string;
  sub?: string;
}

interface HeroProps {
  eyebrow: string;
  title: string;
  titleEm: string;
  sub?: string;
  stats?: HeroStat[];
}

type ShellProps = {
  breadcrumbSection: string;
  subTabs: SubTab[];
  children: React.ReactNode;
} & (
  | { loading?: false; breadcrumbPage: string; hero: HeroProps }
  // Loading skeleton: same frame, hero shows placeholder bars; the page label
  // falls back to a placeholder bar when unknown.
  | { loading: true; breadcrumbPage?: string; hero?: undefined }
);

export function Shell(props: ShellProps) {
  const { breadcrumbSection, breadcrumbPage, subTabs, children } = props;
  const pathname = usePathname();

  return (
    <div className="shell-layout">
      <Sidebar />
      <div className="shell-main">
        {/* Top bar */}
        <header className="shell-topbar">
          <div className="flex items-center gap-4">
            <span className="text-sm text-ink-muted">
              {breadcrumbSection} /{' '}
              {breadcrumbPage !== undefined ? (
                <span className="font-semibold text-ink">{breadcrumbPage}</span>
              ) : (
                <span className="inline-block align-middle h-3 w-20 rounded-full bg-ink/10 animate-pulse" />
              )}
            </span>
            {/* Sub-tabs */}
            <div className="flex gap-1">
              {subTabs.map((tab) => {
                const active = pathname === tab.href;
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={`text-sm font-semibold px-4 py-1.5 rounded-full transition-colors ${
                      active
                        ? 'bg-evs-green text-white'
                        : 'text-ink-muted hover:text-ink hover:bg-surface'
                    }`}
                  >
                    {tab.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </header>

        {props.loading ? <HeroBannerSkeleton /> : <HeroBanner {...props.hero} />}

        <main className="shell-content">
          {children}
        </main>
      </div>
    </div>
  );
}
