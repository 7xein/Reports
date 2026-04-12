# EVS Dashboard Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the editorial paper-aesthetic dashboard with a dark-sidebar executive dashboard featuring WIP (Daily Trends + Weekly Snapshot) and Sales (Daily/Weekly/Monthly) views, EVS branding throughout.

**Architecture:** Dark 56px sidebar with EVS logo + icon nav wraps all pages. Each page has a top bar with breadcrumb/sub-tabs, a dark-green hero banner with aggregate stats, and a surface-white scrollable content area. Data comes from `data.json` which gains a new `wipHistory` time-series array. Recharts powers the WIP trend chart.

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind CSS v3, Recharts, existing font stack (Fraunces + Inter Tight + JetBrains Mono).

**Spec:** `docs/superpowers/specs/2026-04-11-evs-dashboard-redesign-design.md`

---

## File Map

**Modified:**
- `lib/types.ts` — add `WIP_METRICS`, `WipMetricKey`, `WipDailyEntry`, update `ReportData`
- `tailwind.config.js` — add `evs-dark`, `evs-dark-mid`, `surface` tokens
- `app/globals.css` — replace paper styles with new design tokens + shell CSS
- `app/layout.tsx` — strip old body classes
- `app/page.tsx` — redirect to `/wip/daily`
- `data/data.json` — add `wipHistory: []`, add `rosWithoutInvoices` to weekly values
- `app/api/data/route.ts` — add `wip-daily` POST handler
- `app/admin/AdminForm.tsx` — full replacement with two-section WIP + Sales form

**Created:**
- `components/Sidebar.tsx` — dark sidebar with EVS logo, icon nav, tooltips
- `components/HeroBanner.tsx` — dark green gradient banner
- `components/Shell.tsx` — page wrapper: sidebar + topbar + hero + content slot
- `components/KpiStrip.tsx` — 7-card horizontal KPI row
- `components/BranchBreakdownGrid.tsx` — 6 mini-cards per branch
- `components/TrendChart.tsx` — Recharts line chart for WIP history
- `components/MetricsTable.tsx` — branch rows × metric columns table
- `components/SalesBars.tsx` — actual vs target horizontal bar per branch
- `components/SalesSummaryTable.tsx` — branch summary table with progress bar
- `app/wip/daily/page.tsx` — WIP Daily Trends page
- `app/wip/weekly/page.tsx` — WIP Weekly Snapshot page
- `app/sales/daily/page.tsx` — Sales Daily page
- `app/sales/weekly/page.tsx` — Sales Weekly page
- `app/sales/monthly/page.tsx` — Sales Monthly page

**Deleted** (after all new pages verified):
- `app/weekly/` (entire directory)
- `app/daily/` (entire directory)
- `app/regional/` (entire directory, if exists)
- `components/Nav.tsx`
- `components/Section.tsx`
- `components/BranchRow.tsx`
- `components/CyclicTrendChart.tsx`
- `components/Alert.tsx` (keep only if still referenced — check first)

---

## Task 0: Foundation — Types, Schema, Tailwind, Recharts

**Goal:** Establish the new type definitions, extend `data.json`, update Tailwind tokens, and install Recharts — the prerequisite for every subsequent task.

**Files:**
- Modify: `lib/types.ts`
- Modify: `data/data.json`
- Modify: `tailwind.config.js`
- Modify: `app/globals.css`
- Modify: `app/layout.tsx`

**Acceptance Criteria:**
- [ ] `WIP_METRICS`, `WipMetricKey`, `WipDailyEntry` exported from `lib/types.ts`
- [ ] `ReportData.wipHistory` typed as `WipDailyEntry[]`
- [ ] `data.json` has `wipHistory: []` and `rosWithoutInvoices: 0` for all branches in weekly values
- [ ] Tailwind tokens `evs-dark`, `evs-dark-mid`, `surface` available
- [ ] `npm run build` passes with 0 TypeScript errors
- [ ] `recharts` installed

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Install Recharts**

```bash
cd C:/Users/hussi/OneDrive/Desktop/evs-reports
npm install recharts
```

Expected: `added N packages` with no errors.

- [ ] **Step 2: Update `lib/types.ts`**

Replace the entire file with:

```ts
export const BRANCHES = ['Dubai', 'Ajman', 'Sharjah', 'Abu Dhabi', 'Al Ain', 'Qatar'] as const;
export type Branch = typeof BRANCHES[number];

// ── WIP metrics (7 fields shown in both WIP dashboard views) ──────────────
export const WIP_METRICS = [
  { key: 'saleOrdersToInvoice',  label: 'Sale Orders / Quotations Without Invoices', lowerIsBetter: true },
  { key: 'openRepairOrders',     label: 'Open Repair Orders',                         lowerIsBetter: true },
  { key: 'warrantiesActivated',  label: 'Warranties Activated',                       lowerIsBetter: false },
  { key: 'rosWithoutQuotations', label: 'ROs Completed Without Quotations',           lowerIsBetter: true },
  { key: 'rosWithoutTags',       label: 'ROs Without Tags',                           lowerIsBetter: true },
  { key: 'quotationsNotApproved',label: 'Quotations Not Approved',                    lowerIsBetter: true },
  { key: 'rosWithoutInvoices',   label: 'Repair Orders With No Invoices',             lowerIsBetter: true },
] as const;
export type WipMetricKey = typeof WIP_METRICS[number]['key'];

// ── Legacy weekly metrics (kept for backward compat with existing data) ───
export const WEEKLY_METRICS = [
  { key: 'saleOrdersToInvoice',   label: 'Sale Orders to Invoice',                lowerIsBetter: true,  isCurrency: false },
  { key: 'openRepairOrders',      label: 'Open Repair Orders',                    lowerIsBetter: true,  isCurrency: false },
  { key: 'warrantiesActivated',   label: 'Warranties Activated',                  lowerIsBetter: false, isCurrency: false },
  { key: 'rosWithoutQuotations',  label: 'ROs Completed Without Quotations',      lowerIsBetter: true,  isCurrency: false },
  { key: 'rosWithoutTags',        label: 'ROs Without Tags',                      lowerIsBetter: true,  isCurrency: false },
  { key: 'quotationsNotApproved', label: 'Quotations Not Approved on Odoo',       lowerIsBetter: true,  isCurrency: false },
  { key: 'rosWithoutInvoices',    label: 'Repair Orders With No Invoices',        lowerIsBetter: true,  isCurrency: false },
  { key: 'totalRepairOrders',     label: 'Total Repair Orders',                   lowerIsBetter: false, isCurrency: false },
  { key: 'totalInvoicedSales',    label: 'Total Invoiced Sales',                  lowerIsBetter: false, isCurrency: true  },
] as const;
export type WeeklyMetricKey = typeof WEEKLY_METRICS[number]['key'];

export const DAILY_METRICS = [
  { key: 'newSaleOrders',       label: 'New Sale Orders Created',    lowerIsBetter: false, isCurrency: false },
  { key: 'saleOrdersInvoiced',  label: 'Sale Orders Invoiced',       lowerIsBetter: false, isCurrency: false },
  { key: 'rosOpened',           label: 'Repair Orders Opened',       lowerIsBetter: false, isCurrency: false },
  { key: 'rosClosed',           label: 'Repair Orders Closed',       lowerIsBetter: false, isCurrency: false },
  { key: 'warrantiesActivated', label: 'Warranties Activated',       lowerIsBetter: false, isCurrency: false },
  { key: 'quotationsCreated',   label: 'Quotations Created',         lowerIsBetter: false, isCurrency: false },
  { key: 'quotationsApproved',  label: 'Quotations Approved',        lowerIsBetter: false, isCurrency: false },
  { key: 'invoicesIssued',      label: 'Invoices Issued',            lowerIsBetter: false, isCurrency: false },
  { key: 'invoicedSales',       label: 'Invoiced Sales',             lowerIsBetter: false, isCurrency: true  },
] as const;
export type DailyMetricKey = typeof DAILY_METRICS[number]['key'];

export type BranchValues<K extends string> = Record<K, Record<Branch, number>>;

export interface WeeklySnapshot {
  weekStarting: string;
  weekEnding: string;
  values: BranchValues<WeeklyMetricKey>;
}

export interface DailySnapshot {
  date: string;
  values: BranchValues<DailyMetricKey>;
}

// ── New: daily WIP history entry (one per admin save) ─────────────────────
export interface WipDailyEntry {
  date: string;                        // ISO date "2026-04-11"
  values: BranchValues<WipMetricKey>;
}

export interface RegionalSalesEntry {
  date: string;
  branch: string;
  actualSales: number;
  notes?: string;
}

export interface RegionalBranchConfig {
  monthlyTarget: number;
  daysInMonth: number;
}

export interface RegionalData {
  weekStart: string;
  branchConfig: Record<string, RegionalBranchConfig>;
  salesLog: RegionalSalesEntry[];
}

export interface ReportData {
  weekly: {
    targets: BranchValues<WeeklyMetricKey>;
    current: WeeklySnapshot;
    previous: WeeklySnapshot;
    history: WeeklySnapshot[];
  };
  daily: {
    targets: BranchValues<DailyMetricKey>;
    current: DailySnapshot;
    previous: DailySnapshot;
    history: DailySnapshot[];
  };
  regional: RegionalData;
  wipHistory: WipDailyEntry[];         // NEW — daily WIP snapshots
}
```

