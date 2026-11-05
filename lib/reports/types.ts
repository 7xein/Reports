/**
 * The shared contract every EVHUB report speaks.
 *
 * Each report returns the same shape — columns, rows, summary tiles, notes — so
 * one table component renders all of them and one exporter turns any of them
 * into a workbook. A new report is a new query, not a new page.
 */

import type { OdooDomain } from '../odoo';
import { parseScope, stationCompany } from '../types';

export type ReportSlug =
  | 'no-rfq' | 'rfq-to-po' | 'po-to-receipt' | 'open-parts' | 'cost'
  | 'attention' | 'open-jobs' | 'not-invoiced' | 'unposted';

/**
 * How a column's values are typed and displayed.
 *  text     free text
 *  number   plain count or quantity
 *  days     elapsed days, one decimal
 *  date     'YYYY-MM-DD' in Gulf time
 *  currency AED amount, two decimals (the label carries the unit)
 *  percent  a change or share in percent points, may be negative
 *  badge    short status label, coloured via `badgeTones`
 *  link     the value is the display text; the absolute URL lives under a
 *           different row key, named by the column's `hrefKey`. A row missing
 *           that key renders as plain text, so a link that cannot be built
 *           costs a hyperlink, not a cell.
 */
export type ColumnKind = 'text' | 'number' | 'days' | 'date' | 'currency' | 'percent' | 'badge' | 'link';

export interface ReportColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  /** For number/percent columns that read as better or worse: colours positive values. */
  trend?: 'up-good' | 'up-bad';
  /** `link` columns only: the row key holding the URL. Not a column itself, so it never renders as its own cell. */
  hrefKey?: string;
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export type CellValue = string | number | null;

export type ReportRow = Record<string, CellValue>;

export interface ReportSummaryItem {
  label: string;
  value: string;
  tone?: Tone;
  hint?: string;
}

/** Every branch-scoped report keeps the branch name under this row key. */
export const BRANCH_KEY = 'branch';

export interface ReportResult {
  slug: ReportSlug;
  title: string;
  description: string;
  /** ISO timestamp of when the report was computed. */
  generatedAt: string;
  /** Lookback in days, or null for a point-in-time backlog or a fixed window. */
  windowDays: number | null;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** True when rows carry BRANCH_KEY and SITE_KEY and the UI should offer the branch picker. */
  branchScoped: boolean;
  /**
   * Scope applied to `rows` and `summary`: 'all', a branch, or a station key
   * `${branch}__${station}` (lib/types.ts subKey). The JSON endpoint always
   * answers 'all' and lets the page filter; the Excel export applies its scope.
   */
  scope: string;
  /** The branches this report covers (REPORTS[].branchSet), rows or not — the picker's pills. [] when not branch-scoped. */
  branches: string[];
  /** Badge column key → value → tone. */
  badgeTones?: Record<string, Record<string, Tone>>;
  /** Summary tiles for `scope`. */
  summary: ReportSummaryItem[];
  /**
   * Summary tiles for every scope the picker can reach — 'all', each branch in
   * `branches`, and each station of those branches — so switching scope on the
   * page needs no request. Only 'all' when not branch-scoped.
   */
  summaries: Record<string, ReportSummaryItem[]>;
  /** Plain-language caveats: what was skipped, approximated, or could not be read. */
  notes: string[];
}

/** What a report module builds; the registry adds the rest. */
export type ReportBuild = Omit<ReportResult, 'generatedAt' | 'scope' | 'branches' | 'summary' | 'summaries'>;

/** Every branch-scoped report keeps the Odoo company name (BRANCH_CLUSTERS spelling) under this row key. */
export const SITE_KEY = 'site';

/**
 * Whether a row falls in a picker scope. A station scope matches on the row's
 * company, through the same station → company map the WIP page uses, so a
 * station means the same records on both pages. Safe on the client.
 */
export function rowInScope(row: ReportRow, scope: string): boolean {
  if (scope === 'all') return true;
  const { branch, sub } = parseScope(scope);
  if (row[BRANCH_KEY] !== branch) return false;
  if (!sub) return true;
  const company = branch ? stationCompany(branch, sub) : null;
  return company != null && row[SITE_KEY] === company;
}

export interface ReportParams {
  /** Lookback in days for windowed reports; ignored by the others. */
  days: number;
  thresholds: {
    rfqAfterApprovalDays: number;
    rfqConfirmDays: number;
    partsPlacedDays: number;
  };
  /**
   * repair.order domain clause selecting OPEN orders, built from the KPI
   * config's "closed" stage selector — so "open" means exactly what it means on
   * the KPI page. Does NOT include the historical or company filters.
   */
  openRoDomain: OdooDomain;
}

