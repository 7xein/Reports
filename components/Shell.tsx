'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { HeroBanner } from './HeroBanner';

interface SubTab {
  href: string;
  label: string;
}

interface HeroStat {
  value: string;
  label: string;
  sub?: string;
}

interface ShellProps {
  breadcrumbSection: string;
  breadcrumbPage: string;
  subTabs: SubTab[];
  hero: {
    eyebrow: string;
    title: string;
    titleEm: string;
    sub?: string;
    stats?: HeroStat[];
  };
  children: React.ReactNode;
}

export function Shell({ breadcrumbSection, breadcrumbPage, subTabs, hero, children }: ShellProps) {
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
              <span className="font-semibold text-ink">{breadcrumbPage}</span>
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
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-evs-green-dark bg-evs-green/10 px-3 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-evs-green animate-pulse inline-block" />
              Live
            </span>
            <div className="w-8 h-8 rounded-full bg-evs-dark flex items-center justify-center text-xs font-bold text-evs-green">
              E
            </div>
          </div>
        </header>

        <HeroBanner {...hero} />

        <main className="shell-content">
          {children}
        </main>
      </div>
    </div>
  );
}