- [ ] **Step 3: Patch `data/data.json`**

Open `data/data.json`. Make two changes:

**3a.** Add `"rosWithoutInvoices": 0` for every branch inside `weekly.targets`, `weekly.current.values`, and `weekly.previous.values`. Example — `weekly.targets` becomes:

```json
"rosWithoutInvoices": {
  "Dubai": 0, "Ajman": 0, "Sharjah": 0,
  "Abu Dhabi": 0, "Al Ain": 0, "Qatar": 0
}
```

Do the same for `weekly.current.values.rosWithoutInvoices` and `weekly.previous.values.rosWithoutInvoices`.

**3b.** Add at the top level (alongside `"weekly"`, `"daily"`, `"regional"`):

```json
"wipHistory": []
```

- [ ] **Step 4: Update `tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', 'serif'],
        sans: ['var(--font-sans)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      colors: {
        ink: {
          DEFAULT: '#1a1a1a',
          soft:    '#333333',
          muted:   '#888888',
        },
        surface:  '#f7f8f6',
        border:   '#eeeeee',
        'evs-green': {
          DEFAULT: '#78C41A',
          dark:    '#5a9015',
          light:   '#9fd94d',
        },
        'evs-dark': {
          DEFAULT: '#0d1f08',
          mid:     '#1a3a0d',
        },
        'evs-gray': {
          DEFAULT: '#808285',
          light:   '#a8aaad',
          dark:    '#555759',
        },
        danger: {
          DEFAULT: '#e53e3e',
          dark:    '#c53030',
        },
        // Legacy tokens kept for any old admin references
        paper:   { DEFAULT: '#fafaf7', warm: '#f5f3ed' },
        rule:    '#d8d4ca',
        accent:  '#78C41A',
        sage:    '#5a9015',
        rust:    '#a0451f',
        amber:   '#b8821f',
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 5: Update `app/globals.css`**

Replace the file content with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,700&family=Inter+Tight:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --font-display: 'Fraunces', Georgia, serif;
  --font-sans: 'Inter Tight', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

* { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }

html { background: #f7f8f6; color: #1a1a1a; }

body {
  font-family: var(--font-sans);
  font-feature-settings: 'ss01', 'ss02', 'cv01', 'cv02';
}

/* Number utilities */
.tnum { font-variant-numeric: tabular-nums; }
.smallcaps { font-feature-settings: 'smcp'; letter-spacing: 0.08em; text-transform: uppercase; }

/* Shell layout */
.shell-layout {
  display: flex;
  min-height: 100vh;
}
.shell-sidebar {
  width: 56px;
  flex-shrink: 0;
  background: #0d1f08;
  position: fixed;
  top: 0; left: 0; bottom: 0;
  display: flex; flex-direction: column; align-items: center;
  padding: 12px 0; gap: 4px;
  z-index: 50;
}
.shell-main {
  margin-left: 56px;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.shell-topbar {
  position: sticky; top: 0; z-index: 40;
  height: 48px;
  background: #ffffff;
  border-bottom: 1px solid #eeeeee;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px;
}
.shell-hero {
  background: linear-gradient(135deg, #0d1f08 0%, #1a3a0d 60%, #0f2a09 100%);
  padding: 16px 20px;
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.shell-content {
  flex: 1;
  background: #f7f8f6;
  padding: 16px 20px 32px;
  overflow-y: auto;
}

/* Subtle fade-in */
@keyframes fade-up {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.animate-in { animation: fade-up 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards; }
.delay-1 { animation-delay: 0.05s; opacity: 0; }
.delay-2 { animation-delay: 0.10s; opacity: 0; }
.delay-3 { animation-delay: 0.15s; opacity: 0; }
.delay-4 { animation-delay: 0.20s; opacity: 0; }

/* Print */
@media print { .shell-sidebar, .shell-topbar { display: none; } .shell-main { margin-left: 0; } }
```

- [ ] **Step 6: Strip old body classes from `app/layout.tsx`**

```tsx
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'EVS Reports',
  description: 'EVS Regional Operations Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 7: Verify build**

```bash
npm run build
```

Expected: `✓ Compiled successfully` — 0 type errors. If TypeScript complains about `rosWithoutInvoices` missing from data.json weekly values, re-check Step 3.

- [ ] **Step 8: Commit**

```bash
git add lib/types.ts tailwind.config.js app/globals.css app/layout.tsx data/data.json package.json package-lock.json
git commit -m "feat: foundation — WIP types, recharts, tailwind tokens, new CSS shell"
```

---

## Task 1: Shell Components (Sidebar + HeroBanner + Shell)

**Goal:** Build the three layout primitives that wrap every authenticated page — the dark sidebar with EVS logo, the dark-green hero banner, and the Shell wrapper that assembles them.

**Files:**
- Create: `components/Sidebar.tsx`
- Create: `components/HeroBanner.tsx`
- Create: `components/Shell.tsx`

**Acceptance Criteria:**
- [ ] Sidebar renders EVS logo image from `/evs-logo-new.png`, WIP icon, Sales icon, Admin icon with tooltips
- [ ] Active sidebar icon highlighted with green background + dot
- [ ] HeroBanner accepts eyebrow, title (with italic em), and an array of stat objects
- [ ] Shell renders sidebar + sticky topbar + hero + scrollable content slot
- [ ] `npm run build` passes

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Create `components/Sidebar.tsx`**

```tsx
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
```

- [ ] **Step 2: Create `components/HeroBanner.tsx`**

```tsx
interface HeroStat {
  value: string;
  label: string;
  sub?: string;
}

interface HeroBannerProps {
  eyebrow: string;
  title: string;        // plain part
  titleEm: string;      // italic green part (appended after title)
  sub?: string;
  stats?: HeroStat[];
}

