/**
 * Odoo JSON-RPC client for EVS WIP report data extraction.
 *
 * Authenticates via API key and runs read_group / search_count queries
 * that mirror the 7 saved-filter definitions used in the Odoo UI.
 *
 * Environment variables (set in Vercel):
 *   ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY
 */

import type { WipMetricKey, Branch } from './types';
import { BRANCHES, subKey } from './types';

// ── Env ────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name} — add it in Vercel Dashboard → Settings → Environment Variables, then redeploy.`);
  return val;
}

const ODOO_URL     = () => requireEnv('ODOO_URL');
const ODOO_DB      = () => requireEnv('ODOO_DB');
const ODOO_LOGIN   = () => requireEnv('ODOO_LOGIN');
const ODOO_API_KEY = () => requireEnv('ODOO_API_KEY');

// ── Branch consolidation rules ─────────────────────────────────────
// Order matches BRANCHES constant: Dubai, Ajman, Sharjah, Abu Dhabi, Al Ain, Qatar
export const BRANCH_CLUSTERS: Record<Branch, string[]> = {
  'Dubai':     ['EVS Dubai', 'Emarat - Mahrawan', 'Emarat - Albuhaira'],
  'Ajman':     ['EVS ELECTRIC VEHICLE SERVICE AJ'],
  'Sharjah':   ['EVS ELECTRIC VEHICLE SERVICE SHARJAH', 'Emarat - Muwafja'],
  'Abu Dhabi': ['EVS ELECTRIC VEHICLE SERVICE ABU DHABI', 'Al Masaood'],
  'Al Ain':    ['EVS ELECTRIC VEHICLE SERVICE AL AIN'],
  'Qatar':     ['EVS ELECTRIC VEHICLE SERVICE QATAR'],
};

const ALL_TRACKED_COMPANIES = Object.values(BRANCH_CLUSTERS).flat();

// ── Sub-branch → Odoo company mapping ──────────────────────────────
// Each dashboard sub-branch corresponds to exactly one Odoo company.
// Keys/labels mirror SUB_BRANCHES in lib/types.ts.
const SUB_BRANCH_COMPANY: Record<string, Record<string, string>> = {
  'Dubai': {
    'Main branch':        'EVS Dubai',
    'Emarat - Albuhaira': 'Emarat - Albuhaira',
    'Emarat - Mahrawan':  'Emarat - Mahrawan',
  },
  'Sharjah': {
    'Main branch':        'EVS ELECTRIC VEHICLE SERVICE SHARJAH',
    'Emarat - Muwafja':   'Emarat - Muwafja',
  },
  'Abu Dhabi': {
    'Main branch':        'EVS ELECTRIC VEHICLE SERVICE ABU DHABI',
    'Al Masaood':         'Al Masaood',
  },
};

// ── Types ──────────────────────────────────────────────────────────
type OdooDomain = (string | [string, string, unknown])[];

interface ReadGroupResult {
  company_id?: [number, string];
  company_id_count?: number;
  __count?: number;
  [key: string]: unknown;
}

// ── JSON-RPC transport ─────────────────────────────────────────────
let cachedUid: number | null = null;

async function jsonRpc(url: string, method: string, params: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const json = await res.json();
  if (json.error) {
    const msg = json.error.data?.message || json.error.message || JSON.stringify(json.error);
    throw new Error(`Odoo RPC error: ${msg}`);
  }
  return json.result;
}

async function authenticate(): Promise<number> {
  if (cachedUid) return cachedUid;
  const uid = await jsonRpc(`${ODOO_URL()}/jsonrpc`, 'call', {
    service: 'common',
    method: 'authenticate',
    args: [ODOO_DB(), ODOO_LOGIN(), ODOO_API_KEY(), {}],
  });
  if (!uid || typeof uid !== 'number') {
    throw new Error('Odoo authentication failed — check credentials or API key expiry');
  }
  cachedUid = uid;
  return uid;
}

async function call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await authenticate();
  return jsonRpc(`${ODOO_URL()}/jsonrpc`, 'call', {
    service: 'object',
    method: 'execute_kw',
    args: [ODOO_DB(), uid, ODOO_API_KEY(), model, method, args, kwargs],
  });
}

