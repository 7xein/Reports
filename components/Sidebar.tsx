'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  {
    href: '/wip/daily',
    group: 'wip',
    label: 'WIP Dashboard',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    href: '/sales/daily',
    group: 'sales',
    label: 'Sales Dashboard',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    ),
  },
];

const ADMIN_ITEM = {
  href: '/admin',
  group: 'admin',
  label: 'Admin',
  icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2M2 12h2M20 12h2M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41"/>
    </svg>
  ),
};

export function Sidebar() {
  const pathname = usePathname();

  function isActive(group: string) {
    if (group === 'wip')    return pathname.startsWith('/wip');
    if (group === 'sales')  return pathname.startsWith('/sales');
    if (group === 'admin')  return pathname.startsWith('/admin');
    return false;
  }

  function SidebarIcon({ href, label, icon, group }: typeof NAV_ITEMS[0]) {
    const active = isActive(group);
    return (
      <Link
        href={href}
        className={`relative flex items-center justify-center w-9 h-9 rounded-lg transition-colors group ${
          active
            ? 'bg-evs-green/20 text-evs-green'
            : 'text-white/30 hover:text-white/70 hover:bg-evs-green/10'
        }`}
        title={label}
      >
        {active && (
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-evs-green" />
        )}
        {icon}
        {/* Tooltip */}
        <span className="absolute left-12 bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
          {label}
        </span>
      </Link>
    );
  }

  return (
    <aside className="shell-sidebar">
      {/* Logo */}
      <Link href="/wip/daily" className="flex items-center justify-center w-9 h-9 mb-3">
        <Image
          src="/evs-logo-new.png"
          alt="EVS"
          width={36}
          height={36}
          style={{ objectFit: 'contain', filter: 'brightness(0) invert(1)' }}
          priority
        />
      </Link>

      <div className="w-6 h-px bg-evs-dark-mid my-1" />

      {NAV_ITEMS.map((item) => (
        <SidebarIcon key={item.href} {...item} />
      ))}

      <div className="w-6 h-px bg-evs-dark-mid my-1" />

      <SidebarIcon {...ADMIN_ITEM} />
    </aside>
  );
}