export interface ReportModule {
  /** Reads Odoo and returns every row for every branch. Degrades to a note rather than throwing for a missing field. */
  build(params: ReportParams): Promise<ReportBuild>;
  /** Summary tiles for a set of rows — called on the full rows and again on a branch's rows. */
  summarise(rows: ReportRow[], params: ReportParams): ReportSummaryItem[];
}

export type ReportSection = 'evhub' | 'ceo';

export interface ReportMeta {
  slug: ReportSlug;
  /** Which password-gated section owns the report: its page, its API prefix, and who may read it. */
  section: ReportSection;
  /** Sub-tab label. */
  label: string;
  /** True when the report honours `days` and the UI should offer WINDOW_OPTIONS. */
  windowed: boolean;
  /** Which branches the picker offers: workshops only (repair-order reports) or every branch incl. EV Hub (purchase reports). */
  branchSet: 'workshop' | 'all';
  hero: { title: string; titleEm: string; sub: string };
}

/** Display order, which is also the sub-tab order. */
export const REPORTS: readonly ReportMeta[] = [
  {
    slug: 'no-rfq', section: 'evhub', label: 'Parts without RFQ', windowed: false, branchSet: 'workshop',
    hero: { title: 'Parts', titleEm: 'without an RFQ', sub: 'Open repair orders that are short of parts while no RFQ has been raised for the vehicle.' },
  },
  {
    slug: 'rfq-to-po', section: 'evhub', label: 'RFQ → PO', windowed: true, branchSet: 'all',
    hero: { title: 'RFQ to', titleEm: 'purchase order', sub: 'How long each RFQ took to be confirmed into a purchase order, and which are still waiting.' },
  },
  {
    slug: 'po-to-receipt', section: 'evhub', label: 'PO → Received', windowed: true, branchSet: 'all',
    hero: { title: 'Purchase order to', titleEm: 'parts received', sub: 'How long confirmed purchase orders took to arrive in the branch stock, and which are still on the way.' },
  },
  {
    slug: 'open-parts', section: 'evhub', label: 'Open parts', windowed: false, branchSet: 'workshop',
    hero: { title: 'Open parts', titleEm: 'and why', sub: 'Every part still short on an open repair order, with where it is stuck in the purchasing chain.' },
  },
  {
    slug: 'cost', section: 'evhub', label: 'Cost analysis', windowed: false, branchSet: 'all',
    hero: { title: 'EV Hub', titleEm: 'parts cost', sub: 'What EV Hub paid per unit for each part, month by month over the last 12 months.' },
  },
  {
    // 'all', not 'workshop': the page carries unposted invoices as well as
    // jobs, and EV Hub raises customer invoices even though it has no workshop.
    // Under 'workshop' its rows would show only under "All Branches" and be
    // unreachable by the picker, so its money would belong to no branch at all.
    slug: 'attention', section: 'ceo', label: 'Needs attention', windowed: false, branchSet: 'all',
    hero: { title: 'Needs', titleEm: 'your attention', sub: 'Every open exception across the branches, worst first, with the money at risk.' },
  },
  {
    slug: 'open-jobs', section: 'ceo', label: 'Oldest open jobs', windowed: false, branchSet: 'workshop',
    hero: { title: 'Oldest', titleEm: 'open jobs', sub: 'Every open repair order by age, with how long it has sat in its current status.' },
  },
  {
    slug: 'not-invoiced', section: 'ceo', label: 'Not invoiced', windowed: false, branchSet: 'workshop',
    hero: { title: 'Repaired,', titleEm: 'not invoiced', sub: 'Work finished and not billed — the value sitting on the workshop floor.' },
  },
  {
    slug: 'unposted', section: 'ceo', label: 'Unposted invoices', windowed: false, branchSet: 'all',
    hero: { title: 'Invoices', titleEm: 'never posted', sub: 'Customer invoices raised but left in draft, so the revenue is never booked.' },
  },
];

export const WINDOW_OPTIONS = [30, 60, 90] as const;
export const DEFAULT_WINDOW_DAYS = 30;

export const isReportSlug = (s: string): s is ReportSlug => REPORTS.some((r) => r.slug === s);
export const reportMeta = (slug: ReportSlug): ReportMeta => REPORTS.find((r) => r.slug === slug)!;

/** One section's reports, in display order — its sub-tabs and the only slugs it may prefetch. */
export const reportsFor = (section: ReportSection): readonly ReportMeta[] =>
  REPORTS.filter((r) => r.section === section);

export const reportSection = (slug: ReportSlug): ReportSection => reportMeta(slug).section;