// ── Helpers ────────────────────────────────────────────────────────
let companyIdCache: Record<string, number> | null = null;

async function getCompanyIds(): Promise<Record<string, number>> {
  if (companyIdCache) return companyIdCache;
  // Use search_read to get the actual 'name' field (not display_name from name_search)
  const companies: { id: number; name: string }[] = await call('res.company', 'search_read', [[]], {
    fields: ['name'],
    limit: 200,
  });
  companyIdCache = {};
  for (const c of companies) companyIdCache[c.name] = c.id;
  return companyIdCache;
}

async function branchCompanyIds(branch: Branch): Promise<number[]> {
  const map = await getCompanyIds();
  return (BRANCH_CLUSTERS[branch] || [])
    .map((n) => { const id = map[n]; if (!id) console.warn(`⚠ Company "${n}" not found in Odoo`); return id; })
    .filter(Boolean);
}

async function allTrackedCompanyIds(): Promise<number[]> {
  const map = await getCompanyIds();
  return ALL_TRACKED_COMPANIES.map((n) => map[n]).filter(Boolean);
}

/** Reverse of getCompanyIds: company id → name. */
async function companyNameById(): Promise<Record<number, string>> {
  const map = await getCompanyIds();
  const out: Record<number, string> = {};
  for (const [name, id] of Object.entries(map)) out[id] = name;
  return out;
}

/** Per-company counts (keyed by company NAME) via a single read_group. */
async function groupCountByCompany(model: string, domain: OdooDomain): Promise<Record<string, number>> {
  const trackedIds = await allTrackedCompanyIds();
  const fullDomain: OdooDomain = [...domain, ['company_id', 'in', trackedIds]];
  const groups: ReadGroupResult[] = await call(model, 'read_group', [fullDomain], {
    fields: ['company_id'],
    groupby: ['company_id'],
    lazy: true,
  });
  const idToName = await companyNameById();
  const out: Record<string, number> = {};
  for (const g of groups) {
    const cid = g.company_id?.[0];
    const count = (g.company_id_count ?? g.__count ?? 0) as number;
    if (cid && idToName[cid]) out[idToName[cid]] = count;
  }
  return out;
}

/** Per-company counts (keyed by company NAME) via one search_count per company.
 *  Use when read_group miscounts (e.g. many2many tag_ids filters). */
async function searchCountByCompany(model: string, domain: OdooDomain): Promise<Record<string, number>> {
  const map = await getCompanyIds();
  const out: Record<string, number> = {};
  for (const name of ALL_TRACKED_COMPANIES) {
    const id = map[name];
    if (!id) { out[name] = 0; continue; }
    out[name] = await call(model, 'search_count', [[...domain, ['company_id', '=', id]]]);
  }
  return out;
}

/** Warranties activated per company — tries write_uid.company_id, falls back to company_id. */
async function warrantiesByCompany(extra: OdooDomain = []): Promise<Record<string, number>> {
  const map = await getCompanyIds();
  const out: Record<string, number> = {};
  for (const name of ALL_TRACKED_COMPANIES) {
    const id = map[name];
    if (!id) { out[name] = 0; continue; }
    try {
      out[name] = await call('fleet.warranty', 'search_count', [[
        ['state', '=', 'activated'], ['write_uid.company_id', 'in', [id]], ...extra,
      ]]);
    } catch {
      try {
        out[name] = await call('fleet.warranty', 'search_count', [[
          ['state', '=', 'activated'], ['company_id', 'in', [id]], ...extra,
        ]]);
      } catch {
        out[name] = 0;
      }
    }
  }
  return out;
}

/** Roll a per-company map up into branch totals + per-sub-branch values. */
function rollUp(perCompany: Record<string, number>): {
  branchTotals: Record<Branch, number>;
  subValues: Record<string, number>;
} {
  const branchTotals = {} as Record<Branch, number>;
  const subValues: Record<string, number> = {};
  for (const branch of BRANCHES) {
    const companies = BRANCH_CLUSTERS[branch] || [];
    branchTotals[branch] = companies.reduce((sum, c) => sum + (perCompany[c] ?? 0), 0);
    const subMap = SUB_BRANCH_COMPANY[branch];
    if (subMap) {
      for (const [sub, company] of Object.entries(subMap)) {
        subValues[subKey(branch, sub)] = perCompany[company] ?? 0;
      }
    }
  }
  return { branchTotals, subValues };
}

