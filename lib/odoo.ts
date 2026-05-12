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
import { BRANCHES } from './types';

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
  'Sharjah':   ['EVS ELECTRIC VEHICLE SERVICE SHJ', 'Emarat - Muwafja'],
  'Abu Dhabi': ['EVS ELECTRIC VEHICLE SERVICE AD', 'Al Masaood'],
  'Al Ain':    ['EVS ELECTRIC VEHICLE SERVICE AL AIN'],
  'Qatar':     ['EVS ELECTRIC VEHICLE SERVICE QATAR'],
};

const ALL_TRACKED_COMPANIES = Object.values(BRANCH_CLUSTERS).flat();

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
  const ids: [number, string][] = await call('res.company', 'name_search', [''], { limit: 100 });
  companyIdCache = {};
  for (const [id, name] of ids) companyIdCache[name] = id;
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

async function countByBranch(model: string, domain: OdooDomain): Promise<Record<Branch, number>> {
  const trackedIds = await allTrackedCompanyIds();
  const fullDomain: OdooDomain = [...domain, ['company_id', 'in', trackedIds]];

  const groups: ReadGroupResult[] = await call(model, 'read_group', [fullDomain], {
    fields: ['company_id'],
    groupby: ['company_id'],
    lazy: true,
  });

  const companyCountMap: Record<number, number> = {};
  for (const g of groups) {
    const cid = g.company_id?.[0];
    const count = g.company_id_count ?? g.__count ?? 0;
    if (cid) companyCountMap[cid] = count as number;
  }

  const result = {} as Record<Branch, number>;
  for (const branch of BRANCHES) {
    const ids = await branchCompanyIds(branch);
    result[branch] = ids.reduce((sum, id) => sum + (companyCountMap[id] || 0), 0);
  }
  return result;
}

// ── Metric queries (mirror Odoo saved filters) ─────────────────────

/** A: "WIP daily not invoiced" — sale.order */
async function metricSaleOrdersToInvoice() {
  return countByBranch('sale.order', [
    ['invoice_ids', '=', false],
    ['state', '!=', 'cancel'],
  ]);
}

/** B: "Daily WIP open RO's" — repair.order */
async function metricOpenRepairOrders() {
  return countByBranch('repair.order', [
    ['state', '!=', 'cancel'],
    ['state', '!=', 'done'],
  ]);
}

/**
 * C: "WIP report" — Warranties Activated
 * Queried per-branch cluster to match the UI's per-company-chip behavior.
 * NOTE: Model name ('warranty.warranty') may need adjustment for your instance.
 */
async function metricWarrantiesActivated() {
  const model = 'fleet.warranty';
  const result = {} as Record<Branch, number>;

  for (const branch of BRANCHES) {
    const ids = await branchCompanyIds(branch);
    try {
      result[branch] = await call(model, 'search_count', [[
        ['state', '=', 'activated'],
        ['write_uid.company_id', 'in', ids],
      ]]);
    } catch {
      try {
        result[branch] = await call(model, 'search_count', [[
          ['state', '=', 'activated'],
          ['company_id', 'in', ids],
        ]]);
      } catch {
        console.warn(`⚠ Warranty query failed for ${branch} — setting to 0`);
        result[branch] = 0;
      }
    }
  }
  return result;
}

/** D: "Repair Orders completed without quotation" — repair.order */
async function metricRosWithoutQuotations() {
  return countByBranch('repair.order', [
    ['sale_order_id', '=', false],
    ['state', '!=', 'cancel'],
    ['state', '=', 'done'],
  ]);
}

/** E: "No tags weekly WIP" — repair.order (Saturday → Saturday window) */
async function metricRosWithoutTags() {
  const now = new Date();
  const day = now.getDay();
  const satOffset = day >= 6 ? 0 : day + 1;
  const start = new Date(now);
  start.setDate(now.getDate() - satOffset);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  return countByBranch('repair.order', [
    ['state', '!=', 'cancel'],
    ['tag_ids', '=', false],
    ['create_date', '>=', start.toISOString().split('T')[0]],
    ['create_date', '<', end.toISOString().split('T')[0]],
  ]);
}

/** F: "WIP Quotes not approved" — sale.order (draft only) */
async function metricQuotationsNotApproved() {
  return countByBranch('sale.order', [['state', '=', 'draft']]);
}

/** G: "WIP not invoiced" — repair.order (custom field: x_priority_matrix_status) */
async function metricRosWithoutInvoices() {
  return countByBranch('repair.order', [
    ['state', '!=', 'cancel'],
    ['priority_matrix_status', '!=', 'X'],
    ['tag_ids', '!=', 71],
  ]);
}

