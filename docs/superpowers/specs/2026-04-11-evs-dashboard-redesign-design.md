# EVS Dashboard Redesign — Design Spec
**Date:** 2026-04-11  
**Status:** Approved  
**Scope:** Full visual and functional redesign of the EVS Reports internal dashboard

---

## 1. Overview

Redesign the EVS internal reporting site from its current editorial/paper aesthetic into a professional executive dashboard. The new design uses a **dark sidebar + white content + dark-green hero banner** layout (Option C), with the EVS logo prominently in the sidebar. The site is reorganised around two top-level dashboards: **WIP** and **Sales**.

**Branches:** Dubai, Abu Dhabi, Ajman, Al Ain, Sharjah, Qatar (6 total)

---

## 2. Visual Design System

### Colour Palette (EVS Brand)
| Token | Value | Usage |
|---|---|---|
| `evs-green` | `#78C41A` | Primary accent, KPI borders, active states, badges |
| `evs-dark` | `#0d1f08` | Sidebar background, hero banner |
| `evs-dark-mid` | `#1a3a0d` | Hero banner gradient end |
| `evs-green-dark` | `#5a9015` | Hover states, secondary text on green |
| `white` | `#ffffff` | Main content area background |
| `surface` | `#f7f8f6` | Page content background (very light green-tinted white) |
| `border` | `#eeeeee` | Card and table borders |
| `ink` | `#1a1a1a` | Primary text |
| `ink-muted` | `#888888` | Secondary/label text |
| `danger` | `#e53e3e` | Alerts, negative deltas, behind-target indicators |
| `danger-dark` | `#c53030` | Danger text |

### Typography
- **Display/headings:** Fraunces (existing) — kept for hero titles only
- **Body/UI:** Inter Tight (existing) — all labels, numbers, nav
- **Monospace:** JetBrains Mono (existing) — numeric data cells

### Layout Shell
- **Sidebar:** 56px wide, `evs-dark` background, always visible
- **Top bar:** 48px tall, white, sticky — contains breadcrumb + sub-tabs + live badge + avatar
- **Hero banner:** ~72px tall, dark green gradient — page title + key aggregate stats
- **Content area:** `surface` background, scrollable, padded 14px/20px

---

## 3. Navigation Structure

### Sidebar Icons (top to bottom)
1. **EVS Logo** — `#78C41A` on dark background, links to home
2. Divider
3. **WIP Dashboard** icon — grid/squares icon, active = green ring
4. **Sales Dashboard** icon — waveform/trend icon
5. Divider
6. **Admin** icon — settings/gear icon

Active icon: `rgba(120,196,26,0.2)` background + green dot indicator.  
Hovering shows a tooltip label to the right of the sidebar.

### Sub-navigation (in top bar)
Each dashboard has pill-style sub-tabs in the top bar:
- **WIP:** `Daily Trends` | `Weekly Snapshot`
- **Sales:** `Daily` | `Weekly` | `Monthly`

Active sub-tab: `#78C41A` background, white text.

---

## 4. WIP Dashboard

### 4a. Daily Trends Sub-view

**Purpose:** Build a running trend of WIP metrics over time. Each time the admin saves a WIP snapshot, that day's numbers are appended to the history and the trend chart updates.

**Hero stats:** Total Open ROs · Total Sale Orders w/o Invoices · Total Warranties — each with delta vs previous entry.

**KPI Strip (7 cards, horizontal row):**  
Each card has a `2px evs-green` top border (red if the metric is a "lower is better" metric trending up). Shows current total across all branches + delta arrow vs previous entry.

| # | Field | Key | Lower is better |
|---|---|---|---|
| 1 | Sale Orders / Quotations without Invoices | `saleOrdersToInvoice` | ✓ |
| 2 | Open Repair Orders | `openRepairOrders` | ✓ |
| 3 | Warranties Activated | `warrantiesActivated` | ✗ |
| 4 | ROs Completed Without Quotations | `rosWithoutQuotations` | ✓ |
| 5 | ROs Without Tags | `rosWithoutTags` | ✓ |
| 6 | Quotations Not Approved | `quotationsNotApproved` | ✓ |
| 7 | Repair Orders With No Invoices | `rosWithoutInvoices` | ✓ |

**Trend Chart panel (left, wider):**
- Line chart of the selected metric over time (total across all branches)
- X-axis = date of each admin WIP entry; Y-axis = value
- Filled area gradient below line
- Metric selector dropdown to switch between the 7 fields
- Starts empty on first use; builds up daily

**Branch Breakdown panel (right):**
- 6 mini-cards (2×3 grid), one per branch
- Shows current value of the selected metric for that branch
- Improving/Rising/Stable indicator based on delta vs previous entry
- Left border: green = improving or stable, red = worsening

### 4b. Weekly Snapshot Sub-view

**Purpose:** Show last week's WIP numbers per branch, compared to the prior week.

**KPI Strip:** Same 7 metrics, but delta shows vs previous week's snapshot.

**Full metrics table:**
- Rows = 6 branches; Columns = 7 WIP metrics
- Red text + ↑ if metric is worse than prior week; green text + ↓ if better
- Totals row at bottom
- Includes the new `rosWithoutInvoices` field

---

## 5. Sales Dashboard

All three sub-views (Daily, Weekly, Monthly) use the same layout — only the time window changes.

**Hero stats:** Total actual AED · % of target achieved · shortfall/surplus amount