// ── Metric queries (per-company; mirror Odoo saved filters) ────────
// Each returns a Record<companyName, count>, later rolled up into branch
// totals + per-sub-branch values. `extra` carries an optional date range.

// Base domains — defined once and shared by the count builders AND the record
// export registry below, so the two can never drift out of sync.
const DOM_SALE_ORDERS_TO_INVOICE: OdooDomain = [['invoice_ids', '=', false], ['state', '!=', 'cancel']];
const DOM_OPEN_REPAIR_ORDERS: OdooDomain     = [['state', '!=', 'cancel'], ['state', '!=', 'done']];
const DOM_ROS_WITHOUT_QUOTATIONS: OdooDomain = [['sale_order_id', '=', false], ['state', '!=', 'cancel'], ['state', '=', 'done']];
const DOM_ROS_WITHOUT_TAGS: OdooDomain        = [['state', '!=', 'cancel'], ['tag_ids', '=', false]];
const DOM_QUOTATIONS_NOT_APPROVED: OdooDomain = [['state', '=', 'draft']];
const DOM_ROS_WITHOUT_INVOICES: OdooDomain    = [['state', '!=', 'cancel'], ['priority_matrix_status', '!=', 'X'], ['tag_ids', 'not ilike', 'cancel']];
const DOM_WARRANTIES_ACTIVATED: OdooDomain    = [['state', '=', 'activated']];

/** A: "WIP daily not invoiced" — sale.order */
const qSaleOrdersToInvoice = (extra: OdooDomain = []) =>
  groupCountByCompany('sale.order', [...DOM_SALE_ORDERS_TO_INVOICE, ...extra]);

/** B: "Daily WIP open RO's" — repair.order */
const qOpenRepairOrders = (extra: OdooDomain = []) =>
  groupCountByCompany('repair.order', [...DOM_OPEN_REPAIR_ORDERS, ...extra]);

/** D: "Repair Orders completed without quotation" — repair.order */
const qRosWithoutQuotations = (extra: OdooDomain = []) =>
  groupCountByCompany('repair.order', [...DOM_ROS_WITHOUT_QUOTATIONS, ...extra]);

/** E: "No tags WIP" — repair.order */
const qRosWithoutTags = (extra: OdooDomain = []) =>
  groupCountByCompany('repair.order', [...DOM_ROS_WITHOUT_TAGS, ...extra]);

/** F: "WIP Quotes not approved" — sale.order (draft only) */
const qQuotationsNotApproved = (extra: OdooDomain = []) =>
  groupCountByCompany('sale.order', [...DOM_QUOTATIONS_NOT_APPROVED, ...extra]);

/** G: "WIP not invoiced" — repair.order. search_count per company because the
 *  many2many tag_ids filter miscounts under read_group JOINs. */
const qRosWithoutInvoices = (extra: OdooDomain = []) =>
  searchCountByCompany('repair.order', [...DOM_ROS_WITHOUT_INVOICES, ...extra]);

/** Saturday→Saturday window used by the daily "ROs Without Tags" metric. */
function currentSaturdayWindow(): OdooDomain {
  const now = new Date();
  const day = now.getDay();
  const satOffset = day >= 6 ? 0 : day + 1;
  const start = new Date(now);
  start.setDate(now.getDate() - satOffset);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return [
    ['create_date', '>=', start.toISOString().split('T')[0]],
    ['create_date', '<', end.toISOString().split('T')[0]],
  ];
}

// ── Record export (live CSV) ───────────────────────────────────────
// Maps each WIP metric to the model + (lazy) domain + display fields used to
// pull the ACTUAL matching records — same filters as the counts above.
const REPAIR_FIELDS   = ['name', 'company_id', 'partner_id', 'create_date', 'state'];
const SALE_FIELDS     = ['name', 'company_id', 'partner_id', 'date_order', 'amount_total', 'state'];
const WARRANTY_FIELDS = ['display_name', 'company_id', 'write_date', 'state'];

