'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { TAB_BY_ID, type TabId } from '@/lib/access';

type Me = { email: string; name: string; tabs: TabId[]; isOwner: boolean };

// One request per page load, shared by every Sidebar that mounts. A failed
// request resolves to null (and is retried on the next mount) so the sidebar
// shows no tabs rather than guessing.
let mePromise: Promise<Me | null> | null = null;
function loadMe(): Promise<Me | null> {
  if (!mePromise) {
    mePromise = fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
      .catch(() => null)
      .then((me) => {
        if (!me) mePromise = null;
        return me;
      });
  }
  return mePromise;
}

const NAV_ITEMS = [
  {
    href: TAB_BY_ID.wip.href,
    group: 'wip' as TabId,
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
    href: TAB_BY_ID.sales.href,
    group: 'sales' as TabId,
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
  {
    href: TAB_BY_ID.kpi.href,
    group: 'kpi' as TabId,
    label: 'KPI Dashboard',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20a8 8 0 1 0-8-8" />
        <path d="M12 12l4.5-4.5" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    href: TAB_BY_ID.evhub.href,
    group: 'evhub' as TabId,
    label: 'EVHUB',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/>
        <polyline points="3 8 12 13 21 8"/>
        <line x1="12" y1="13" x2="12" y2="21"/>
        <line x1="7.5" y1="5.5" x2="16.5" y2="10.5"/>
      </svg>
    ),
  },
  {
    href: TAB_BY_ID.ceo.href,
    group: 'ceo' as TabId,
    label: 'CEO',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2"/>
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        <line x1="2" y1="13" x2="22" y2="13"/>
      </svg>
    ),
  },
];

const ADMIN_ITEM = {
  href: TAB_BY_ID.admin.href,
  group: 'admin' as TabId,
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
  group: TabId;
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

const SIGN_OUT_ICON = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
);

function SignOutIcon({ email }: { email: string }) {
  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    window.location.assign('/login');
  }

  return (
    <button
      type="button"
      onClick={signOut}
      aria-label="Sign out"
      title={email}
      className="relative flex items-center justify-center w-11 h-11 rounded-xl transition-colors group text-white/35 hover:text-white/75 hover:bg-evs-green/10"
    >
      {SIGN_OUT_ICON}
      <span className="absolute left-14 bg-gray-900 text-white text-sm px-3 py-1.5 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 text-left">
        Sign out
        <span className="block text-xs text-white/60">{email}</span>
      </span>
    </button>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let alive = true;
    loadMe().then((m) => { if (alive) setMe(m); });
    return () => { alive = false; };
  }, []);

  const allowed = new Set<TabId>(me?.tabs ?? []);
  const navItems = NAV_ITEMS.filter((item) => allowed.has(item.group));
  const showAdmin = allowed.has('admin');

  function isActive(group: string) {
    if (group === 'wip')   return pathname.startsWith('/wip');
    if (group === 'sales') return pathname.startsWith('/sales');
    if (group === 'kpi')   return pathname.startsWith('/kpi');
    if (group === 'evhub') return pathname.startsWith('/evhub');
    if (group === 'ceo')   return pathname.startsWith('/ceo');
    if (group === 'admin') return pathname.startsWith('/admin');
    return false;
  }

  return (
    <aside className="shell-sidebar">
      {/* Logo — fills the full sidebar width */}
      <Link href="/" className="flex items-center justify-center w-full mb-4">
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

      {/* Nothing until /api/auth/me answers, so a tab the user cannot open never flashes up. */}
      {navItems.map((item) => (
        <SidebarIcon key={item.href} {...item} active={isActive(item.group)} />
      ))}

      {showAdmin && (
        <>
          <div className="w-8 h-px bg-[#1a3a0d] my-1" />
          <SidebarIcon {...ADMIN_ITEM} active={isActive(ADMIN_ITEM.group)} />
        </>
      )}

      {me && (
        <div className="mt-auto">
          <SignOutIcon email={me.email} />
        </div>
      )}
    </aside>
  );
}