export function HeroBanner({ eyebrow, title, titleEm, sub, stats }: HeroBannerProps) {
  return (
    <div className="shell-hero">
      <div>
        <div className="text-[9px] text-white/45 tracking-widest uppercase mb-1">{eyebrow}</div>
        <h1 className="font-display text-xl font-light text-white leading-tight">
          {title} <em className="not-italic text-evs-green font-bold">{titleEm}</em>
        </h1>
        {sub && <div className="text-[9px] text-white/40 mt-1">{sub}</div>}
      </div>
      {stats && stats.length > 0 && (
        <div className="flex gap-6">
          {stats.map((s) => (
            <div key={s.label} className="text-right">
              <div className="text-lg font-black text-evs-green tabular-nums">{s.value}</div>
              <div className="text-[8px] text-white/40 uppercase tracking-wide mt-0.5">{s.label}</div>
              {s.sub && <div className="text-[8px] text-evs-green/60 mt-0.5">{s.sub}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `components/Shell.tsx`**

```tsx
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
  breadcrumbSection: string;   // e.g. "WIP"
  breadcrumbPage: string;      // e.g. "Daily Trends"
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
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-ink-muted">
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
                    className={`text-[10px] font-semibold px-3 py-1 rounded-full transition-colors ${
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
            <span className="flex items-center gap-1.5 text-[9px] font-bold tracking-wide text-evs-green-dark bg-evs-green/10 px-2 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-evs-green animate-pulse inline-block" />
              Live
            </span>
            <div className="w-7 h-7 rounded-full bg-evs-dark flex items-center justify-center text-[10px] font-bold text-evs-green">
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
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: `✓ Compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add components/Sidebar.tsx components/HeroBanner.tsx components/Shell.tsx
git commit -m "feat: shell layout — sidebar with EVS logo, hero banner, page wrapper"
```

---

## Task 2: KpiStrip + BranchBreakdownGrid

**Goal:** Build the two WIP content components — the 7-card KPI horizontal strip and the 6-branch mini-card grid.

**Files:**
- Create: `components/KpiStrip.tsx`
- Create: `components/BranchBreakdownGrid.tsx`

**Acceptance Criteria:**
- [ ] `KpiStrip` renders 7 cards, green top border, red border when `lowerIsBetter` metric is worsening
- [ ] Each card shows value, label, and delta vs previous (↑/↓ with colour)
- [ ] `BranchBreakdownGrid` renders 6 cards in a 2×3 grid (3 cols on lg)
- [ ] Branch card left border is green when improving/stable, red when worsening
- [ ] `npm run build` passes

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Create `components/KpiStrip.tsx`**

```tsx
import { WIP_METRICS, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface KpiStripProps {
  current: Record<WipMetricKey, number>;   // totals across all branches
  previous: Record<WipMetricKey, number>;  // totals from previous entry
}

export function KpiStrip({ current, previous }: KpiStripProps) {
  return (
    <div className="grid grid-cols-7 gap-1.5 mb-3">
      {WIP_METRICS.map((m) => {
        const cur = current[m.key as WipMetricKey] ?? 0;
        const prev = previous[m.key as WipMetricKey] ?? 0;
        const delta = cur - prev;
        const isWorse = m.lowerIsBetter ? delta > 0 : delta < 0;
        const isBetter = m.lowerIsBetter ? delta < 0 : delta > 0;
        const borderColor = isWorse ? 'border-t-danger' : 'border-t-evs-green';

        return (
          <div
            key={m.key}
            className={`bg-white rounded-lg p-2.5 shadow-sm border-t-2 ${borderColor}`}
          >
            <div className="text-lg font-black text-ink tabular-nums leading-none">
              {formatNumber(cur)}
            </div>
            <div className="text-[7.5px] text-ink-muted mt-1 leading-tight">{m.label}</div>
            {prev !== 0 && (
              <div className={`text-[8px] font-semibold mt-1 ${isBetter ? 'text-evs-green-dark' : isWorse ? 'text-danger' : 'text-ink-muted'}`}>
                {delta > 0 ? '↑' : delta < 0 ? '↓' : '—'}{' '}
                {delta !== 0 ? formatNumber(Math.abs(delta)) : 'No change'}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create `components/BranchBreakdownGrid.tsx`**

```tsx
import { Branch, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface BranchBreakdownGridProps {
  metricKey: WipMetricKey;
  metricLabel: string;
  lowerIsBetter: boolean;
  current: Record<Branch, number>;
  previous: Record<Branch, number>;
  branches: readonly Branch[];
}

export function BranchBreakdownGrid({
  metricKey,
  metricLabel,
  lowerIsBetter,
  current,
  previous,
  branches,
}: BranchBreakdownGridProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-1.5">
      {branches.map((branch) => {
        const cur = current[branch] ?? 0;
        const prev = previous[branch] ?? 0;
        const delta = cur - prev;
        const isWorse = lowerIsBetter ? delta > 0 : delta < 0;
        const borderColor = isWorse ? 'border-l-danger' : 'border-l-evs-green';
        const statusLabel = delta === 0 ? '— Stable' : isWorse ? '▲ Rising' : '▼ Improving';
        const statusColor = delta === 0 ? 'text-ink-muted' : isWorse ? 'text-danger' : 'text-evs-green-dark';

        return (
          <div key={branch} className={`bg-surface rounded-md p-2 border-l-[3px] ${borderColor}`}>
            <div className="text-[9px] font-bold text-ink mb-1">{branch}</div>
            <div className="flex justify-between text-[7.5px] text-ink-muted">
              <span>{metricLabel}</span>
              <span className="font-semibold text-ink tabular-nums">{formatNumber(cur)}</span>
            </div>
            <div className={`text-[7px] font-bold mt-0.5 ${statusColor}`}>{statusLabel}</div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add components/KpiStrip.tsx components/BranchBreakdownGrid.tsx
git commit -m "feat: KpiStrip and BranchBreakdownGrid WIP components"
```

---

## Task 3: TrendChart (Recharts)

**Goal:** Build the client-side line chart that plots a selected WIP metric's total across all branches over the `wipHistory` date series.

**Files:**
- Create: `components/TrendChart.tsx`

**Acceptance Criteria:**
- [ ] Renders a Recharts `AreaChart` with EVS green stroke + fill gradient
- [ ] Accepts `entries` (WipDailyEntry[]) and `metricKey` prop
- [ ] Has a dropdown to switch which metric is displayed
- [ ] Shows "No data yet" placeholder when `entries` is empty
- [ ] `npm run build` passes (Recharts is client-only — component has `'use client'`)

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Create `components/TrendChart.tsx`**

```tsx
'use client';

import { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { WipDailyEntry, WipMetricKey, WIP_METRICS, BRANCHES } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface TrendChartProps {
  entries: WipDailyEntry[];
  defaultMetric?: WipMetricKey;
}

function sumBranches(values: Record<string, Record<string, number>>, key: string): number {
  return BRANCHES.reduce((sum, b) => sum + ((values[key]?.[b]) ?? 0), 0);
}

export function TrendChart({ entries, defaultMetric = 'openRepairOrders' }: TrendChartProps) {
  const [metric, setMetric] = useState<WipMetricKey>(defaultMetric);
  const metaMeta = WIP_METRICS.find((m) => m.key === metric)!;

  const chartData = [...entries]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({
      date: e.date,
      value: sumBranches(e.values as any, metric),
    }));

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-28 text-ink-muted text-xs">
        No trend data yet — save a WIP snapshot in Admin to start building the chart.
      </div>
    );
  }

  return (
    <div>
      {/* Metric selector */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[9px] font-bold uppercase tracking-wide text-ink-muted">
          {metaMeta.label}
        </span>
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as WipMetricKey)}
          className="text-[9px] border border-border rounded px-2 py-0.5 text-ink-muted bg-white"
        >
          {WIP_METRICS.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
      </div>

      <ResponsiveContainer width="100%" height={120}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="wipGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#78C41A" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#78C41A" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 8, fill: '#aaa' }}
            tickFormatter={(v: string) => v.slice(5)} // "MM-DD"
          />
          <YAxis tick={{ fontSize: 8, fill: '#aaa' }} />
          <Tooltip
            formatter={(v: number) => [formatNumber(v), metaMeta.label]}
            labelStyle={{ fontSize: 9 }}
            contentStyle={{ fontSize: 9, borderRadius: 6 }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#78C41A"
            strokeWidth={1.5}
            fill="url(#wipGradient)"
            dot={{ r: 2, fill: '#78C41A' }}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>

      <div className="text-[7.5px] text-ink-muted mt-1 text-right">
        Total across all 6 branches · {entries.length} data point{entries.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add components/TrendChart.tsx
git commit -m "feat: TrendChart — Recharts area chart for WIP daily trend"
```

---

## Task 4: WIP Daily Trends Page

**Goal:** Implement the `/wip/daily` page that combines Shell, KpiStrip, TrendChart, and BranchBreakdownGrid using data from `wipHistory`.

**Files:**
- Create: `app/wip/daily/page.tsx`

**Acceptance Criteria:**
- [ ] Page renders with the Shell (WIP section, "Daily Trends" active tab)
- [ ] Hero shows total Open ROs, Sale Orders, Warranties across all branches
- [ ] KpiStrip compares latest `wipHistory` entry vs previous entry (or zeros if only one entry)
- [ ] TrendChart receives all `wipHistory` entries
- [ ] BranchBreakdownGrid defaults to `openRepairOrders`; links to allow metric switching via search params
- [ ] Page gracefully handles empty `wipHistory` (shows placeholder chart, zeros in KPIs)
- [ ] `npm run build` passes

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Create directory and page**

```tsx
// app/wip/daily/page.tsx
import { Shell } from '@/components/Shell';
import { KpiStrip } from '@/components/KpiStrip';
import { TrendChart } from '@/components/TrendChart';
import { BranchBreakdownGrid } from '@/components/BranchBreakdownGrid';
import { readData } from '@/lib/data-store';
import { BRANCHES, WIP_METRICS, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

export const dynamic = 'force-dynamic';

const WIP_SUB_TABS = [
  { href: '/wip/daily',  label: 'Daily Trends' },
  { href: '/wip/weekly', label: 'Weekly Snapshot' },
];

function emptyWipTotals(): Record<WipMetricKey, number> {
  return Object.fromEntries(WIP_METRICS.map((m) => [m.key, 0])) as Record<WipMetricKey, number>;
}

function sumTotals(entry: { values: Record<string, Record<string, number>> }): Record<WipMetricKey, number> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [
      m.key,
      BRANCHES.reduce((sum, b) => sum + ((entry.values[m.key]?.[b]) ?? 0), 0),
    ])
  ) as Record<WipMetricKey, number>;
}

export default function WipDailyPage() {
  const data = readData();
  const history = [...(data.wipHistory ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  const latest = history[history.length - 1];
  const prior  = history[history.length - 2];

  const currentTotals  = latest ? sumTotals(latest)  : emptyWipTotals();
  const previousTotals = prior  ? sumTotals(prior)   : emptyWipTotals();

  // Hero stats: Open ROs, Sale Orders, Warranties
  const heroStats = [
    { value: formatNumber(currentTotals.openRepairOrders),    label: 'Open ROs',     sub: prior ? deltaLabel(currentTotals.openRepairOrders, previousTotals.openRepairOrders) : undefined },
    { value: formatNumber(currentTotals.saleOrdersToInvoice), label: 'Sale Orders',  sub: prior ? deltaLabel(currentTotals.saleOrdersToInvoice, previousTotals.saleOrdersToInvoice) : undefined },
    { value: formatNumber(currentTotals.warrantiesActivated), label: 'Warranties',   sub: prior ? deltaLabel(currentTotals.warrantiesActivated, previousTotals.warrantiesActivated) : undefined },
  ];

  return (
    <Shell
      breadcrumbSection="WIP"
      breadcrumbPage="Daily Trends"
      subTabs={WIP_SUB_TABS}
      hero={{
        eyebrow: `WIP Dashboard · All 6 Branches · ${history.length} data point${history.length !== 1 ? 's' : ''}`,
        title: 'Work In',
        titleEm: 'Progress',
        sub: 'Trend builds daily as you save WIP snapshots in Admin',
        stats: heroStats,
      }}
    >
      {/* KPI strip */}
      <KpiStrip current={currentTotals} previous={previousTotals} />

      {/* Chart + branch breakdown */}
      <div className="grid lg:grid-cols-[1.6fr_1fr] gap-3">
        {/* Trend chart */}
        <div className="bg-white rounded-lg p-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[9px] font-bold uppercase tracking-wide text-ink-muted">Daily Trend</span>
            <span className="text-[7.5px] bg-evs-green/10 text-evs-green-dark font-semibold px-2 py-0.5 rounded-full">All Branches</span>
          </div>
          <TrendChart entries={data.wipHistory ?? []} />
        </div>

        {/* Branch breakdown */}
        <div className="bg-white rounded-lg p-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[9px] font-bold uppercase tracking-wide text-ink-muted">Branch Breakdown</span>
            <span className="text-[7.5px] bg-evs-green/10 text-evs-green-dark font-semibold px-2 py-0.5 rounded-full">Open ROs</span>
          </div>
          <BranchBreakdownGrid
            metricKey="openRepairOrders"
            metricLabel="Open ROs"
            lowerIsBetter
            current={latest ? (latest.values.openRepairOrders as Record<import('@/lib/types').Branch, number>) : Object.fromEntries(BRANCHES.map(b => [b, 0])) as any}
            previous={prior  ? (prior.values.openRepairOrders  as Record<import('@/lib/types').Branch, number>) : Object.fromEntries(BRANCHES.map(b => [b, 0])) as any}
            branches={BRANCHES}
          />
        </div>
      </div>
    </Shell>
  );
}

function deltaLabel(cur: number, prev: number): string {
  const d = cur - prev;
  if (d === 0) return '— no change';
  return `${d > 0 ? '↑' : '↓'} ${formatNumber(Math.abs(d))} vs prev entry`;
}
```

- [ ] **Step 2: Verify build and dev**

```bash
npm run build
npm run dev
```

Open `http://localhost:3000/wip/daily`. Confirm Shell renders with sidebar and hero banner. With empty `wipHistory`, chart shows placeholder text and all KPIs show 0.

- [ ] **Step 3: Commit**

```bash
git add app/wip/daily/page.tsx
git commit -m "feat: /wip/daily page — daily trends with KPI strip and trend chart"
```

---

## Task 5: MetricsTable + WIP Weekly Snapshot Page

**Goal:** Build the `MetricsTable` component and the `/wip/weekly` page that shows last week's WIP snapshot vs the prior week across all 7 metrics and 6 branches.

**Files:**
- Create: `components/MetricsTable.tsx`
- Create: `app/wip/weekly/page.tsx`

**Acceptance Criteria:**
- [ ] `MetricsTable` renders rows of branches and columns of WIP metrics with red/green delta colouring
- [ ] `/wip/weekly` shows KpiStrip + full MetricsTable comparing latest entry vs entry ~7 days prior
- [ ] Totals row at bottom of MetricsTable
- [ ] `npm run build` passes

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Create `components/MetricsTable.tsx`**

```tsx
import { Branch, WipMetricKey, WIP_METRICS } from '@/lib/types';
import { formatNumber } from '@/lib/format';

interface MetricsTableProps {
  branches: readonly Branch[];
  current: Record<WipMetricKey, Record<Branch, number>>;
  previous: Record<WipMetricKey, Record<Branch, number>>;
}

export function MetricsTable({ branches, current, previous }: MetricsTableProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
      <table className="w-full text-[9px]">
        <thead>
          <tr className="border-b-2 border-evs-green/20 bg-evs-green/5">
            <th className="text-left px-4 py-3 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">Branch</th>
            {WIP_METRICS.map((m) => (
              <th key={m.key} className="text-right px-3 py-3 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {branches.map((branch, rowIdx) => (
            <tr key={branch} className={`border-b border-border ${rowIdx % 2 === 1 ? 'bg-surface/60' : ''}`}>
              <td className="px-4 py-2.5 font-semibold text-ink">{branch}</td>
              {WIP_METRICS.map((m) => {
                const cur  = current[m.key as WipMetricKey]?.[branch]  ?? 0;
                const prev = previous[m.key as WipMetricKey]?.[branch] ?? 0;
                const isWorse  = m.lowerIsBetter ? cur > prev : cur < prev;
                return (
                  <td key={m.key} className="px-3 py-2.5 text-right tabular-nums">
                    <span className={isWorse ? 'text-danger-dark font-semibold' : 'text-ink'}>
                      {formatNumber(cur)}
                    </span>
                    {prev !== 0 && cur !== prev && (
                      <span className={`ml-1 text-[7px] ${isWorse ? 'text-danger' : 'text-evs-green-dark'}`}>
                        {cur > prev ? '↑' : '↓'}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {/* Totals row */}
          <tr className="border-t-2 border-evs-green/20 bg-evs-green/5 font-semibold">
            <td className="px-4 py-2.5 text-evs-green-dark uppercase tracking-wide text-[8px]">Total</td>
            {WIP_METRICS.map((m) => {
              const total = branches.reduce((sum, b) => sum + (current[m.key as WipMetricKey]?.[b] ?? 0), 0);
              return (
                <td key={m.key} className="px-3 py-2.5 text-right tabular-nums text-ink">
                  {formatNumber(total)}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Create `app/wip/weekly/page.tsx`**

```tsx
import { Shell } from '@/components/Shell';
import { KpiStrip } from '@/components/KpiStrip';
import { MetricsTable } from '@/components/MetricsTable';
import { readData } from '@/lib/data-store';
import { BRANCHES, WIP_METRICS, WipMetricKey } from '@/lib/types';
import { formatNumber } from '@/lib/format';

export const dynamic = 'force-dynamic';

const WIP_SUB_TABS = [
  { href: '/wip/daily',  label: 'Daily Trends' },
  { href: '/wip/weekly', label: 'Weekly Snapshot' },
];

function emptyBranchValues(): Record<WipMetricKey, Record<string, number>> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [m.key, Object.fromEntries(BRANCHES.map((b) => [b, 0]))])
  ) as Record<WipMetricKey, Record<string, number>>;
}

function sumTotals(values: Record<WipMetricKey, Record<string, number>>): Record<WipMetricKey, number> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [
      m.key,
      BRANCHES.reduce((sum, b) => sum + (values[m.key]?.[b] ?? 0), 0),
    ])
  ) as Record<WipMetricKey, number>;
}

export default function WipWeeklyPage() {
  const data = readData();
  const history = [...(data.wipHistory ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  const latest = history[history.length - 1];
  // Find entry closest to 7 days before latest
  const prior = history.length >= 2
    ? history.slice(0, -1).reverse().find(() => true) // previous entry
    : undefined;

  const currentValues  = latest ? (latest.values as any) : emptyBranchValues();
  const previousValues = prior  ? (prior.values  as any) : emptyBranchValues();

  const currentTotals  = sumTotals(currentValues);
  const previousTotals = sumTotals(previousValues);

  return (
    <Shell
      breadcrumbSection="WIP"
      breadcrumbPage="Weekly Snapshot"
      subTabs={WIP_SUB_TABS}
      hero={{
        eyebrow: `WIP Dashboard · Week ending ${latest?.date ?? '—'}`,
        title: 'Weekly',
        titleEm: 'Snapshot',
        sub: 'Current entry vs previous entry across all branches',
        stats: [
          { value: formatNumber(currentTotals.openRepairOrders),    label: 'Open ROs'    },
          { value: formatNumber(currentTotals.saleOrdersToInvoice), label: 'Sale Orders' },
          { value: formatNumber(currentTotals.warrantiesActivated), label: 'Warranties'  },
        ],
      }}
    >
      <KpiStrip current={currentTotals} previous={previousTotals} />

      <div className="mt-3">
        <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-2">
          All WIP Metrics by Branch
        </div>
        <MetricsTable
          branches={BRANCHES}
          current={currentValues}
          previous={previousValues}
        />
      </div>
    </Shell>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add components/MetricsTable.tsx app/wip/weekly/page.tsx
git commit -m "feat: MetricsTable + /wip/weekly snapshot page"
```

---

## Task 6: Sales Components (SalesBars + SalesSummaryTable)

**Goal:** Build the two reusable Sales components used by all three Sales sub-views.

**Files:**
- Create: `components/SalesBars.tsx`
- Create: `components/SalesSummaryTable.tsx`

**Acceptance Criteria:**
- [ ] `SalesBars` renders one row per branch: name + actual bar (green) + target bar (grey) + % label
- [ ] Branches sorted by achievement % descending
- [ ] `SalesSummaryTable` renders Branch | Actual | Target | Ach % | Variance columns
- [ ] Totals row + progress bar underneath showing overall %
- [ ] Green if ≥100%, red if <100%
- [ ] `npm run build` passes

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Create `components/SalesBars.tsx`**

```tsx
import { formatCurrency } from '@/lib/format';

export interface SalesBranchRow {
  branch: string;
  actual: number;
  target: number;
}

interface SalesBarsProps {
  rows: SalesBranchRow[];
}

export function SalesBars({ rows }: SalesBarsProps) {
  const maxActual = Math.max(...rows.map((r) => r.actual), 1);
  const sorted = [...rows].sort((a, b) => {
    const pctA = a.target > 0 ? a.actual / a.target : a.actual > 0 ? 1 : 0;
    const pctB = b.target > 0 ? b.actual / b.target : b.actual > 0 ? 1 : 0;
    return pctB - pctA;
  });

  return (
    <div className="space-y-2">
      {sorted.map((r) => {
        const pct = r.target > 0 ? (r.actual / r.target) * 100 : null;
        const isGood = pct !== null && pct >= 100;
        const barWidth = Math.min((r.actual / maxActual) * 100, 100);
        const targetWidth = r.target > 0 ? Math.min((r.target / maxActual) * 100, 100) : 0;

        return (
          <div key={r.branch} className="flex items-center gap-2">
            <span className="text-[8.5px] font-semibold text-ink min-w-[52px]">{r.branch}</span>
            <div className="flex-1">
              <div className="h-2 rounded-full bg-evs-green mb-0.5" style={{ width: `${barWidth}%` }} />
              <div className="h-2 rounded-full bg-border" style={{ width: `${targetWidth}%` }} />
            </div>
            <span className={`text-[8px] font-bold min-w-[34px] text-right tabular-nums ${isGood ? 'text-evs-green-dark' : 'text-danger-dark'}`}>
              {pct !== null ? `${pct.toFixed(1)}%` : '—'}
            </span>
          </div>
        );
      })}
      <div className="flex gap-3 mt-1 pt-1 border-t border-border">
        <span className="flex items-center gap-1 text-[7.5px] text-ink-muted">
          <span className="w-2.5 h-2.5 rounded bg-evs-green inline-block" /> Actual
        </span>
        <span className="flex items-center gap-1 text-[7.5px] text-ink-muted">
          <span className="w-2.5 h-2.5 rounded bg-border inline-block" /> Target
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `components/SalesSummaryTable.tsx`**

```tsx
import { formatCurrency } from '@/lib/format';
import { SalesBranchRow } from './SalesBars';

interface SalesSummaryTableProps {
  rows: SalesBranchRow[];
}

export function SalesSummaryTable({ rows }: SalesSummaryTableProps) {
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const totalPct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;
  const totalGood = totalPct !== null && totalPct >= 100;

  function pctStr(actual: number, target: number) {
    if (target === 0) return '—';
    return ((actual / target) * 100).toFixed(1) + '%';
  }

  return (
    <div>
      <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full text-[9px]">
          <thead>
            <tr className="border-b-2 border-evs-green/20 bg-evs-green/5">
              {['Branch','Actual','Target','Ach %','Variance'].map((h) => (
                <th key={h} className={`px-4 py-3 font-semibold uppercase tracking-wide text-ink-muted text-[8px] ${h === 'Branch' ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const isGood = r.target > 0 && r.actual >= r.target;
              const variance = r.actual - r.target;
              return (
                <tr key={r.branch} className={`border-b border-border ${idx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="px-4 py-2.5 font-semibold text-ink">{r.branch}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink">{formatCurrency(r.actual)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink-muted">{r.target > 0 ? formatCurrency(r.target) : '—'}</td>
                  <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${isGood ? 'text-evs-green-dark' : 'text-danger-dark'}`}>
                    {pctStr(r.actual, r.target)}
                  </td>
                  <td className={`px-4 py-2.5 text-right tabular-nums ${isGood ? 'text-evs-green-dark' : 'text-danger-dark'}`}>
                    {r.target > 0 ? `${variance >= 0 ? '+' : ''}${formatCurrency(variance)}` : '—'}
                  </td>
                </tr>
              );
            })}
            {/* Totals */}
            <tr className="border-t-2 border-evs-green/20 bg-evs-green/5 font-bold">
              <td className="px-4 py-2.5 text-evs-green-dark uppercase tracking-wide text-[8px]">Total</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-ink">{formatCurrency(totalActual)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-ink-muted">{formatCurrency(totalTarget)}</td>
              <td className={`px-4 py-2.5 text-right tabular-nums font-bold ${totalGood ? 'text-evs-green-dark' : 'text-danger-dark'}`}>
                {totalPct !== null ? totalPct.toFixed(1) + '%' : '—'}
              </td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${totalGood ? 'text-evs-green-dark' : 'text-danger-dark'}`}>
                {totalTarget > 0 ? `${totalActual >= totalTarget ? '+' : ''}${formatCurrency(totalActual - totalTarget)}` : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* Progress bar */}
      {totalPct !== null && (
        <div className="mt-2">
          <div className="h-1.5 bg-border rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${totalGood ? 'bg-evs-green' : 'bg-danger'}`}
              style={{ width: `${Math.min(totalPct, 100)}%` }}
            />
          </div>
          <div className="text-[7.5px] text-ink-muted mt-1">{totalPct.toFixed(1)}% of target achieved</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add components/SalesBars.tsx components/SalesSummaryTable.tsx
git commit -m "feat: SalesBars and SalesSummaryTable sales components"
```

---

## Task 7: Sales Pages (Daily, Weekly, Monthly)

**Goal:** Implement all three Sales sub-views. All use the same layout; only the time-window calculation differs.

**Files:**
- Create: `app/sales/daily/page.tsx`
- Create: `app/sales/weekly/page.tsx`
- Create: `app/sales/monthly/page.tsx`

**Acceptance Criteria:**
- [ ] All three pages render with Shell (Sales section, correct active sub-tab)
- [ ] Daily: actual = sum of yesterday's `salesLog` entries per branch; target = `monthlyTarget ÷ daysInMonth`
- [ ] Weekly: actual = sum of `salesLog` entries in current week; target = `dailyTarget × 7`
- [ ] Monthly: actual = sum of `salesLog` entries in current month; target = `monthlyTarget`
- [ ] Hero shows total AED actual, % of target, surplus/shortfall
- [ ] `npm run build` passes

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Create a shared `lib/sales-utils.ts` helper**

```ts
// lib/sales-utils.ts
import { RegionalData, RegionalSalesEntry, RegionalBranchConfig } from './types';

export function getDailyTarget(cfg: RegionalBranchConfig) {
  return cfg.daysInMonth > 0 ? cfg.monthlyTarget / cfg.daysInMonth : 0;
}

export function sumSalesFor(
  salesLog: RegionalSalesEntry[],
  branch: string,
  filterFn: (e: RegionalSalesEntry) => boolean
) {
  return salesLog.filter((e) => e.branch === branch && filterFn(e)).reduce((s, e) => s + e.actualSales, 0);
}

export function getWeekStart(date: string, weekStartIso: string): string {
  const d  = new Date(date);
  const ws = new Date(weekStartIso);
  const diff = Math.floor((d.getTime() - ws.getTime()) / (7 * 86400_000));
  return new Date(ws.getTime() + diff * 7 * 86400_000).toISOString().slice(0, 10);
}

export function getMonthStart(date: string) {
  return date.slice(0, 7) + '-01';
}

export function latestLogDate(salesLog: RegionalSalesEntry[]): string {
  const dates = salesLog.map((e) => e.date).sort();
  return dates[dates.length - 1] ?? '';
}
```

- [ ] **Step 2: Create `app/sales/daily/page.tsx`**

```tsx
import { Shell } from '@/components/Shell';
import { SalesBars } from '@/components/SalesBars';
import { SalesSummaryTable } from '@/components/SalesSummaryTable';
import { readData } from '@/lib/data-store';
import { BRANCHES } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { getDailyTarget, sumSalesFor, latestLogDate } from '@/lib/sales-utils';

export const dynamic = 'force-dynamic';

const SALES_SUB_TABS = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export default function SalesDailyPage() {
  const data  = readData();
  const { salesLog, branchConfig } = data.regional;
  const date = latestLogDate(salesLog);

  const rows = (BRANCHES as unknown as string[]).map((b) => {
    const cfg    = branchConfig[b] ?? { monthlyTarget: 0, daysInMonth: 26 };
    const actual = sumSalesFor(salesLog, b, (e) => e.date === date);
    const target = getDailyTarget(cfg);
    return { branch: b, actual, target };
  });

  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const pct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;

  return (
    <Shell
      breadcrumbSection="Sales"
      breadcrumbPage="Daily"
      subTabs={SALES_SUB_TABS}
      hero={{
        eyebrow: `Sales Dashboard · Daily · ${date || '—'}`,
        title: 'Daily Sales',
        titleEm: 'Performance',
        sub: `Yesterday's actual vs daily target across 6 branches`,
        stats: [
          { value: formatCurrency(totalActual), label: 'Actual' },
          ...(pct !== null ? [{ value: `${pct.toFixed(1)}%`, label: 'Of Target', sub: totalActual >= totalTarget ? 'On track' : 'Below target' }] : []),
        ],
      }}
    >
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-3">
        <div className="bg-white rounded-lg p-4 shadow-sm">
          <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-3">Actual vs Target</div>
          <SalesBars rows={rows} />
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-2">Branch Summary</div>
          <SalesSummaryTable rows={rows} />
        </div>
      </div>
    </Shell>
  );
}
```

- [ ] **Step 3: Create `app/sales/weekly/page.tsx`**

```tsx
import { Shell } from '@/components/Shell';
import { SalesBars } from '@/components/SalesBars';
import { SalesSummaryTable } from '@/components/SalesSummaryTable';
import { readData } from '@/lib/data-store';
import { BRANCHES } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { getDailyTarget, sumSalesFor, latestLogDate, getWeekStart } from '@/lib/sales-utils';

export const dynamic = 'force-dynamic';

const SALES_SUB_TABS = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export default function SalesWeeklyPage() {
  const data = readData();
  const { salesLog, branchConfig, weekStart } = data.regional;
  const latestDate = latestLogDate(salesLog);
  const curWeekStart = latestDate ? getWeekStart(latestDate, weekStart) : '';

  const rows = (BRANCHES as unknown as string[]).map((b) => {
    const cfg    = branchConfig[b] ?? { monthlyTarget: 0, daysInMonth: 26 };
    const actual = sumSalesFor(salesLog, b, (e) => curWeekStart ? getWeekStart(e.date, weekStart) === curWeekStart : false);
    const target = getDailyTarget(cfg) * 7;
    return { branch: b, actual, target };
  });

  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const pct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;

  return (
    <Shell
      breadcrumbSection="Sales"
      breadcrumbPage="Weekly"
      subTabs={SALES_SUB_TABS}
      hero={{
        eyebrow: `Sales Dashboard · Week of ${curWeekStart || '—'}`,
        title: 'Weekly Sales',
        titleEm: 'Performance',
        sub: 'Current week cumulative vs weekly target',
        stats: [
          { value: formatCurrency(totalActual), label: 'Actual' },
          ...(pct !== null ? [{ value: `${pct.toFixed(1)}%`, label: 'Of Target' }] : []),
        ],
      }}
    >
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-3">
        <div className="bg-white rounded-lg p-4 shadow-sm">
          <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-3">Actual vs Target</div>
          <SalesBars rows={rows} />
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-2">Branch Summary</div>
          <SalesSummaryTable rows={rows} />
        </div>
      </div>
    </Shell>
  );
}
```

- [ ] **Step 4: Create `app/sales/monthly/page.tsx`**

```tsx
import { Shell } from '@/components/Shell';
import { SalesBars } from '@/components/SalesBars';
import { SalesSummaryTable } from '@/components/SalesSummaryTable';
import { readData } from '@/lib/data-store';
import { BRANCHES } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { sumSalesFor, latestLogDate, getMonthStart } from '@/lib/sales-utils';

export const dynamic = 'force-dynamic';

const SALES_SUB_TABS = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export default function SalesMonthlyPage() {
  const data = readData();
  const { salesLog, branchConfig } = data.regional;
  const latestDate = latestLogDate(salesLog);
  const monthStart = latestDate ? getMonthStart(latestDate) : '';

  const rows = (BRANCHES as unknown as string[]).map((b) => {
    const cfg    = branchConfig[b] ?? { monthlyTarget: 0, daysInMonth: 26 };
    const actual = sumSalesFor(salesLog, b, (e) => monthStart ? e.date >= monthStart && e.date <= latestDate : false);
    return { branch: b, actual, target: cfg.monthlyTarget };
  });

  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const pct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : null;

  return (
    <Shell
      breadcrumbSection="Sales"
      breadcrumbPage="Monthly"
      subTabs={SALES_SUB_TABS}
      hero={{
        eyebrow: `Sales Dashboard · ${monthStart?.slice(0, 7) || '—'}`,
        title: 'Monthly Sales',
        titleEm: 'Performance',
        sub: 'Month-to-date actual vs monthly target',
        stats: [
          { value: formatCurrency(totalActual), label: 'Actual MTD' },
          { value: formatCurrency(totalTarget), label: 'Target',     sub: pct !== null ? `${pct.toFixed(1)}% achieved` : undefined },
        ],
      }}
    >
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-3">
        <div className="bg-white rounded-lg p-4 shadow-sm">
          <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-3">Actual vs Target</div>
          <SalesBars rows={rows} />
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wide text-ink-muted mb-2">Branch Summary</div>
          <SalesSummaryTable rows={rows} />
        </div>
      </div>
    </Shell>
  );
}
```

- [ ] **Step 5: Verify build**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add lib/sales-utils.ts app/sales/daily/page.tsx app/sales/weekly/page.tsx app/sales/monthly/page.tsx
git commit -m "feat: Sales dashboard — daily, weekly, monthly pages with branch bars and summary table"
```

---

## Task 8: Admin Panel Rework + API

**Goal:** Replace the admin form with a two-section layout (WIP snapshot + Sales log) and add the `wip-daily` API handler.

**Files:**
- Modify: `app/admin/AdminForm.tsx`
- Modify: `app/api/data/route.ts`

**Acceptance Criteria:**
- [ ] Admin page shows two sections: WIP Snapshot and Sales Log Entry
- [ ] WIP form has date field (auto-today) + 7 metrics × 6 branches = 42 inputs, grouped by metric
- [ ] Saving WIP POSTs `{ type: 'wip-daily', payload: WipDailyEntry }` — appends/updates `wipHistory`
- [ ] Sales section retains existing log-entry behavior (add row per branch per date)
- [ ] API `wip-daily` handler sorts `wipHistory` by date after upsert
- [ ] `npm run build` passes

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Add `wip-daily` handler to `app/api/data/route.ts`**

In the POST handler's if/else chain, add before the final `else`:

```ts
} else if (body.type === 'wip-daily') {
  const entry = body.payload as import('@/lib/types').WipDailyEntry;
  if (!current.wipHistory) current.wipHistory = [];
  const idx = current.wipHistory.findIndex((e: any) => e.date === entry.date);
  if (idx >= 0) {
    current.wipHistory[idx] = entry;
  } else {
    current.wipHistory.push(entry);
  }
  current.wipHistory.sort((a: any, b: any) => a.date.localeCompare(b.date));
```

- [ ] **Step 2: Replace `app/admin/AdminForm.tsx`**

This is a full replacement. The component keeps the existing login/logout/save infrastructure but replaces the form body entirely:

```tsx
'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { BRANCHES, WIP_METRICS, WipMetricKey, ReportData, RegionalSalesEntry } from '@/lib/types';

const ADMIN_SUB_TABS = [
  { href: '/admin', label: 'Update Data' },
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptyWipValues(): Record<WipMetricKey, Record<string, number>> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [m.key, Object.fromEntries(BRANCHES.map((b) => [b, 0]))])
  ) as Record<WipMetricKey, Record<string, number>>;
}

export function AdminForm({ initialData }: { initialData: ReportData }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // ── WIP state ──────────────────────────────────────────────────────────
  const [wipDate, setWipDate] = useState(today());
  const [wipValues, setWipValues] = useState<Record<WipMetricKey, Record<string, number>>>(
    emptyWipValues()
  );

  // ── Sales state ────────────────────────────────────────────────────────
  const [salesLog, setSalesLog] = useState<RegionalSalesEntry[]>(initialData.regional.salesLog);
  const [newDate, setNewDate]   = useState(today());
  const [newEntries, setNewEntries] = useState<Record<string, { sales: string; notes: string }>>(
    Object.fromEntries(BRANCHES.map((b) => [b, { sales: '', notes: '' }]))
  );

  function setWip(metric: WipMetricKey, branch: string, val: string) {
    setWipValues((prev) => ({
      ...prev,
      [metric]: { ...prev[metric], [branch]: parseFloat(val) || 0 },
    }));
  }

  async function saveWip() {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'wip-daily', payload: { date: wipDate, values: wipValues } }),
      });
      if (!res.ok) throw new Error('Save failed');
      const total = (initialData.wipHistory?.length ?? 0) + 1;
      setMessage(`✓ WIP snapshot saved for ${wipDate} (${total} total data points)`);
    } catch {
      setMessage('Error saving WIP snapshot');
    } finally {
      setSaving(false);
    }
  }

  async function saveSales() {
    setSaving(true);
    setMessage('');
    try {
      const newRows: RegionalSalesEntry[] = BRANCHES
        .map((b) => ({
          date: newDate,
          branch: b,
          actualSales: parseFloat(newEntries[b]?.sales || '0') || 0,
          notes: newEntries[b]?.notes || '',
        }))
        .filter((r) => r.actualSales > 0);
      const updated = [...salesLog.filter((e) => !(e.date === newDate && newRows.some(r => r.branch === e.branch))), ...newRows];
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'regional-log', payload: updated }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSalesLog(updated);
      setMessage(`✓ Sales entries saved for ${newDate}`);
    } catch {
      setMessage('Error saving sales');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  }

  return (
    <Shell
      breadcrumbSection="Admin"
      breadcrumbPage="Update Data"
      subTabs={ADMIN_SUB_TABS}
      hero={{
        eyebrow: 'Admin Panel',
        title: 'Update',
        titleEm: 'Data',
        sub: 'Enter today\'s WIP snapshot and sales figures',
      }}
    >
      {/* ── WIP Section ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-ink">WIP Snapshot — Today&apos;s Numbers</h2>
          <div className="flex items-center gap-2">
            <label className="text-[9px] text-ink-muted">Date:</label>
            <input
              type="date"
              value={wipDate}
              onChange={(e) => setWipDate(e.target.value)}
              className="text-[9px] border border-border rounded px-2 py-1 text-ink"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[9px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-[8px] min-w-[180px]">Metric</th>
                {BRANCHES.map((b) => (
                  <th key={b} className="text-center py-2 px-2 font-semibold uppercase tracking-wide text-ink-muted text-[8px] min-w-[80px]">{b}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WIP_METRICS.map((m, rowIdx) => (
                <tr key={m.key} className={`border-b border-border ${rowIdx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="py-2 pr-4 text-ink font-medium leading-tight">{m.label}</td>
                  {BRANCHES.map((b) => (
                    <td key={b} className="py-1 px-1">
                      <input
                        type="number"
                        min="0"
                        value={wipValues[m.key as WipMetricKey][b] || ''}
                        onChange={(e) => setWip(m.key as WipMetricKey, b, e.target.value)}
                        className="w-full px-2 py-1 border border-border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-[9px]"
                        placeholder="0"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={saveWip}
            disabled={saving}
            className="px-5 py-2 bg-evs-green text-white text-[10px] font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save WIP Snapshot →'}
          </button>
          <span className="text-[8.5px] text-ink-muted">Each save appends to the Daily Trends chart</span>
        </div>
      </div>

      {/* ── Sales Section ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-ink">Sales Log — Add Today&apos;s Sales</h2>
          <div className="flex items-center gap-2">
            <label className="text-[9px] text-ink-muted">Date:</label>
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="text-[9px] border border-border rounded px-2 py-1 text-ink"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[9px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">Branch</th>
                <th className="text-left py-2 px-2 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">Actual Sales (AED)</th>
                <th className="text-left py-2 px-2 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">Notes</th>
              </tr>
            </thead>
            <tbody>
              {BRANCHES.map((b, idx) => (
                <tr key={b} className={`border-b border-border ${idx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="py-2 pr-4 font-semibold text-ink">{b}</td>
                  <td className="py-1 px-1">
                    <input
                      type="number" min="0"
                      value={newEntries[b]?.sales ?? ''}
                      onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], sales: e.target.value } }))}
                      className="w-full px-2 py-1 border border-border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-[9px]"
                      placeholder="0"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      value={newEntries[b]?.notes ?? ''}
                      onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], notes: e.target.value } }))}
                      className="w-full px-2 py-1 border border-border rounded text-ink focus:border-evs-green focus:outline-none text-[9px]"
                      placeholder="Optional notes"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={saveSales}
            disabled={saving}
            className="px-5 py-2 bg-evs-green text-white text-[10px] font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Sales Entry →'}
          </button>
          <button onClick={handleLogout} className="text-[9px] text-ink-muted hover:text-ink">Sign out</button>
        </div>
      </div>

      {message && (
        <div className={`mt-3 text-[10px] font-semibold ${message.startsWith('✓') ? 'text-evs-green-dark' : 'text-danger-dark'}`}>
          {message}
        </div>
      )}
    </Shell>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: `✓ Compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add app/admin/AdminForm.tsx app/api/data/route.ts
git commit -m "feat: admin rework — WIP snapshot grid + sales log entry with new shell"
```

---

## Task 9: Root Redirect + Cleanup

**Goal:** Point `/` at `/wip/daily`, remove all old routes and unused components.

**Files:**
- Modify: `app/page.tsx`
- Delete: `app/weekly/` (directory)
- Delete: `app/daily/` (directory)
- Delete: `app/regional/` (directory, if exists)
- Delete: `components/Nav.tsx`
- Delete: `components/Section.tsx`
- Delete: `components/BranchRow.tsx`
- Delete: `components/CyclicTrendChart.tsx`
- Delete: `components/Alert.tsx` (verify not referenced first)

**Acceptance Criteria:**
- [ ] Navigating to `/` redirects to `/wip/daily`
- [ ] No build errors from deleted files
- [ ] `npm run build` passes cleanly

**Verify:** `npm run build` → `✓ Compiled successfully`

**Steps:**

- [ ] **Step 1: Replace `app/page.tsx`**

```tsx
import { redirect } from 'next/navigation';
export default function RootPage() {
  redirect('/wip/daily');
}
```

- [ ] **Step 2: Check for remaining references before deleting**

```bash
grep -r "from '@/components/Nav'" app/ components/
grep -r "from '@/components/Section'" app/ components/
grep -r "from '@/components/BranchRow'" app/ components/
grep -r "from '@/components/Alert'" app/ components/
grep -r "from '@/components/CyclicTrendChart'" app/ components/
```

If any component is still imported anywhere, trace the reference and remove the import from the consuming file first. Only delete a file when nothing imports it.

- [ ] **Step 3: Delete old directories and components**

```bash
rm -rf app/weekly app/daily
# Check if app/regional exists before deleting:
[ -d app/regional ] && rm -rf app/regional
rm components/Nav.tsx components/Section.tsx components/BranchRow.tsx
rm components/CyclicTrendChart.tsx
# Only delete Alert.tsx if grep above showed zero references:
rm components/Alert.tsx
```

- [ ] **Step 4: Final build check**

```bash
npm run build
```

Expected: `✓ Compiled successfully` with 0 errors. If there are missing import errors, trace the reference from Step 2 and remove it.

- [ ] **Step 5: Smoke test in dev**

```bash
npm run dev
```

Check each route:
- `http://localhost:3000/` → redirects to `/wip/daily`
- `http://localhost:3000/wip/daily` → renders shell with sidebar, hero, KPI strip, chart
- `http://localhost:3000/wip/weekly` → renders shell, metrics table
- `http://localhost:3000/sales/daily` → renders shell, bars + table
- `http://localhost:3000/sales/weekly` → same layout, weekly numbers
- `http://localhost:3000/sales/monthly` → same layout, monthly numbers
- `http://localhost:3000/admin` → renders two-section admin form

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx
git rm -r app/weekly app/daily components/Nav.tsx components/Section.tsx components/BranchRow.tsx components/CyclicTrendChart.tsx components/Alert.tsx
git commit -m "feat: redirect root to /wip/daily, remove old routes and components"
```

---

## Dependencies Between Tasks

```
Task 0 (Foundation) → all others depend on it
Task 1 (Shell)      → Tasks 2–9 depend on Shell
Task 2 (KpiStrip, BranchBreakdownGrid) → Task 4
Task 3 (TrendChart) → Task 4
Task 4 (WIP Daily)  → independent after Tasks 0-3
Task 5 (MetricsTable, WIP Weekly) → independent after Tasks 0-1
Task 6 (SalesBars, SalesSummaryTable) → Task 7
Task 7 (Sales pages) → independent after Tasks 0-1, 6
Task 8 (Admin) → independent after Tasks 0-1
Task 9 (Cleanup) → must be last
```
