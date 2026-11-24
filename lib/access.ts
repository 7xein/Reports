/**
 * Who may open what: the fixed list of tabs, the owner rule, and the map from
 * a URL to the tab that guards it.
 *
 * Pure data and pure functions, no imports — this file is used by the edge
 * middleware, by Node route handlers AND by client components (the sidebar),
 * so it must not pull in anything runtime-specific.
 */

// ── Tabs ──────────────────────────────────────────────────────────────────────

/** Every tab, in the order the sidebar shows them and `/` picks a landing page. */
export const TAB_IDS = ['wip', 'sales', 'kpi', 'evhub', 'ceo', 'admin'] as const;
export type TabId = (typeof TAB_IDS)[number];

export interface TabDef {
  id: TabId;
  label: string;
  /** Where the tab lands when opened (the sidebar link and the `/` redirect). */
  href: string;
}

export const TABS: readonly TabDef[] = [
  { id: 'wip',   label: 'WIP Dashboard',   href: '/wip/daily' },
  { id: 'sales', label: 'Sales Dashboard', href: '/sales/daily' },
  { id: 'kpi',   label: 'KPI Dashboard',   href: '/kpi' },
  { id: 'evhub', label: 'EVHUB',           href: '/evhub/no-rfq' },
  { id: 'ceo',   label: 'CEO',             href: '/ceo/attention' },
  { id: 'admin', label: 'Admin',           href: '/admin' },
];

export const TAB_BY_ID: Readonly<Record<TabId, TabDef>> = Object.fromEntries(
  TABS.map((t) => [t.id, t]),
) as Record<TabId, TabDef>;

export function isTabId(v: unknown): v is TabId {
  return typeof v === 'string' && (TAB_IDS as readonly string[]).includes(v);
}

/** Keep only known tab ids, drop duplicates, and put them in TAB_IDS order. */
export function cleanTabs(tabs: readonly unknown[]): TabId[] {
  const wanted = new Set(tabs.filter(isTabId));
  return TAB_IDS.filter((t) => wanted.has(t));
}

// ── Users ─────────────────────────────────────────────────────────────────────

/** The stored user record (Redis key `evs_user:<email>`). */
export interface UserRecord {
  email: string;
  name: string;
  /** `scrypt$<salt b64>$<hash b64>` — see lib/users.ts. */
  passwordHash: string;
  /** The tabs granted by the owner. Ignored for the owner, who has them all. */
  tabs: TabId[];
  createdAt: string;
  /** Bumped to sign the user out everywhere: a session must carry this exact value. */
  sessionVersion: number;
}

/** What may leave the server about a user — never the password hash. */
export interface PublicUser {
  email: string;
  name: string;
  /** Effective tabs: the owner's are always all of them. */
  tabs: TabId[];
  isOwner: boolean;
  createdAt: string;
}

const DEFAULT_OWNER_EMAIL = 'hussein.eldomor@evsuae.com';

/** Trimmed and lowercased — the one form an email is stored, keyed and compared in. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The owner's email (env OWNER_EMAIL, else the built-in default). Server/edge only. */
export function ownerEmail(): string {
  const fromEnv = typeof process !== 'undefined' ? process.env.OWNER_EMAIL : undefined;
  return normalizeEmail(fromEnv && fromEnv.trim() ? fromEnv : DEFAULT_OWNER_EMAIL);
}

export function isOwnerEmail(email: string): boolean {
  return normalizeEmail(email) === ownerEmail();
}

/** The tabs a user can actually open: every tab for the owner, else the stored list. */
export function effectiveTabs(user: Pick<UserRecord, 'email' | 'tabs'>): TabId[] {
  if (isOwnerEmail(user.email)) return [...TAB_IDS];
  return cleanTabs(user.tabs ?? []);
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    email: user.email,
    name: user.name,
    tabs: effectiveTabs(user),
    isOwner: isOwnerEmail(user.email),
    createdAt: user.createdAt,
  };
}

/** Where `/` sends a signed-in user: the first tab they have, or /welcome if none. */
export function landingHref(tabs: readonly TabId[]): string {
  const first = TABS.find((t) => tabs.includes(t.id));
  return first ? first.href : '/welcome';
}

// ── URL → tab ─────────────────────────────────────────────────────────────────

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/** The tab a PAGE belongs to, or null for pages outside every tab. */
export function tabForPage(pathname: string): TabId | null {
  if (under(pathname, '/wip'))   return 'wip';
  if (under(pathname, '/sales')) return 'sales';
  if (under(pathname, '/kpi'))   return 'kpi';
  if (under(pathname, '/evhub')) return 'evhub';
  if (under(pathname, '/ceo'))   return 'ceo';
  if (under(pathname, '/admin')) return 'admin';
  return null;
}

/**
 * Who may call an /api path (auth and the cron GET are handled before this).
 * Returns the tabs of which the user needs AT LEAST ONE, or null when the path
 * maps to no tab — which is denied: a new API route stays shut until it is
 * added here.
 */
export function tabsForApi(pathname: string, method: string): readonly TabId[] | null {
  const m = method.toUpperCase();
  if (under(pathname, '/api/evhub')) return ['evhub'];
  if (under(pathname, '/api/ceo'))   return ['ceo'];
  if (pathname === '/api/kpi')       return ['kpi'];
  if (
    pathname === '/api/kpi/odoo-options' ||
    pathname === '/api/kpi/role-proposal' ||
    pathname === '/api/kpi/roster-suggestion' ||
    under(pathname, '/api/seed') ||
    under(pathname, '/api/sync-odoo') ||
    under(pathname, '/api/users')
  ) {
    return ['admin'];
  }
  if (pathname === '/api/data') {
    // Reading is for anyone on a section that shows this data; writing is Admin's.
    return m === 'GET' || m === 'HEAD' ? ['wip', 'sales', 'kpi', 'admin'] : ['admin'];
  }
  // The WIP pages' metric CSV, plus Admin's Excel export (which the route
  // itself narrows to admin).
  if (pathname === '/api/export-odoo') return ['wip', 'sales', 'admin'];
  return null;
}
