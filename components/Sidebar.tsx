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
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2M2 12h2M20 12h2M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41"/>
    </svg>
  ),
};

type NavItem = {
  href: string;
  group: string;
  label: string;
  icon: React.ReactNode;
};

function SidebarIcon({ href, label, icon, group, active }: NavItem & { active: boolean }) {
  return (
    <Link
      href={href}
      className={`relative flex items-center justify-center w-11 h-11 rounded-xl transition-colors group ${
        active
          ? 'bg-evs-green/20 text-evs-green'
          : 'text-white/35 hover:text-white/75 hover:bg-evs-green/10'
      }`}
      title={label}
    >
      {active && (
        <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-evs-green" />
      )}
      {icon}
      <span className="absolute left-14 bg-gray-900 text-white text-sm px-3 py-1.5 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
        {label}
      </span>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  function isActive(group: string) {
    if (group === 'wip')   return pathname.startsWith('/wip');
    if (group === 'sales') return pathname.startsWith('/sales');
    if (group === 'admin') return pathname.startsWith('/admin');
    return false;
  }

  return (
    <aside className="shell-sidebar">
      <Link href="/wip/daily" className="flex items-center justify-center w-11 h-11 mb-3">
        <Image
          src="/evs-logo-new.png"
          alt="EVS"
          width={44}
          height={44}
          style={{ objectFit: 'contain', filter: 'brightness(0) invert(1)' }}
          priority
        />
      </Link>

      <div className="w-8 h-px bg-[#1a3a0d] my-1" />

      {NAV_ITEMS.map((item) => (
        <SidebarIcon key={item.href} {...item} active={isActive(item.group)} />
      ))}

      <div className="w-8 h-px bg-[#1a3a0d] my-1" />

      <SidebarIcon {...ADMIN_ITEM} active={isActive(ADMIN_ITEM.group)} />
    </aside>
  );
}
