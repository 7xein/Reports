export const BRANCHES = ['Dubai', 'Ajman', 'Sharjah', 'Abu Dhabi', 'Al Ain', 'Qatar'] as const;
export type Branch = typeof BRANCHES[number];

// ── Sub-branches ──────────────────────────────────────────────────────────
// Branches that operate multiple service locations. Omitted branches stay
// single-location. Keys for stored sub-values use the form `${branch}__${sub}`.
export const SUB_BRANCHES: Record<string, string[]> = {
  'Dubai':     ['Main branch', 'Emarat - Albuhaira', 'Emarat - Mahrawan'],
  'Sharjah':   ['Main branch', 'Emarat - Muwafja'],
  'Abu Dhabi': ['Main branch', 'Al Masaood'],
};
export const getSubBranches = (b: string): string[] => SUB_BRANCHES[b] ?? [];
export const hasSubBranches = (b: string): boolean => (SUB_BRANCHES[b]?.length ?? 0) > 0;
export const subKey = (branch: string, sub: string): string => `${branch}__${sub}`;

// ── WIP metrics (7 fields shown in both WIP dashboard views) ──────────────
export const WIP_METRICS = [
  { key: 'saleOrdersToInvoice',  label: 'Sale Orders / Quotations Without Invoices', short: 'SOs to Invoice', lowerIsBetter: true,  isCurrency: false, description: 'Confirmed sale orders / quotations that still have no invoice generated — billed work not yet invoiced.' },
  { key: 'openRepairOrders',     label: 'Open Repair Orders',                         short: 'Open ROs',       lowerIsBetter: true,  isCurrency: false, description: 'Repair orders currently in progress — not cancelled and not yet completed.' },
  { key: 'warrantiesActivated',  label: 'Warranties Activated',                       short: 'Warranties',     lowerIsBetter: false, isCurrency: false, description: 'Warranties activated in the period. Higher is better.' },
  { key: 'rosWithoutQuotations', label: 'ROs Completed Without Quotations',           short: 'No Quotes',      lowerIsBetter: true,  isCurrency: false, description: 'Repair orders marked done but closed without a linked quotation / sale order.' },
  { key: 'rosWithoutTags',       label: 'ROs Without Tags',                           short: 'No Tags',        lowerIsBetter: true,  isCurrency: false, description: 'Active repair orders with no tags assigned.' },
  { key: 'quotationsNotApproved',label: 'Quotations Not Approved',                    short: 'Pend. Appr.',    lowerIsBetter: true,  isCurrency: false, description: 'Draft quotations / sale orders still awaiting approval.' },
  { key: 'rosWithoutInvoices',   label: 'Repair Orders With No Invoices',             short: 'No Invoices',    lowerIsBetter: true,  isCurrency: false, description: 'Repair orders not yet invoiced & closed (priority-matrix status is not "Invoiced & Closed", and not tagged Cancel).' },
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

// Per-sub-branch WIP numbers. Keys are `${branch}__${sub}` (see subKey()).
// Optional & additive: legacy / Odoo-synced snapshots simply omit it, and
// `values[metric][branch]` always stays the authoritative branch total.
export type WipSubValues = Record<WipMetricKey, Record<string, number>>;

// ── New: daily WIP history entry — cumulative totals since July, updated daily
export interface WipDailyEntry {
  date: string;                        // ISO date "2026-04-11"
  values: BranchValues<WipMetricKey>;  // branch totals (authoritative)
  subValues?: WipSubValues;            // optional per-sub-branch detail
}

// ── New: weekly WIP entry — this week's counts only (not cumulative), entered Thursday
export interface WipWeeklyEntry {
  weekEnding: string;                  // ISO date of the Thursday "2026-04-10"
  values: BranchValues<WipMetricKey>;  // branch totals (authoritative)
  subValues?: WipSubValues;            // optional per-sub-branch detail
}

export interface RegionalSalesEntry {
  date: string;
  branch: string;
  actualSales: number;            // TOTAL sales (authoritative overall)
  salesWithoutWarranty?: number;  // optional: portion of total that is without warranty
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

// ── KPI section ───────────────────────────────────────────────────────────
export const KPI_DEFINITIONS = [
  { id: 1, name: 'Invoice on delivery',      rule: 'An invoice must be raised by the time the vehicle is handed over.' },
  { id: 2, name: 'Quote approval ≤ 7 days',  rule: 'Quotations must not sit awaiting approval for more than 7 days.' },
  { id: 3, name: 'SO before repaired',       rule: 'A sale order must exist by the time a vehicle reaches the repaired stage.' },
  { id: 4, name: 'Quote before starting repair', rule: 'A quotation must exist before repair work starts.' },
  { id: 5, name: 'Tag within 1 hour',        rule: 'A tag must be added to every RO within 1 hour of creation.' },
  { id: 6, name: 'Awaiting parts ≤ 14 days', rule: 'An RO cannot await parts for more than 14 days.' },
  { id: 7, name: 'Awaiting labour ≤ 2 days', rule: 'A vehicle cannot await labour for more than 2 days.' },
] as const;
export type KpiId = typeof KPI_DEFINITIONS[number]['id'];

/** KPIs 6 & 7 are point-in-time (current state), so they ignore the week window. */
export const SNAPSHOT_KPI_IDS: number[] = [6, 7];

/**
 * How a workflow state is identified on repair.order. This Odoo instance keeps
 * its workflow in `priority_matrix_status` (stage_id is unused), but stage/tag
 * are supported so the mapping stays configurable.
 */
export type StageSelectorKind = 'priority' | 'state' | 'stage' | 'tag';
export interface StageSelector {
  kind: StageSelectorKind;
  values: (string | number)[];
}

export interface SaRosterEntry {
  odooUserId: number;
  name: string;
  branch: string;
}

export interface KpiConfig {
  weekStartDay: number;                 // 6 = Saturday
  thresholds: {
    quoteApprovalDays: number;
    tagMinutes: number;
    awaitingPartsDays: number;
    awaitingLabourDays: number;
    /** Grace after a vehicle reaches delivery before "Invoice on delivery" judges it. */
    invoiceGraceMinutes?: number;
  };
  stageMap: {
    repaired: StageSelector;
    underRepair: StageSelector;
    awaitingParts: StageSelector;
    awaitingLabour: StageSelector;
  };
  saRoster: SaRosterEntry[];
  enabledKpis: number[];
  /**
   * Which date KPIs 6 & 7 measure "time in state" from.
   *  auto        → date_last_stage_update if the field exists, else create_date
   *  create_date → age of the RO itself (never hides a stale vehicle)
   *  write_date  → last modified (WARNING: any edit resets the clock)
   */
  ageBasis?: 'auto' | 'date_last_stage_update' | 'create_date' | 'write_date';
  /** Set on save — part of the KPI cache key so config edits take effect immediately. */
  updatedAt?: string;
}

/** Safe defaults, using the priority-matrix codes this instance actually uses. */
export const DEFAULT_KPI_CONFIG: KpiConfig = {
  weekStartDay: 6,
  thresholds: { quoteApprovalDays: 7, tagMinutes: 60, awaitingPartsDays: 14, awaitingLabourDays: 2, invoiceGraceMinutes: 10 },
  stageMap: {
    repaired:       { kind: 'priority', values: ['C', 'G', 'D'] },  // Labour Complete / QC Complete / Vehicle Ready
    underRepair:    { kind: 'state',    values: ['under_repair'] }, // repair.order state
    awaitingParts:  { kind: 'priority', values: ['P'] },            // Awaiting Parts
    awaitingLabour: { kind: 'priority', values: ['I'] },            // Awaiting Labour
  },
  saRoster: [],
  enabledKpis: [1, 2, 3, 4, 5, 6, 7],
  ageBasis: 'auto',
};

/** Merge a stored (possibly partial/legacy) config over the defaults. */
export function withKpiDefaults(cfg?: Partial<KpiConfig> | null): KpiConfig {
  if (!cfg) return DEFAULT_KPI_CONFIG;
  return {
    ...DEFAULT_KPI_CONFIG,
    ...cfg,
    thresholds: { ...DEFAULT_KPI_CONFIG.thresholds, ...(cfg.thresholds ?? {}) },
    stageMap:   { ...DEFAULT_KPI_CONFIG.stageMap,   ...(cfg.stageMap ?? {}) },
    saRoster:   cfg.saRoster ?? DEFAULT_KPI_CONFIG.saRoster,
    enabledKpis: cfg.enabledKpis ?? DEFAULT_KPI_CONFIG.enabledKpis,
  };
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
  wipHistory: WipDailyEntry[];         // cumulative daily snapshots (trend chart)
  wipWeeklyHistory: WipWeeklyEntry[];  // week-only counts entered every Thursday
  kpiConfig?: KpiConfig;               // optional — falls back to DEFAULT_KPI_CONFIG
}