// ── Public API ─────────────────────────────────────────────────────
export interface OdooWipSnapshot {
  date: string;
  values: Record<WipMetricKey, Record<Branch, number>>;
}

/**
 * Fetch all 7 WIP metrics from Odoo and return a snapshot
 * matching the WipDailyEntry shape used by the admin form.
 */
export async function fetchWipSnapshot(): Promise<OdooWipSnapshot> {
  cachedUid = null;
  companyIdCache = null;

  const today = new Date().toISOString().split('T')[0];

  const [
    saleOrdersToInvoice,
    openRepairOrders,
    warrantiesActivated,
    rosWithoutQuotations,
    rosWithoutTags,
    quotationsNotApproved,
    rosWithoutInvoices,
  ] = await Promise.all([
    metricSaleOrdersToInvoice(),
    metricOpenRepairOrders(),
    metricWarrantiesActivated(),
    metricRosWithoutQuotations(),
    metricRosWithoutTags(),
    metricQuotationsNotApproved(),
    metricRosWithoutInvoices(),
  ]);

  return {
    date: today,
    values: {
      saleOrdersToInvoice,
      openRepairOrders,
      warrantiesActivated,
      rosWithoutQuotations,
      rosWithoutTags,
      quotationsNotApproved,
      rosWithoutInvoices,
    },
  };
}

export async function fetchWipWeeklySnapshot(startDate: string, endDate: string): Promise<OdooWipSnapshot> {
  cachedUid = null;
  companyIdCache = null;

  const dateRange: [string, string, string][] = [
    ['create_date', '>=', startDate],
    ['create_date', '<', endDate],
  ];

  // Warranties use write_date instead of create_date
  const warrantyDateRange: [string, string, string][] = [
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
    countByBranch('sale.order', [
      ['invoice_ids', '=', false],
      ['state', '!=', 'cancel'],
      ...dateRange,
    ]),
    countByBranch('repair.order', [
      ['state', '!=', 'cancel'],
      ['state', '!=', 'done'],
      ...dateRange,
    ]),
    (async () => {
      const model = 'fleet.warranty';
      const result = {} as Record<Branch, number>;
      for (const branch of BRANCHES) {
        const ids = await branchCompanyIds(branch);
        try {
          result[branch] = await call(model, 'search_count', [[
            ['state', '=', 'activated'],
            ['write_uid.company_id', 'in', ids],
            ...warrantyDateRange,
          ]]);
        } catch {
          try {
            result[branch] = await call(model, 'search_count', [[
              ['state', '=', 'activated'],
              ['company_id', 'in', ids],
              ...warrantyDateRange,
            ]]);
          } catch {
            result[branch] = 0;
          }
        }
      }
      return result;
    })(),
    countByBranch('repair.order', [
      ['sale_order_id', '=', false],
      ['state', '!=', 'cancel'],
      ['state', '=', 'done'],
      ...dateRange,
    ]),
    countByBranch('repair.order', [
      ['state', '!=', 'cancel'],
      ['tag_ids', '=', false],
      ...dateRange,
    ]),
    countByBranch('sale.order', [
      ['state', '=', 'draft'],
      ...dateRange,
    ]),
    countByBranch('repair.order', [
      ['state', '!=', 'cancel'],
      ['priority_matrix_status', '!=', 'X'],
      ['tag_ids', '!=', 71],
      ...dateRange,
    ]),
  ]);

  return {
    date: endDate,
    values: {
      saleOrdersToInvoice,
      openRepairOrders,
      warrantiesActivated,
      rosWithoutQuotations,
      rosWithoutTags,
      quotationsNotApproved,
      rosWithoutInvoices,
    },
  };
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
  sales: Record<Branch, number>;
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

  const trackedIds = await allTrackedCompanyIds();

  const groups = await call('account.move', 'read_group', [
    [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['date', '=', dateStr],
      ['company_id', 'in', trackedIds],
    ],
  ], {
    fields: ['company_id', 'amount_untaxed'],
    groupby: ['company_id'],
    lazy: true,
  });

  // Build company_id → amount_untaxed lookup
  const companyAmountMap: Record<number, number> = {};
  for (const g of groups) {
    const cid = g.company_id?.[0];
    if (cid) {
      companyAmountMap[cid] = (g.amount_untaxed as number) || 0;
    }
  }

  // Consolidate into branches
  const sales = {} as Record<Branch, number>;
  for (const branch of BRANCHES) {
    const ids = await branchCompanyIds(branch);
    sales[branch] = ids.reduce((sum, id) => sum + (companyAmountMap[id] || 0), 0);
  }

  return { date: dateStr, sales };
}
