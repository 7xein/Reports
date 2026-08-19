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
// Display order: per-job compliance first, then the "sitting too long" rules.
// `id` values are stable (they're stored in config) — only the order changes.
// Names here are threshold-free fallbacks — kpiDisplayName() builds the label
// shown in the UI from the configured thresholds, so they can never drift.
export const KPI_DEFINITIONS = [
  { id: 1, name: 'Invoice on delivery',      rule: 'An invoice must be raised by the time the vehicle is handed over.' },
  { id: 11, name: 'Delivered after repair',  rule: 'Once repaired, a vehicle must be delivered within the configured time — not left sitting on the lot.' },
  { id: 13, name: 'Customer follow-up',     rule: 'A customer follow-up must be recorded (follow-up screenshot uploaded) after the vehicle is delivered.' },
  { id: 3, name: 'SO before repaired',       rule: 'A sale order must exist by the time a vehicle reaches the repaired stage.' },
  { id: 12, name: 'Quote after RO',          rule: 'A quotation must be raised within the configured time of the repair order being created.' },
  { id: 4, name: 'Quote before starting repair', rule: 'A quotation must exist before repair work starts.' },
  { id: 5, name: 'Tag on creation',          rule: 'A tag must be added to every RO within the configured time of creation.' },
  { id: 8, name: 'Car in / out tag',         rule: 'Every RO must carry a CAR-IN or CAR-OUT tag showing whether the vehicle is on site.' },
  { id: 2, name: 'Quote approval',           rule: 'Quotations must not sit awaiting approval beyond the configured time.' },
  { id: 9, name: 'Weekly closure rate',      rule: 'Repair orders received this week should be closed this week (closed ÷ received).' },
  { id: 6, name: 'Awaiting parts',           rule: 'An open RO with parts still outstanding (Done qty below Demand) cannot wait beyond the configured time.' },
  { id: 7, name: 'Awaiting labour',          rule: 'A vehicle cannot await labour beyond the configured time.' },
] as const;
export type KpiId = typeof KPI_DEFINITIONS[number]['id'];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "60" → "1 hour", "90" → "90 minutes". */
function minutesLabel(mins: number): string {
  return mins > 0 && mins % 60 === 0 ? plural(mins / 60, 'hour') : plural(mins, 'minute');
}

/** KPI label with its configured threshold baked in, e.g. "Delivered in 2 days after repair". */
export function kpiDisplayName(id: number, fallback: string, t: KpiConfig['thresholds']): string {
  const days = (n: number) => plural(n, 'day');
  switch (id) {
    case 2:  return `Quote approval ≤ ${days(t.quoteApprovalDays ?? 7)}`;
    case 5:  return `Tag within ${minutesLabel(t.tagMinutes ?? 60)}`;
    case 6:  return `Awaiting parts ≤ ${days(t.awaitingPartsDays ?? 14)}`;
    case 7:  return `Awaiting labour ≤ ${days(t.awaitingLabourDays ?? 2)}`;
    case 11: return `Delivered in ${days(t.repairedToDeliveredDays ?? 2)} after repair`;
    case 12: return `Quote within ${days(t.quoteWithinDays ?? 1)} of RO`;
    default: return fallback;
  }
}

/** Point-in-time KPIs (current state), so they ignore the week window. */
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
    /** Window KPIs 6, 7 & 9 measure against — all ROs created in the last N days. */
    snapshotBaselineDays?: number;
    /** Max days between a vehicle being repaired and delivered (KPI 11). */
    repairedToDeliveredDays?: number;
    /** Max days between RO creation and the quotation being raised (KPI 12). */
    quoteWithinDays?: number;
    /** Grace after delivery before the follow-up KPI judges an RO. */
    followUpGraceDays?: number;
  };
  stageMap: {
    repaired: StageSelector;
    underRepair: StageSelector;
    awaitingParts: StageSelector;
    awaitingLabour: StageSelector;
    /** Tags that mark a vehicle as on/off site (CAR-IN / CAR-OUT). Leave empty
     *  to auto-detect tags named like "CAR IN" / "CAR-OUT". */
    presenceTags: StageSelector;
    /** States that count as CLOSED. Anything else is an open RO (KPI 9). */
    closed: StageSelector;
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
  /**
   * How "Awaiting parts" decides a vehicle is held up:
   *  parts → open RO with a parts line whose Done qty is below Demand
   *  state → the mapped "Awaiting parts" state (e.g. priority matrix P)
   */
  awaitingPartsSource?: 'parts' | 'state';
  /** Set on save — part of the KPI cache key so config edits take effect immediately. */
  updatedAt?: string;
}

/** Safe defaults, using the priority-matrix codes this instance actually uses. */
export const DEFAULT_KPI_CONFIG: KpiConfig = {
  weekStartDay: 6,
  thresholds: { quoteApprovalDays: 7, tagMinutes: 60, awaitingPartsDays: 14, awaitingLabourDays: 2, invoiceGraceMinutes: 10, snapshotBaselineDays: 90, repairedToDeliveredDays: 2, quoteWithinDays: 1, followUpGraceDays: 1 },
  stageMap: {
    repaired:       { kind: 'priority', values: ['C', 'G', 'D'] },  // Labour Complete / QC Complete / Vehicle Ready
    underRepair:    { kind: 'state',    values: ['under_repair'] }, // repair.order state
    awaitingParts:  { kind: 'priority', values: ['P'] },            // Awaiting Parts
    awaitingLabour: { kind: 'priority', values: ['I'] },            // Awaiting Labour
    presenceTags:   { kind: 'tag',      values: [] },               // empty → auto-detect CAR-IN / CAR-OUT
    closed:         { kind: 'priority', values: ['X'] },            // Closed and Invoiced
  },
  saRoster: [],
  enabledKpis: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13],
  ageBasis: 'auto',
  awaitingPartsSource: 'parts',
};

/**
 * KPI ids only ever increase, so any id above the highest stored one is a KPI
 * that didn't exist when the config was saved — enable it rather than leaving a
 * new KPI silently switched off. Deliberate opt-outs of existing KPIs survive.
 */
function mergeEnabledKpis(stored?: number[]): number[] {
  if (!stored?.length) return DEFAULT_KPI_CONFIG.enabledKpis;
  const highest = Math.max(...stored);
  const added = KPI_DEFINITIONS.map((d) => d.id as number).filter((id) => id > highest);
  return [...new Set([...stored, ...added])];
}

/** Merge a stored (possibly partial/legacy) config over the defaults. */
export function withKpiDefaults(cfg?: Partial<KpiConfig> | null): KpiConfig {
  if (!cfg) return DEFAULT_KPI_CONFIG;
  return {
    ...DEFAULT_KPI_CONFIG,
    ...cfg,
    thresholds: { ...DEFAULT_KPI_CONFIG.thresholds, ...(cfg.thresholds ?? {}) },
    stageMap:   { ...DEFAULT_KPI_CONFIG.stageMap,   ...(cfg.stageMap ?? {}) },
    saRoster:   cfg.saRoster ?? DEFAULT_KPI_CONFIG.saRoster,
    enabledKpis: mergeEnabledKpis(cfg.enabledKpis),
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
