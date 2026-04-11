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