**Left panel — Branch Bars:**
- One row per branch: branch name + two stacked horizontal bars (actual = green, target = grey)
- % label to the right (green if ≥100%, red if <100%)
- Branches sorted by achievement % descending

**Right panel — Summary Table:**
- Columns: Branch · Actual · Target · Ach % · Variance
- Totals row with bold styling + progress bar underneath showing overall % of target
- Variance: `+AED x` in green if over, `-AED x` in red if under

**Time windows:**
- **Daily:** Yesterday's actual vs daily target (monthly target ÷ working days)
- **Weekly:** Current week's cumulative actual vs weekly target (daily target × 7)
- **Monthly:** Month-to-date actual vs monthly target

---

## 6. Data Architecture Changes

### New WIP metric field
Add `rosWithoutInvoices` to the WIP schema alongside the existing 6 fields. This applies to both `WeeklySnapshot.values` and the new daily WIP history.

### New: Daily WIP History
Add a `wipHistory` array to `data.json` for storing daily WIP snapshots:

```ts
// The 7 WIP metric keys used across both dashboards:
export const WIP_METRICS = [
  'saleOrdersToInvoice',
  'openRepairOrders',
  'warrantiesActivated',
  'rosWithoutQuotations',
  'rosWithoutTags',
  'quotationsNotApproved',
  'rosWithoutInvoices',   // NEW — not in existing WeeklyMetricKey
] as const;
export type WipMetricKey = typeof WIP_METRICS[number];

// Note: existing WeeklyMetricKey also includes 'totalRepairOrders' and
// 'totalInvoicedSales' — those are NOT part of the WIP dashboard views.

interface WipDailyEntry {
  date: string;           // ISO date: "2026-04-11"
  values: BranchValues<WipMetricKey>;
}

// Added to ReportData:
wipHistory: WipDailyEntry[];
```

Each admin WIP save appends a new `WipDailyEntry`. The Daily Trends chart reads this array. The same save also updates `weekly.current` / `weekly.previous` so the Weekly Snapshot view stays in sync — the admin does not need two separate weekly saves.

### Chart library
Use **Recharts** (already a common Next.js/React choice; add as a dependency). `TrendChart` uses `<LineChart>` with `<Area>` fill. No other charting library should be introduced.

### Sales data
No schema changes needed. The existing `regional.salesLog` (date + branch + actualSales) and `regional.branchConfig` (monthlyTarget + daysInMonth) already support all three time windows.

### Weekly WIP (existing)
`weekly.current` and `weekly.previous` are updated on each WIP save (same as today). `weekly.history` accumulates past snapshots. These power the Weekly Snapshot view.

---

## 7. Admin Panel

The admin panel is split into two clearly labelled sections:

### WIP Snapshot Entry
- Date field (auto-filled to today, editable)
- 7 metric fields × 6 branches = 42 inputs, grouped by metric with branch columns
- "Save WIP Snapshot" button — appends to `wipHistory` and updates `weekly.current`/`previous`
- Confirmation: shows how many data points are now in the trend

### Sales Log Entry
- Date field
- 6 branch rows with actual sales input
- Notes field per branch (optional)
- "Save Sales Entry" button — appends to `regional.salesLog`

The existing admin form is replaced entirely with this two-section layout within the new shell.

---

## 8. Authentication & Access

No changes. Single shared password via `SITE_PASSWORD` env var, middleware-enforced. All pages remain gated.

---

## 9. Pages / Routes

| Route | Description |
|---|---|
| `/` | Redirect to `/wip/daily` (no more landing page) |
| `/wip/daily` | WIP Dashboard — Daily Trends |
| `/wip/weekly` | WIP Dashboard — Weekly Snapshot |
| `/sales/daily` | Sales Dashboard — Daily |
| `/sales/weekly` | Sales Dashboard — Weekly |
| `/sales/monthly` | Sales Dashboard — Monthly |
| `/admin` | Admin data entry |
| `/login` | Login page (unchanged) |

Old routes (`/weekly`, `/daily`, `/sales`, `/regional`) are removed.

---

## 10. Components to Build / Refactor

| Component | Status | Notes |
|---|---|---|
| `Shell` (sidebar + topbar) | New | Wraps all authenticated pages |
| `Sidebar` | New | Dark, EVS logo, icon nav with tooltips |
| `HeroBanner` | New | Dark green gradient, page title + aggregate stats |
| `KpiStrip` | Refactor from `Kpi` | 7-card horizontal strip, green/red top border |
| `TrendChart` | New | Line chart with filled gradient, metric selector |
| `BranchBreakdownGrid` | New | 6 mini-cards with improving/worsening indicator |
| `MetricsTable` | Refactor from table in weekly/daily pages | Branch rows × metric columns |
| `SalesBars` | New | Actual vs target horizontal bar per branch |
| `SalesSummaryTable` | Refactor from `SummaryTable` | + progress bar footer |
| `AdminWipForm` | New | 7 metrics × 6 branches grid |
| `AdminSalesForm` | Refactor | Same logic, new shell |
| `Nav` | Replace | Sidebar replaces top nav entirely |

---

## 11. Out of Scope

- PDF/export functionality
- Push notifications or email alerts
- Multi-user accounts or roles
- Historical WIP import (trend starts from first admin entry going forward)
- Mobile-optimised layout (desktop-first, responsive is acceptable but not primary)
