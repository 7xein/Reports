'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  {
    href: '/wip/daily',
    group: 'wip',
    label: 'WIP Dashboard',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
        <rect x="9" y="3" width="6" height="4" rx="1"/>
        <line x1="9" y1="12" x2="15" y2="12"/>
        <line x1="9" y1="16" x2="13" y2="16"/>
      </svg>
    ),
  },
  {
    href: '/sales/daily',
    group: 'sales',
    label: 'Sales Dashboard',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="20" x2="12" y2="10"/>
        <line x1="18" y1="20" x2="18" y2="4"/>
        <line x1="6" y1="20" x2="6" y2="16"/>
        <polyline points="2 20 22 20"/>
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
      <line x1="4" y1="6" x2="20" y2="6"/>
      <line x1="4" y1="12" x2="20" y2="12"/>
      <line x1="4" y1="18" x2="20" y2="18"/>
      <circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/>
      <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none"/>
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
      {/* Logo — fills the full sidebar width */}
      <Link href="/wip/daily" className="flex items-center justify-center w-full mb-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/evs-logo-nobg.png"
          alt="EVS"
          style={{
            width: 74,
            height: 'auto',
            objectFit: 'contain',
            filter: 'brightness(0) invert(1)',
          }}
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