const METRIC_EXPORT: Record<WipMetricKey, { model: string; domain: () => OdooDomain; fields: string[]; warranty?: boolean }> = {
  saleOrdersToInvoice:  { model: 'sale.order',     domain: () => DOM_SALE_ORDERS_TO_INVOICE,                          fields: SALE_FIELDS },
  openRepairOrders:     { model: 'repair.order',   domain: () => DOM_OPEN_REPAIR_ORDERS,                              fields: REPAIR_FIELDS },
  warrantiesActivated:  { model: 'fleet.warranty', domain: () => DOM_WARRANTIES_ACTIVATED,                            fields: WARRANTY_FIELDS, warranty: true },
  rosWithoutQuotations: { model: 'repair.order',   domain: () => DOM_ROS_WITHOUT_QUOTATIONS,                          fields: REPAIR_FIELDS },
  rosWithoutTags:       { model: 'repair.order',   domain: () => [...DOM_ROS_WITHOUT_TAGS, ...currentSaturdayWindow()], fields: REPAIR_FIELDS },
  quotationsNotApproved:{ model: 'sale.order',     domain: () => DOM_QUOTATIONS_NOT_APPROVED,                         fields: SALE_FIELDS },
  rosWithoutInvoices:   { model: 'repair.order',   domain: () => DOM_ROS_WITHOUT_INVOICES,                            fields: REPAIR_FIELDS },
};

/**
 * Fetch the actual records behind a WIP metric (optionally for one branch),
 * using the exact same domain the count uses. For CSV export.
 */
export async function fetchMetricRecords(metric: WipMetricKey, branch?: Branch): Promise<Record<string, unknown>[]> {
  cachedUid = null;
  companyIdCache = null;

  const def = METRIC_EXPORT[metric];
  const ids = branch ? await branchCompanyIds(branch) : await allTrackedCompanyIds();
  const base = def.domain();

  if (def.warranty) {
    // Warranty company link may live on write_uid.company_id; fall back to company_id.
    try {
      return await call(def.model, 'search_read', [[...base, ['write_uid.company_id', 'in', ids]]], { fields: def.fields, limit: 5000 });
    } catch {
      return await call(def.model, 'search_read', [[...base, ['company_id', 'in', ids]]], { fields: def.fields, limit: 5000 });
    }
  }
  return await call(def.model, 'search_read', [[...base, ['company_id', 'in', ids]]], { fields: def.fields, limit: 5000 });
}

// ── Public API ─────────────────────────────────────────────────────
export interface OdooWipSnapshot {
  date: string;
  values: Record<WipMetricKey, Record<Branch, number>>;
  subValues: Record<WipMetricKey, Record<string, number>>;
}

/** Roll up the 7 per-company metric maps into a snapshot (branch totals + sub-branch values). */
function buildSnapshot(
  date: string,
  perCompany: Record<WipMetricKey, Record<string, number>>,
): OdooWipSnapshot {
  const values = {} as Record<WipMetricKey, Record<Branch, number>>;
  const subValues = {} as Record<WipMetricKey, Record<string, number>>;
  (Object.keys(perCompany) as WipMetricKey[]).forEach((m) => {
    const { branchTotals, subValues: sv } = rollUp(perCompany[m]);
    values[m] = branchTotals;
    subValues[m] = sv;
  });
  return { date, values, subValues };
}

/**
 * Fetch all 7 WIP metrics from Odoo and return a snapshot
 * with branch totals + per-sub-branch detail.
 */
export async function fetchWipSnapshot(dateStr?: string): Promise<OdooWipSnapshot> {
  cachedUid = null;
  companyIdCache = null;

  const snapshotDate = dateStr || new Date().toISOString().split('T')[0];

  const [
    saleOrdersToInvoice,
    openRepairOrders,
    warrantiesActivated,
    rosWithoutQuotations,
    rosWithoutTags,
    quotationsNotApproved,
    rosWithoutInvoices,
  ] = await Promise.all([
    qSaleOrdersToInvoice(),
    qOpenRepairOrders(),
    warrantiesByCompany(),
    qRosWithoutQuotations(),
    qRosWithoutTags(currentSaturdayWindow()),
    qQuotationsNotApproved(),
    qRosWithoutInvoices(),
  ]);

  return buildSnapshot(snapshotDate, {
    saleOrdersToInvoice,
    openRepairOrders,
    warrantiesActivated,
    rosWithoutQuotations,
    rosWithoutTags,
    quotationsNotApproved,
    rosWithoutInvoices,
  });
}

export async function fetchWipWeeklySnapshot(startDate: string, endDate: string): Promise<OdooWipSnapshot> {
  cachedUid = null;
  companyIdCache = null;

  const dateRange: OdooDomain = [
    ['create_date', '>=', startDate],
    ['create_date', '<', endDate],
  ];
  // Warranties use write_date instead of create_date
  const warrantyDateRange: OdooDomain = [
    ['write_date', '>=', startDate],
    ['write_date', '<', endDate],
  ];

  const [
    saleOrdersToInvoice,
    openRepairOrders,
    warrantiesActivated,
    rosWithoutQuotations,
    rosWithoutTags,
    quotationsNotApproved,
    rosWithoutInvoices,
  ] = await Promise.all([
    qSaleOrdersToInvoice(dateRange),
    qOpenRepairOrders(dateRange),
    warrantiesByCompany(warrantyDateRange),
    qRosWithoutQuotations(dateRange),
    qRosWithoutTags(dateRange),
    qQuotationsNotApproved(dateRange),
    qRosWithoutInvoices(dateRange),
  ]);

  return buildSnapshot(endDate, {
    saleOrdersToInvoice,
    openRepairOrders,
    warrantiesActivated,
    rosWithoutQuotations,
    rosWithoutTags,
    quotationsNotApproved,
    rosWithoutInvoices,
  });
}

/**
 * Fetch daily sales (posted customer invoices) from Odoo for a given date.
 * Uses account.move with move_type = 'out_invoice', state = 'posted',
 * grouped by company, summing amount_untaxed.
 *
 * @param dateStr - The date to fetch sales for (YYYY-MM-DD format).
 *                  Defaults to yesterday if not provided.
 */
export interface OdooSalesSnapshot {
  date: string;
  salesTotal: Record<Branch, number>;    // all posted out-invoices
  salesWithout: Record<Branch, number>;  // invoices without a warranty line
}

/** Sum amount_untaxed per branch for posted out-invoices on a date, plus an extra filter. */
async function salesByBranch(dateStr: string, extra: OdooDomain): Promise<Record<Branch, number>> {
  const trackedIds = await allTrackedCompanyIds();
  const groups = await call('account.move', 'read_group', [
    [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['date', '=', dateStr],
      ['company_id', 'in', trackedIds],
      ['partner_id', 'not ilike', 'EVS Electric'],
      ...extra,
    ],
  ], {
    fields: ['company_id', 'amount_untaxed'],
    groupby: ['company_id'],
    lazy: true,
  });

  const companyAmountMap: Record<number, number> = {};
  for (const g of groups) {
    const cid = g.company_id?.[0];
    if (cid) companyAmountMap[cid] = (g.amount_untaxed as number) || 0;
  }

  const out = {} as Record<Branch, number>;
  for (const branch of BRANCHES) {
    const ids = await branchCompanyIds(branch);
    out[branch] = ids.reduce((sum, id) => sum + (companyAmountMap[id] || 0), 0);
  }
  return out;
}

export async function fetchDailySales(dateStr?: string): Promise<OdooSalesSnapshot> {
  cachedUid = null;
  companyIdCache = null;

  // Default to yesterday
  if (!dateStr) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = yesterday.toISOString().split('T')[0];
  }

  // Total sales (no warranty filter) and the without-warranty subset.
  const [salesTotal, salesWithout] = await Promise.all([
    salesByBranch(dateStr, []),
    salesByBranch(dateStr, [
      ['invoice_line_ids', 'not ilike', 'warranty category'],
      ['invoice_line_ids', 'not ilike', 'warranty 5years'],
    ]),
  ]);

  return { date: dateStr, salesTotal, salesWithout };
}
