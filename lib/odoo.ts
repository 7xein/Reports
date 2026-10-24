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
import { BRANCHES, WORKSHOP_BRANCHES, subKey } from './types';

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
  'Dubai':     ['EVS Dubai', 'Emarat - Altwar', 'Emarat - Albarsha'],
  'Ajman':     ['EVS ELECTRIC VEHICLE SERVICE AJ'],
  'Sharjah':   ['EVS ELECTRIC VEHICLE SERVICE SHARJAH', 'Emarat - Muwafja'],
  'Abu Dhabi': ['EVS ELECTRIC VEHICLE SERVICE ABU DHABI', 'Almushrif'],
  'Al Ain':    ['EVS ELECTRIC VEHICLE SERVICE AL AIN'],
  'EV Hub':    ['EV HUB'],
  'Qatar':     ['EVS ELECTRIC VEHICLE SERVICE QATAR'],
};

const ALL_TRACKED_COMPANIES = Object.values(BRANCH_CLUSTERS).flat();

// ── Sub-branch → Odoo company mapping ──────────────────────────────
// Each dashboard sub-branch corresponds to exactly one Odoo company.
// Keys/labels mirror SUB_BRANCHES in lib/types.ts.
const SUB_BRANCH_COMPANY: Record<string, Record<string, string>> = {
  'Dubai': {
    'Main branch':        'EVS Dubai',
    'Emarat - Albarsha':  'Emarat - Albarsha',
    'Emarat - Altwar':    'Emarat - Altwar',
  },
  'Sharjah': {
    'Main branch':        'EVS ELECTRIC VEHICLE SERVICE SHARJAH',
    'Emarat - Muwafja':   'Emarat - Muwafja',
  },
  'Abu Dhabi': {
    'Main branch':        'EVS ELECTRIC VEHICLE SERVICE ABU DHABI',
    'Almushrif':          'Almushrif',
  },
};

// ── Types ──────────────────────────────────────────────────────────
export type OdooDomain = (string | [string, string, unknown])[];

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

export async function call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  const uid = await authenticate();
  return jsonRpc(`${ODOO_URL()}/jsonrpc`, 'call', {
    service: 'object',
    method: 'execute_kw',
    args: [ODOO_DB(), uid, ODOO_API_KEY(), model, method, args, kwargs],
  });
}

// ── Helpers ────────────────────────────────────────────────────────
let companyIdCache: Record<string, number> | null = null;

export async function getCompanyIds(): Promise<Record<string, number>> {
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

/**
 * Company id for a configured name.
 *
 * Exact match first, then case- and whitespace-insensitive. Odoo company names
 * are typed by people and get re-typed on every rename, so "Almushrif" vs
 * "AlMushrif" is a matter of time — and an exact-only match turns that into a
 * silent zero rather than an error. The relaxed pass costs nothing and removes
 * a whole class of invisible breakage.
 */
function companyIdFor(map: Record<string, number>, name: string): number | undefined {
  const exact = map[name];
  if (exact) return exact;
  const want = name.trim().toLowerCase();
  for (const [known, id] of Object.entries(map)) {
    if (known.trim().toLowerCase() === want) return id;
  }
  return undefined;
}

export async function branchCompanyIds(branch: Branch): Promise<number[]> {
  const map = await getCompanyIds();
  return (BRANCH_CLUSTERS[branch] || [])
    .map((n) => { const id = companyIdFor(map, n); if (!id) console.warn(`⚠ Company "${n}" not found in Odoo`); return id; })
    .filter((id): id is number => id != null);
}

/**
 * Configured company names with no match in Odoo, as "Name (Branch)".
 *
 * Branch filters match on exact name, so a rename produces a silent zero rather
 * than an error. Callers surface this so the zero is explained at the point it
 * appears instead of only in the server log.
 */
export async function unresolvedCompanies(): Promise<string[]> {
  const map = await getCompanyIds();
  return Object.entries(BRANCH_CLUSTERS)
    .flatMap(([branch, names]) => names.map((n) => ({ branch, name: n })))
    .filter((c) => !companyIdFor(map, c.name))
    .map((c) => `${c.name} (${c.branch})`);
}

export async function allTrackedCompanyIds(): Promise<number[]> {
  const map = await getCompanyIds();
  return ALL_TRACKED_COMPANIES.map((n) => companyIdFor(map, n)).filter(Boolean) as number[];
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
    const id = companyIdFor(map, name);
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
    const id = companyIdFor(map, name);
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
  // WIP counts job cards, so EV Hub is out — it has no workshop.
  for (const branch of WORKSHOP_BRANCHES) {
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
// Work finished but not billed: Repaired, yet not "Invoiced & Closed".
const DOM_REPAIRED_NOT_INVOICED: OdooDomain   = [['state', '=', 'done'], ['priority_matrix_status', '!=', 'X']];

/** A: "WIP daily not invoiced" — sale.order */
const qSaleOrdersToInvoice = (extra: OdooDomain = []) =>
  groupCountByCompany('sale.order', [...DOM_SALE_ORDERS_TO_INVOICE, ...extra]);

/** B: "Daily WIP open RO's" — repair.order */
const qOpenRepairOrders = async (extra: OdooDomain = []) =>
  groupCountByCompany('repair.order', await liveRepairDomain(DOM_OPEN_REPAIR_ORDERS, extra));

/** D: "Repair Orders completed without quotation" — repair.order */
const qRosWithoutQuotations = async (extra: OdooDomain = []) =>
  groupCountByCompany('repair.order', await liveRepairDomain(DOM_ROS_WITHOUT_QUOTATIONS, extra));

/** E: "No tags WIP" — repair.order */
const qRosWithoutTags = async (extra: OdooDomain = []) =>
  groupCountByCompany('repair.order', await liveRepairDomain(DOM_ROS_WITHOUT_TAGS, extra));

/** F: "WIP Quotes not approved" — sale.order (draft only) */
const qQuotationsNotApproved = (extra: OdooDomain = []) =>
  groupCountByCompany('sale.order', [...DOM_QUOTATIONS_NOT_APPROVED, ...extra]);

/** G: "WIP not invoiced" — repair.order. search_count per company because the
 *  many2many tag_ids filter miscounts under read_group JOINs. */
const qRosWithoutInvoices = async (extra: OdooDomain = []) =>
  searchCountByCompany('repair.order', await liveRepairDomain(DOM_ROS_WITHOUT_INVOICES, extra));

/** H: "Repaired but not invoiced" — repair.order. No many2many filter, so
 *  read_group counts correctly here. */
const qRepairedNotInvoiced = async (extra: OdooDomain = []) =>
  groupCountByCompany('repair.order', await liveRepairDomain(DOM_REPAIRED_NOT_INVOICED, extra));

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

// ── Historical orders ──────────────────────────────────────────────
/** For the paths that read ids straight from the chatter, where no domain applies. */
export const HISTORICAL_FIELD = 'is_historical';
export const isHistorical = (rec: Record<string, unknown>): boolean => rec[HISTORICAL_FIELD] === true;

let historicalProbe: Promise<boolean> | null = null;

/**
 * Repair orders moved to Odoo's "Historical Orders" tab carry is_historical.
 * They are deliberately out of the working set, so nothing — WIP, KPIs or
 * exports — may count them.
 *
 * Guarded because the field is a customisation on this instance: elsewhere the
 * clause is simply empty rather than making every query fail.
 */
export async function notHistorical(): Promise<OdooDomain> {
  // Cache the promise, not the result: the snapshot builders all fire at once,
  // and caching only the settled value would let five of them race the same
  // fields_get before any of them finishes.
  historicalProbe ??= (async () => {
    try {
      const meta = (await call('repair.order', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
      return Object.prototype.hasOwnProperty.call(meta, HISTORICAL_FIELD);
    } catch {
      // A failed probe must not disable the filter for the life of the process:
      // forget it so the next call retries, rather than silently counting
      // historical orders again until a redeploy.
      historicalProbe = null;
      return false;
    }
  })();
  // '= false' also matches NULL, which is what records predating the field hold.
  return (await historicalProbe) ? [[HISTORICAL_FIELD, '=', false]] : [];
}

/**
 * The single place a repair.order domain gets narrowed to the working set.
 * Both the WIP counts and the record exports behind them build their domains
 * here, so the clause can never be added to one side and forgotten on the
 * other — a metric's total always reconciles with the rows it drills down to.
 */
async function liveRepairDomain(base: OdooDomain, extra: OdooDomain = []): Promise<OdooDomain> {
  return [...base, ...extra, ...(await notHistorical())];
}

// ── Record export (live CSV) ───────────────────────────────────────
// Maps each WIP metric to the model + (lazy) domain + display fields used to
// pull the ACTUAL matching records — same filters as the counts above.
// `create_uid` (Created By) exists on every Odoo model; `user_id` (Responsible /
// Salesperson) is included where the model has it (sale.order).
const REPAIR_FIELDS   = ['name', 'company_id', 'partner_id', 'create_date', 'state', 'create_uid'];
const SALE_FIELDS     = ['name', 'company_id', 'partner_id', 'date_order', 'amount_total', 'state', 'user_id', 'create_uid'];
const WARRANTY_FIELDS = ['display_name', 'company_id', 'write_date', 'state', 'create_uid'];

const METRIC_EXPORT: Record<WipMetricKey, { model: string; domain: () => OdooDomain; fields: string[]; warranty?: boolean }> = {
  saleOrdersToInvoice:  { model: 'sale.order',     domain: () => DOM_SALE_ORDERS_TO_INVOICE,                          fields: SALE_FIELDS },
  openRepairOrders:     { model: 'repair.order',   domain: () => DOM_OPEN_REPAIR_ORDERS,                              fields: REPAIR_FIELDS },
  warrantiesActivated:  { model: 'fleet.warranty', domain: () => DOM_WARRANTIES_ACTIVATED,                            fields: WARRANTY_FIELDS, warranty: true },
  rosWithoutQuotations: { model: 'repair.order',   domain: () => DOM_ROS_WITHOUT_QUOTATIONS,                          fields: REPAIR_FIELDS },
  rosWithoutTags:       { model: 'repair.order',   domain: () => DOM_ROS_WITHOUT_TAGS,                                fields: REPAIR_FIELDS },
  quotationsNotApproved:{ model: 'sale.order',     domain: () => DOM_QUOTATIONS_NOT_APPROVED,                         fields: SALE_FIELDS },
  rosWithoutInvoices:   { model: 'repair.order',   domain: () => DOM_ROS_WITHOUT_INVOICES,                            fields: REPAIR_FIELDS },
  repairedNotInvoiced:  { model: 'repair.order',   domain: () => DOM_REPAIRED_NOT_INVOICED,                           fields: REPAIR_FIELDS },
};

/**
 * Fetch the actual records behind a WIP metric (optionally for one branch),
 * using the exact same domain the count uses. For CSV export.
 *
 * @param range  Weekly export: restrict to a [start, end) window (create_date,
 *               or write_date for warranties) — mirrors fetchWipWeeklySnapshot.
 *               When omitted (daily export), "ROs Without Tags" uses the current
 *               Saturday→Saturday window, matching the daily snapshot.
 */
export async function fetchMetricRecords(
  metric: WipMetricKey,
  branch?: Branch,
  range?: { start: string; end: string },
): Promise<Record<string, unknown>[]> {
  cachedUid = null;
  companyIdCache = null;

  const def = METRIC_EXPORT[metric];
  const ids = branch ? await branchCompanyIds(branch) : await allTrackedCompanyIds();

  let extra: OdooDomain = [];
  if (range) {
    extra = def.warranty
      ? [['write_date', '>=', range.start], ['write_date', '<', range.end]]
      : [['create_date', '>=', range.start], ['create_date', '<', range.end]];
  } else if (metric === 'rosWithoutTags') {
    extra = currentSaturdayWindow();
  }
  // Only repair.order carries is_historical — adding the clause to the
  // sale.order / fleet.warranty metrics would make those queries fail.
  const base: OdooDomain = def.model === 'repair.order'
    ? await liveRepairDomain(def.domain(), extra)
    : [...def.domain(), ...extra];

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

// ── Repair-order record export (Excel) ─────────────────────────────
export interface RepairOrderExportRow {
  branch: Branch;
  roNumber: string;
  tags: string;            // tag_ids + x_studio_stages_tags names, combined
  createdBy: string;
  createdOn: string;       // DD/MM/YYYY (Gulf time)
  ageDays: number;         // Gulf calendar days the job card has been open, as of the export date
  customerName: string;
  customerMobile: string;
  vehicle: string;         // fleet_id
  repairStatus: string;    // state (human label)
  priorityMatrixStatus: string;
  closed: boolean;         // priority_matrix_status === 'X'
}

/** UTC window covering a Gulf (UTC+4) calendar day, as Odoo datetime strings. */
function gulfDayWindowUtc(dateStr: string): { start: string; end: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
  return {
    start: fmt(new Date(`${dateStr}T00:00:00+04:00`)),
    end:   fmt(new Date(`${dateStr}T23:59:59+04:00`)),
  };
}


/** Odoo UTC datetime 'YYYY-MM-DD HH:MM:SS' → 'DD/MM/YYYY' in Gulf time. */
function fmtGulfDate(raw: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  const d = new Date(raw.replace(' ', 'T') + 'Z');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(d);
}

/** The Gulf (UTC+4) calendar date of an Odoo UTC datetime, as YYYY-MM-DD. */
function gulfDateOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const d = new Date(raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Whole Gulf calendar days a job card has been open, measured to the export's
 * as-of date rather than to now — so re-running the same export later gives the
 * same numbers. Created on the as-of date reads as 0.
 */
function ageInDays(createDate: unknown, asOf: string): number {
  const created = gulfDateOf(createDate);
  if (!created) return 0;
  const ms = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${created}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86400_000));
}

const m2oName = (v: unknown): string => (Array.isArray(v) ? String(v[1] ?? '') : '');
const m2oId = (v: unknown): number | null => (Array.isArray(v) ? (v[0] as number) : null);

/** Branches included in the admin Excel exports (Qatar excluded per request). */
export const EXPORT_BRANCHES = BRANCHES.filter((b) => b !== 'Qatar' && b !== 'EV Hub') as Branch[];

/** priority_matrix_status letter codes → human labels. */
export const PRIORITY_MATRIX_LABELS: Record<string, string> = {
  K: 'Car Not In',
  H: 'No Action Taken',
  A: 'Awaiting Quotation',
  P: 'Awaiting Parts',
  I: 'Awaiting Labour',
  L: 'Labour Paused',
  W: 'Work In Progress',
  C: 'Labour Complete',
  G: 'QC Complete',
  D: 'Vehicle Ready',
  X: 'Closed and Invoiced',
};

/**
 * Fetch repair-order records for a Gulf date window, consolidated by branch, for Excel export.
 * @param opts.wipOnly    true → only priority_matrix_status != 'X' (WIP export);
 *                         false → all repair orders (Received export).
 * @param opts.startDate  window start (YYYY-MM-DD); defaults to dateStr (single day).
 */
export async function fetchRepairOrdersForExport(
  dateStr: string,
  opts: { wipOnly: boolean; startDate?: string },
): Promise<RepairOrderExportRow[]> {
  cachedUid = null;
  companyIdCache = null;

  // Only the MAIN company of each export branch — drop station companies
  // (Emarat sites, Almushrif), EV Hub and Qatar.
  const companyMap = await getCompanyIds();
  const idToBranch: Record<number, Branch> = {};
  const exportCompanyIds: number[] = [];
  for (const branch of EXPORT_BRANCHES) {
    const mainId = companyIdFor(companyMap, BRANCH_CLUSTERS[branch][0]);
    if (mainId) { idToBranch[mainId] = branch; exportCompanyIds.push(mainId); }
  }

  // Discover which candidate fields exist (+ their relation/selection metadata).
  const fieldsMeta = (await call('repair.order', 'fields_get', [], { attributes: ['type', 'relation', 'selection'] })) as Record<string, { relation?: string; selection?: [string, string][] }>;
  const has = (f: string) => Object.prototype.hasOwnProperty.call(fieldsMeta, f);
  const vehicleField = ['fleet_id', 'vehicle_id', 'lot_id', 'x_vehicle_id', 'x_vehicle'].find(has);
  const phoneField   = ['partner_phone', 'partner_mobile', 'mobile', 'phone'].find(has);
  // Many2many "tag" fields to merge into the Tags column.
  const tagFields = ['tag_ids', 'x_studio_stages_tags'].filter(has);

  const fields = ['name', 'company_id', 'create_date', 'priority_matrix_status'];
  for (const f of ['create_uid', 'partner_id', 'state', ...tagFields]) if (has(f)) fields.push(f);
  if (phoneField) fields.push(phoneField);
  if (vehicleField) fields.push(vehicleField);

  const start = gulfDayWindowUtc(opts.startDate ?? dateStr).start; // start-of-day GST
  const end = gulfDayWindowUtc(dateStr).end;                       // end-of-day GST on dateStr
  const domain: OdooDomain = await liveRepairDomain([
    ['create_date', '>=', start],
    ['create_date', '<=', end],
    ['company_id', 'in', exportCompanyIds],
  ]);
  if (opts.wipOnly) domain.push(['priority_matrix_status', '!=', 'X']);

  const records = (await call('repair.order', 'search_read', [domain], { fields, limit: 0 })) as Record<string, unknown>[];

  // Batch-resolve tag names per m2m field, reading names from each field's real comodel.
  const tagNamesByField: Record<string, Record<number, string>> = {};
  for (const tf of tagFields) {
    const relation = fieldsMeta[tf]?.relation;
    if (!relation) continue;
    const ids = [...new Set(records.flatMap((r) => (r[tf] as number[] | undefined) ?? []))];
    if (!ids.length) continue;
    try {
      const recs = (await call(relation, 'read', [ids], { fields: ['display_name'] })) as { id: number; display_name?: string }[];
      const map: Record<number, string> = {};
      for (const t of recs) map[t.id] = t.display_name || '';
      tagNamesByField[tf] = map;
    } catch { /* comodel unreadable — skip this field */ }
  }

  // Human labels for the state selection field.
  const stateLabels: Record<string, string> = {};
  for (const [k, v] of fieldsMeta.state?.selection ?? []) stateLabels[k] = v;

  // Batch-resolve customer phone when it isn't on repair.order directly.
  const phoneByPartner: Record<number, string> = {};
  if (!phoneField && has('partner_id')) {
    const partnerIds = [...new Set(records.map((r) => m2oId(r.partner_id)).filter((x): x is number => x != null))];
    if (partnerIds.length) {
      try {
        const partners = (await call('res.partner', 'read', [partnerIds], { fields: ['mobile', 'phone'] })) as { id: number; mobile?: string | false; phone?: string | false }[];
        for (const p of partners) phoneByPartner[p.id] = (p.mobile || p.phone || '') as string;
      } catch { /* ignore */ }
    }
  }

  const rows: RepairOrderExportRow[] = [];
  for (const r of records) {
    const cid = m2oId(r.company_id);
    const branch = cid != null ? idToBranch[cid] : undefined;
    if (!branch) continue; // skip non-tracked companies (CarDIP, …)

    const pid = m2oId(r.partner_id);
    const phone = phoneField
      ? (r[phoneField] as string | false | undefined) || ''
      : (pid != null ? phoneByPartner[pid] || '' : '');
    const pms = (r.priority_matrix_status as string | false) || '';
    const state = (r.state as string | false) || '';

    // Combine all tag-field names into one Tags cell.
    const tagParts: string[] = [];
    for (const tf of tagFields) {
      const map = tagNamesByField[tf] ?? {};
      for (const id of (r[tf] as number[] | undefined) ?? []) if (map[id]) tagParts.push(map[id]);
    }

    rows.push({
      branch,
      roNumber: (r.name as string) || '',
      tags: tagParts.join(', '),
      createdBy: m2oName(r.create_uid),
      createdOn: fmtGulfDate(r.create_date),
      ageDays: ageInDays(r.create_date, dateStr),
      customerName: m2oName(r.partner_id),
      customerMobile: String(phone || ''),
      vehicle: vehicleField ? m2oName(r[vehicleField]) : '',
      repairStatus: stateLabels[state] || state,
      priorityMatrixStatus: PRIORITY_MATRIX_LABELS[pms] || pms,
      closed: pms === 'X',
    });
  }
  return rows;
}

/**
 * Total invoiced sales (posted customer invoices, untaxed) for a Gulf day,
 * per export branch (main company only; excludes inter-branch "EVS Electric").
 */
export async function fetchInvoiceSalesForExport(dateStr: string): Promise<Record<string, number>> {
  cachedUid = null;
  companyIdCache = null;

  const companyMap = await getCompanyIds();
  const idToBranch: Record<number, string> = {};
  const ids: number[] = [];
  const result: Record<string, number> = {};
  for (const branch of EXPORT_BRANCHES) {
    result[branch] = 0;
    const id = companyIdFor(companyMap, BRANCH_CLUSTERS[branch][0]);
    if (id) { idToBranch[id] = branch; ids.push(id); }
  }

  const groups = (await call('account.move', 'read_group', [[
    ['move_type', '=', 'out_invoice'],
    ['state', '=', 'posted'],
    ['date', '=', dateStr],
    ['company_id', 'in', ids],
    ['partner_id', 'not ilike', 'EVS Electric'],
  ]], { fields: ['company_id', 'amount_untaxed'], groupby: ['company_id'], lazy: true })) as ReadGroupResult[];

  for (const g of groups) {
    const cid = g.company_id?.[0];
    const branch = cid != null ? idToBranch[cid] : undefined;
    if (branch) result[branch] += (g.amount_untaxed as number) || 0;
  }
  return result;
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
    repairedNotInvoiced,
  ] = await Promise.all([
    qSaleOrdersToInvoice(),
    qOpenRepairOrders(),
    warrantiesByCompany(),
    qRosWithoutQuotations(),
    qRosWithoutTags(currentSaturdayWindow()),
    qQuotationsNotApproved(),
    qRosWithoutInvoices(),
    qRepairedNotInvoiced(),
  ]);

  return buildSnapshot(snapshotDate, {
    saleOrdersToInvoice,
    openRepairOrders,
    warrantiesActivated,
    rosWithoutQuotations,
    rosWithoutTags,
    quotationsNotApproved,
    rosWithoutInvoices,
    repairedNotInvoiced,
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
    repairedNotInvoiced,
  ] = await Promise.all([
    qSaleOrdersToInvoice(dateRange),
    qOpenRepairOrders(dateRange),
    warrantiesByCompany(warrantyDateRange),
    qRosWithoutQuotations(dateRange),
    qRosWithoutTags(dateRange),
    qQuotationsNotApproved(dateRange),
    qRosWithoutInvoices(dateRange),
    qRepairedNotInvoiced(dateRange),
  ]);

  return buildSnapshot(endDate, {
    saleOrdersToInvoice,
    openRepairOrders,
    warrantiesActivated,
    rosWithoutQuotations,
    rosWithoutTags,
    quotationsNotApproved,
    rosWithoutInvoices,
    repairedNotInvoiced,
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
  /** Configured companies Odoo does not know about — each is silently worth 0. */
  unresolved: string[];
  date: string;
  salesTotal: Record<Branch, number>;    // all posted out-invoices
  salesWithout: Record<Branch, number>;  // invoices without a warranty line
}

/**
 * The partner records behind our own companies.
 *
 * Every Odoo company has a partner, and that partner is who appears as the
 * customer when one company invoices another. Matching on ids rather than on a
 * name is what makes this survive a rename — the old `not ilike 'EVS Electric'`
 * only ever caught the five companies whose names happen to contain that
 * string, so invoices to EVS Dubai, the Emarat stations, Almushrif and EV HUB
 * were all counted as outside revenue.
 */
export async function internalPartnerIds(): Promise<number[]> {
  const map = await getCompanyIds();
  const ids = ALL_TRACKED_COMPANIES
    .map((n) => companyIdFor(map, n))
    .filter((id): id is number => id != null);
  if (!ids.length) return [];
  try {
    const comps = (await call('res.company', 'read', [ids], { fields: ['partner_id'] })) as Record<string, unknown>[];
    return comps.map((c) => m2oId(c.partner_id)).filter((id): id is number => id != null);
  } catch {
    return [];
  }
}

let movePartnerFieldCache: string | null = null;

/** commercial_partner_id resolves a delivery contact back to its parent company. */
async function movePartnerField(): Promise<string> {
  if (movePartnerFieldCache) return movePartnerFieldCache;
  try {
    const meta = (await call('account.move', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
    movePartnerFieldCache = Object.prototype.hasOwnProperty.call(meta, 'commercial_partner_id')
      ? 'commercial_partner_id'
      : 'partner_id';
  } catch {
    movePartnerFieldCache = 'partner_id';
  }
  return movePartnerFieldCache;
}

/**
 * Drop invoices EVS raises against itself — except EV Hub's.
 *
 * Internal EVS-to-EVS invoices are transfers, not revenue, so counting them
 * double-counts the same money. EV Hub is the exception: it is the sister
 * company that sells parts TO EVS, so those invoices are precisely its business.
 * Excluding them left it reporting only the fraction sold to outside customers.
 *
 * Expressed as "company is EV Hub OR the customer is not one of ours", which
 * keeps the whole thing to one query.
 */
async function excludeInternalSales(): Promise<OdooDomain> {
  const [evHubIds, internal, field] = await Promise.all([
    branchCompanyIds('EV Hub'),
    internalPartnerIds(),
    movePartnerField(),
  ]);
  // If the partners cannot be resolved, fall back to the old name match rather
  // than silently counting every internal transfer as revenue.
  const notInternal: [string, string, unknown] = internal.length
    ? [field, 'not in', internal]
    : ['partner_id', 'not ilike', 'EVS Electric'];
  return evHubIds.length
    ? ['|', ['company_id', 'in', evHubIds], notInternal]
    : [notInternal];
}

/** Sum amount_untaxed per branch for posted out-invoices on a date, plus an extra filter. */
async function salesByBranch(dateStr: string, extra: OdooDomain): Promise<Record<Branch, number>> {
  const trackedIds = await allTrackedCompanyIds();
  const internal = await excludeInternalSales();
  const groups = await call('account.move', 'read_group', [
    [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['date', '=', dateStr],
      ['company_id', 'in', trackedIds],
      ...internal,
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

/** Per-day, per-branch sales for a date range. */
export interface OdooSalesRange {
  start: string;
  end: string;
  /** date → branch → amount. Only days with sales appear. */
  totals: Record<string, Record<string, number>>;
  without: Record<string, Record<string, number>>;
  invoiceCount: number;
  unresolved: string[];
}

/**
 * Every invoice in a date range, totalled per day and per branch.
 *
 * The daily sync asks "what was invoiced on this date" once and never returns,
 * so an invoice posted later but dated earlier can never reach the figure. This
 * re-reads a whole span in one pass, which is what makes back-dated invoices
 * show up.
 *
 * Reads the invoices rather than grouping server-side by date: Odoo formats
 * date groups for display, and parsing those back is locale-dependent.
 */
export async function fetchSalesRange(start: string, end: string): Promise<OdooSalesRange> {
  cachedUid = null;
  companyIdCache = null;

  const idToBranch: Record<number, string> = {};
  for (const branch of BRANCHES) {
    for (const id of await branchCompanyIds(branch)) idToBranch[id] = branch;
  }
  const ids = Object.keys(idToBranch).map(Number);

  const base: OdooDomain = [
    ['move_type', '=', 'out_invoice'],
    ['state', '=', 'posted'],
    ['date', '>=', start],
    ['date', '<=', end],
    ['company_id', 'in', ids],
    ...(await excludeInternalSales()),
  ];

  const read = async (extra: OdooDomain) =>
    (await call('account.move', 'search_read', [[...base, ...extra]], {
      fields: ['company_id', 'date', 'amount_untaxed'], limit: 0,
    })) as Record<string, unknown>[];

  const [all, withoutWarranty] = await Promise.all([
    read([]),
    read([
      ['invoice_line_ids', 'not ilike', 'warranty category'],
      ['invoice_line_ids', 'not ilike', 'warranty 5years'],
    ]),
  ]);

  const bucket = (rows: Record<string, unknown>[]) => {
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      const cid = m2oId(r.company_id);
      const branch = cid != null ? idToBranch[cid] : undefined;
      const date = typeof r.date === 'string' ? r.date.slice(0, 10) : null;
      if (!branch || !date) continue;
      (out[date] ??= {})[branch] = (out[date][branch] ?? 0) + ((r.amount_untaxed as number) || 0);
    }
    return out;
  };

  return {
    start, end,
    totals: bucket(all),
    without: bucket(withoutWarranty),
    invoiceCount: all.length,
    unresolved: await unresolvedCompanies(),
  };
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

  return { date: dateStr, salesTotal, salesWithout, unresolved: await unresolvedCompanies() };
}

// ── KPI: live option lists + field verification ────────────────────
export interface KpiOdooOptions {
  /** priority_matrix_status selection values (this instance's real workflow). */
  priorityOptions: { value: string; label: string }[];
  /** repair.order `state` selection values (e.g. under_repair). */
  stateOptions: { value: string; label: string }[];
  /** repair.order `repair_state` selection values — this instance's workflow bar. */
  repairStateOptions: { value: string; label: string }[];
  /** repair.order stage records, if the model actually has stage_id. */
  stages: { id: number; name: string }[];
  /** repair.order tag records. */
  tags: { id: number; name: string }[];
  /**
   * Every active internal Odoo user, selectable for KPI measurement.
   * `roCount` is a hint — ROs created in the last 90 days, 0 for users who
   * never raise ROs (parts staff, workshop managers, and so on).
   */
  users: { id: number; name: string; roCount: number }[];
  /** fields_get verification, surfaced in the admin UI. */
  fieldReport: {
    hasStageId: boolean;
    hasState: boolean;
    hasPriorityMatrixStatus: boolean;
    hasDateLastStageUpdate: boolean;
    hasSaleOrderId: boolean;
    stageAgeField: string;   // date_last_stage_update, else write_date
    notes: string[];
  };
}

/**
 * How many tracked changes the chatter holds per candidate field, last 30 days.
 *
 * Every elapsed-time KPI reads its clock from the chatter, so a field with zero
 * tracked changes cannot drive one no matter how it is mapped. This turns that
 * from a guess into a number.
 */
async function chatterTrackingCounts(fields: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!fields.length) return out;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  try {
    const tvMeta = (await call('mail.tracking.value', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
    const useFieldId = Object.prototype.hasOwnProperty.call(tvMeta, 'field_id');

    let idByName: Record<string, number> = {};
    if (useFieldId) {
      const frs = (await call('ir.model.fields', 'search_read', [[
        ['model', '=', 'repair.order'], ['name', 'in', fields],
      ]], { fields: ['id', 'name'] })) as { id: number; name: string }[];
      idByName = Object.fromEntries(frs.map((f) => [f.name, f.id]));
    }

    for (const f of fields) {
      const domain: OdooDomain = useFieldId
        ? [['field_id', '=', idByName[f] ?? 0], ['create_date', '>=', since]]
        : [['field', '=', f], ['create_date', '>=', since]];
      try {
        out[f] = (await call('mail.tracking.value', 'search_count', [domain])) as number;
      } catch { out[f] = -1; }
    }
  } catch { /* probe unavailable — the caller just omits the line */ }
  return out;
}

export async function fetchKpiOdooOptions(): Promise<KpiOdooOptions> {
  cachedUid = null;
  companyIdCache = null;

  const meta = (await call('repair.order', 'fields_get', [], {
    attributes: ['string', 'type', 'relation', 'selection'],
  })) as Record<string, { string?: string; type?: string; relation?: string; selection?: [string, string][] }>;
  const has = (f: string) => Object.prototype.hasOwnProperty.call(meta, f);

  const notes: string[] = [];

  // Priority matrix — prefer Odoo's own selection labels, fall back to our map.
  let priorityOptions = (meta.priority_matrix_status?.selection ?? []).map(([value, label]) => ({ value, label }));
  if (!priorityOptions.length) {
    priorityOptions = Object.entries(PRIORITY_MATRIX_LABELS).map(([value, label]) => ({ value, label }));
  }

  const stateOptions = (meta.state?.selection ?? []).map(([value, label]) => ({ value, label }));
  // repair_state carries the full workflow bar (Inspection, QA, After QA …) that
  // the stock `state` field does not.
  const repairStateOptions = (meta.repair_state?.selection ?? []).map(([value, label]) => ({ value, label }));

  // Stages (only if stage_id genuinely exists on this model).
  let stages: { id: number; name: string }[] = [];
  if (has('stage_id') && meta.stage_id?.relation) {
    try {
      const recs = (await call(meta.stage_id.relation, 'search_read', [[]], { fields: ['display_name'], limit: 200 })) as { id: number; display_name?: string }[];
      stages = recs.map((r) => ({ id: r.id, name: r.display_name || `#${r.id}` }));
    } catch { notes.push('stage_id exists but its stage model could not be read.'); }
  } else {
    notes.push('repair.order has no usable stage_id — map states via Priority Matrix instead.');
  }

  // Tags.
  let tags: { id: number; name: string }[] = [];
  if (has('tag_ids') && meta.tag_ids?.relation) {
    try {
      const recs = (await call(meta.tag_ids.relation, 'search_read', [[]], { fields: ['display_name'], limit: 300 })) as { id: number; display_name?: string }[];
      tags = recs.map((r) => ({ id: r.id, name: r.display_name || `#${r.id}` }));
    } catch { notes.push('tag_ids comodel could not be read.'); }
  }

  // Selectable users: every active internal user, with the RO count (last 90
  // days, grouped not row-by-row) kept as a hint where there is one. KPIs now
  // judge chatter mentions too, so parts staff and managers who never raise an
  // RO still have to be selectable.
  const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const trackedIds = await allTrackedCompanyIds();
  const users: { id: number; name: string; roCount: number }[] = [];
  try {
    const groups = (await call('repair.order', 'read_group', [await liveRepairDomain([
      ['create_date', '>=', since],
      ['company_id', 'in', trackedIds],
    ])], { fields: ['create_uid'], groupby: ['create_uid'], lazy: true })) as ReadGroupResult[];
    for (const g of groups) {
      const u = g.create_uid as [number, string] | undefined;
      if (!u) continue;
      users.push({ id: u[0], name: u[1], roCount: (g.create_uid_count ?? g.__count ?? 0) as number });
    }
  } catch { notes.push('Could not group ROs by creator — RO counts will show as 0.'); }

  const roCreatorCount = users.length;
  try {
    const recs = (await call('res.users', 'search_read', [[
      ['active', '=', true],
      ['share', '=', false],
    ]], { fields: ['name'], limit: 1000 })) as { id: number; name?: string }[];
    if (recs.length >= 1000) {
      notes.push('⚠ Hit the 1000-user read cap — some active users may be missing from the list.');
    }
    const seen = new Set(users.map((u) => u.id));
    for (const r of recs) {
      if (r.id == null || seen.has(r.id)) continue;
      seen.add(r.id);
      users.push({ id: r.id, name: r.name || `#${r.id}`, roCount: 0 });
    }
  } catch {
    notes.push('Could not read the full internal user list — only RO creators are selectable.');
  }

  users.sort((a, b) => b.roCount - a.roCount || a.name.localeCompare(b.name));
  notes.push(`Selectable users: ${users.length} (${roCreatorCount} have created a repair order in the last 90 days).`);

  // Spell out what each list actually contains — the workflow bar in Odoo can be
  // driven by state OR stage_id, and knowing which saves a lot of guessing.
  // Invoice reachability per company. A branch reading 0 is ambiguous: no sales
  // that day, or invoices that exist but never match the filter. Counting them
  // over 30 days with and without the posted filter separates the two.
  try {
    const companyMap = await getCompanyIds();
    const idToName: Record<number, string> = {};
    for (const [n, id] of Object.entries(companyMap)) idToName[id] = n;
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

    const tally = async (extra: OdooDomain) => {
      const groups = (await call('account.move', 'read_group', [[
        ['move_type', '=', 'out_invoice'],
        ['date', '>=', since30],
        // No company filter: a branch reading low usually means its invoices sit
        // on a company no branch claims, and that only shows if we count them all.
        ...extra,
      ]], { fields: ['company_id', 'amount_untaxed'], groupby: ['company_id'], lazy: true })) as ReadGroupResult[];
      const out: Record<string, { n: number; amt: number }> = {};
      for (const g of groups) {
        const name = g.company_id?.[0] != null ? idToName[g.company_id[0]] : undefined;
        if (!name) continue;
        out[name] = {
          n: (g.company_id_count ?? g.__count ?? 0) as number,
          amt: (g.amount_untaxed as number) || 0,
        };
      }
      return out;
    };

    const [posted, any] = await Promise.all([tally([['state', '=', 'posted']]), tally([])]);
    const fmt = (name: string) => {
      const pp = posted[name], aa = any[name];
      if (!aa) return `${name}: none`;
      return `${name}: ${pp?.n ?? 0} posted of ${aa.n} (AED ${Math.round(pp?.amt ?? 0).toLocaleString('en-US')})`;
    };

    const tracked = Object.values(BRANCH_CLUSTERS).flat();
    notes.push(`Invoices per COUNTED company, last 30 days — ${tracked.map(fmt).join(' · ')}`);

    // Anything invoicing that no branch claims. This is where a renamed or
    // duplicated company hides.
    const knownNames = new Set(tracked.map((n) => n.trim().toLowerCase()));
    const strays = Object.keys(any)
      .filter((n) => !knownNames.has(n.trim().toLowerCase()))
      .sort((x, y) => (posted[y]?.amt ?? 0) - (posted[x]?.amt ?? 0))
      .slice(0, 15);
    notes.push(strays.length
      ? `⚠ Invoicing companies NOT counted by any branch — ${strays.map(fmt).join(' · ')}`
      : 'Every invoicing company in Odoo is claimed by a branch.');
  } catch (e) {
    notes.push(`Invoice probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // What marks a repair order as "historical"? Orders moved to that tab must
  // stop counting, and a menu tab in Odoo is just a domain over the same model —
  // so something on the record has to carry the distinction.
  try {
    const flagged = Object.entries(meta)
      .filter(([n, m]) => /histor|archiv|legacy|old/i.test(n) || /histor|archiv|legacy|old/i.test(m.string ?? ''))
      .map(([n, m]) => `${n}${m.string ? ` (${m.string})` : ''} [${m.type}]`);
    notes.push(`Fields mentioning historical/archive/legacy: ${flagged.join(' · ') || '(none)'}`);

    const booleans = Object.entries(meta)
      .filter(([, m]) => m.type === 'boolean')
      .map(([n, m]) => `${n}${m.string ? ` (${m.string})` : ''}`);
    notes.push(`Boolean fields on repair.order: ${booleans.join(' · ') || '(none)'}`);

    // Archiving would already hide them from us, so a difference here rules it in
    // or out immediately.
    if (has('active')) {
      const [visible, withArchived] = await Promise.all([
        call('repair.order', 'search_count', [[]]) as Promise<number>,
        call('repair.order', 'search_count', [[['active', 'in', [true, false]]]]) as Promise<number>,
      ]);
      notes.push(`Repair orders the dashboards can see: ${visible}; including archived: ${withArchived}${visible === withArchived ? ' — nothing is archived, so Historical is not archiving.' : ` — ${withArchived - visible} archived.`}`);
    }
  } catch { notes.push('Historical-field probe failed.'); }

  // Which partners count as "us" for the internal-sales filter.
  try {
    const internal = await internalPartnerIds();
    if (internal.length) {
      const names = (await call('res.partner', 'read', [internal], { fields: ['display_name'] })) as Record<string, unknown>[];
      notes.push(`Invoices to these partners are treated as internal and excluded (EV Hub exempt): ${names.map((n) => n.display_name).join(' · ')}`);
    } else {
      notes.push('⚠ Could not resolve our own companies to partner records — internal-sales filtering fell back to matching the name "EVS Electric".');
    }
  } catch { /* non-fatal diagnostic */ }

  // Company-name resolution. Branch filters match on exact NAME, so a company
  // renamed in Odoo silently contributes zero rather than erroring — the failure
  // mode that took out Abu Dhabi and Sharjah. Name both sides of any mismatch.
  try {
    const companyMap = await getCompanyIds();
    const configured = Object.entries(BRANCH_CLUSTERS)
      .flatMap(([branch, names]) => names.map((n) => ({ branch, name: n })));
    const missing = configured.filter((c) => !companyIdFor(companyMap, c.name));
    const known = new Set(configured.map((c) => c.name));
    const unmatched = Object.keys(companyMap).filter((n) => !known.has(n));

    notes.push(missing.length
      ? `⚠ CONFIGURED BUT NOT FOUND IN ODOO: ${missing.map((c) => `"${c.name}" (${c.branch})`).join(' · ')} — these contribute 0 to their branch.`
      : `All ${configured.length} configured companies resolved in Odoo.`);
    notes.push(`Odoo companies not counted by any branch: ${unmatched.map((n) => `"${n}"`).join(' · ') || '(none)'}`);
  } catch { notes.push('Company-name check failed.'); }

  // Which of the candidate fields the chatter actually records — decisive for
  // every KPI that measures elapsed time.
  const trackCounts = await chatterTrackingCounts(
    ['state', 'repair_state', 'priority_matrix_status', 'stage_id'].filter(has));
  const trackLine = Object.entries(trackCounts)
    .map(([f, n]) => `${f}=${n < 0 ? 'error' : n}`)
    .join(', ');
  if (trackLine) {
    notes.push(`Chatter changes tracked in the last 30 days: ${trackLine}. A field showing 0 cannot drive any time-based KPI.`);
  }

  const followUpField = ['follow_up_screenshot', 'x_follow_up_screenshot'].find(has);
  // Settle whether a 0% follow-up score means "nobody uploads it" or "we are
  // reading the wrong field": count every RO that has one, ever.
  if (followUpField) {
    try {
      const withShot = (await call('repair.order', 'search_count', [[[followUpField, '!=', false]]])) as number;
      notes.push(`ROs with a follow-up screenshot attached (all time, all companies): ${withShot}`);
    } catch { notes.push('Could not count ROs carrying a follow-up screenshot.'); }
  }

  notes.push(`Customer follow-up field: ${followUpField ?? 'NOT FOUND on repair.order'}`
    + `; QA-eligibility flag: ${has('repair_is_qa') ? 'repair_is_qa' : 'not present (all repaired ROs will be counted)'}`);

  // Explicit stage timestamps, if the workflow writes any. These beat the chatter
  // outright — they survive without tracking and cannot be lost to a field remap.
  const dateFields = Object.entries(meta)
    .filter(([, m]) => m.type === 'date' || m.type === 'datetime')
    .map(([name, m]) => `${name}${m.string ? ` (${m.string})` : ''}`)
    .sort();
  notes.push(`Date fields on repair.order: ${dateFields.join(', ') || '(none)'}`);

  notes.push(`Repair Status options: ${repairStateOptions.map((o) => o.label).join(', ') || '(none)'}`);
  notes.push(`State options: ${stateOptions.map((o) => o.label).join(', ') || '(none)'}`);
  notes.push(`Stage options: ${stages.map((s) => s.name).join(', ') || '(none)'}`);

  const hasDateLastStageUpdate = has('date_last_stage_update');
  if (!hasDateLastStageUpdate) {
    notes.push('date_last_stage_update is not available — awaiting parts/labour fall back to create_date, i.e. the age of the RO itself.');
  }

  return {
    priorityOptions,
    stateOptions,
    repairStateOptions,
    stages,
    tags,
    users,
    fieldReport: {
      hasStageId: has('stage_id'),
      hasState: has('state'),
      hasPriorityMatrixStatus: has('priority_matrix_status'),
      hasDateLastStageUpdate,
      hasSaleOrderId: has('sale_order_id'),
      stageAgeField: hasDateLastStageUpdate ? 'date_last_stage_update' : 'create_date',
      notes,
    },
  };
}

// ── KPI roster: suggest who to measure, from recent activity ───────
/**
 * One person the KPI roster could contain, together with the evidence behind
 * every guess. The admin reviews this before saving, so each field that is a
 * judgement (branch, section) ships with the counts it was derived from —
 * a suggestion that cannot be checked is worse than no suggestion.
 */
export interface RosterSuggestion {
  odooUserId: number;
  name: string;
  /** Branch carrying the most of their activity; null when none of it is ours. */
  branch: string | null;
  /** Anyone who raised an RO or a quotation is treated as a Service Advisor. */
  section: 'advisor' | 'workshop';
  jobTitle: string | null;
  department: string | null;
  rosCreated: number;
  quotesCreated: number;
  /** repair_state changes they authored, read from the tracking log. */
  stageMoves: number;
  /** Comments they authored on repair orders. */
  chatterPosts: number;
  /** branch → activity count, so the UI can show why the branch was picked. */
  branchCounts: Record<string, number>;
}

/** Activity window for the roster suggestion. */
const ROSTER_DAYS = 30;

/** Odoo chokes on very large `in` lists, so every id list goes in slices. */
const ID_CHUNK = 2000;
function idChunks(ids: number[], size = ID_CHUNK): number[][] {
  if (ids.length <= size) return ids.length ? [ids] : [];
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Who has been working in the last 30 days, which branch they worked in, and
 * whether they look like a Service Advisor or Workshop — assembled from four
 * independent signals so the admin can populate the KPI roster from evidence
 * instead of typing a hundred names.
 *
 * Deliberately a SUGGESTION: every count that fed a guess is returned alongside
 * it, and each signal is read in its own try/catch so one unreadable model
 * degrades a single column to zero instead of losing the whole list.
 */
export async function fetchRosterSuggestion(): Promise<{ people: RosterSuggestion[]; notes: string[] }> {
  cachedUid = null;
  companyIdCache = null;

  const notes: string[] = [];
  const since = new Date(Date.now() - ROSTER_DAYS * 86400_000).toISOString().slice(0, 19).replace('T', ' ');

  // Scope: WORKSHOP branches only, matching the KPI engine. EV Hub is a sales
  // location with no workshop, so it holds no roster and appears in no KPI tree
  // — suggesting someone for it would propose a branch that cannot store them.
  // Someone whose only activity is EV Hub therefore drops out entirely, which is
  // correct; mixed activity resolves to their workshop branch.
  //
  // Without this inversion nothing can be attributed, so it is the one failure
  // that ends the run — with the reason in the notes rather than as a throw.
  let trackedIds: number[] = [];
  const idToBranch: Record<number, Branch> = {};
  try {
    for (const b of WORKSHOP_BRANCHES) for (const id of await branchCompanyIds(b)) idToBranch[id] = b;
    trackedIds = Object.keys(idToBranch).map(Number);
  } catch (e) {
    notes.push(`No activity could be read — the tracked companies did not resolve: ${errText(e)}`);
    return { people: [], notes };
  }
  if (!trackedIds.length) {
    notes.push('⚠ None of the configured companies resolved in Odoo, so no activity can be attributed — the suggestion is empty.');
    return { people: [], notes };
  }
  const notHist = await notHistorical();

  type Tally = {
    name: string;
    rosCreated: number;
    quotesCreated: number;
    stageMoves: number;
    chatterPosts: number;
    branchCounts: Record<string, number>;
  };
  const tally = new Map<number, Tally>();

  const credit = (
    userId: number | null,
    name: string,
    key: 'rosCreated' | 'quotesCreated' | 'stageMoves' | 'chatterPosts',
    n: number,
    companyId: number | null,
  ) => {
    if (userId == null || n <= 0) return;
    let t = tally.get(userId);
    if (!t) {
      t = { name: name || `#${userId}`, rosCreated: 0, quotesCreated: 0, stageMoves: 0, chatterPosts: 0, branchCounts: {} };
      tally.set(userId, t);
    } else if (name && t.name.startsWith('#')) {
      t.name = name;
    }
    t[key] += n;
    const branch = companyId != null ? idToBranch[companyId] : undefined;
    if (branch) t.branchCounts[branch] = (t.branchCounts[branch] ?? 0) + n;
  };

  // 1 ── Repair orders created. Grouped by creator AND company (lazy: false) so
  // one call yields both the count and the branch split behind it.
  try {
    const groups = (await call('repair.order', 'read_group', [[
      ['create_date', '>=', since],
      ['company_id', 'in', trackedIds],
      ...notHist,
    ] as OdooDomain], {
      fields: ['create_uid', 'company_id'],
      groupby: ['create_uid', 'company_id'],
      lazy: false,
    })) as ReadGroupResult[];
    for (const g of groups) {
      credit(m2oId(g.create_uid), m2oName(g.create_uid), 'rosCreated',
        (g.__count ?? g.create_uid_count ?? 0) as number, m2oId(g.company_id));
    }
  } catch (e) {
    notes.push(`Repair orders created could not be grouped by creator — that column reads 0 for everyone: ${errText(e)}`);
  }

  // 2 ── Quotations created, same treatment. No historical clause: that flag
  // lives on repair.order, not on sale.order.
  try {
    const groups = (await call('sale.order', 'read_group', [[
      ['create_date', '>=', since],
      ['company_id', 'in', trackedIds],
    ] as OdooDomain], {
      fields: ['create_uid', 'company_id'],
      groupby: ['create_uid', 'company_id'],
      lazy: false,
    })) as ReadGroupResult[];
    for (const g of groups) {
      credit(m2oId(g.create_uid), m2oName(g.create_uid), 'quotesCreated',
        (g.__count ?? g.create_uid_count ?? 0) as number, m2oId(g.company_id));
    }
  } catch (e) {
    notes.push(`Quotations created could not be grouped by creator — that column reads 0 for everyone: ${errText(e)}`);
  }

  type Msg = { id?: number; author_id?: unknown; res_id?: number; tracking_value_ids?: number[] };

  // 3 ── Chatter comments on repair orders.
  let comments: Msg[] = [];
  try {
    comments = (await call('mail.message', 'search_read', [[
      ['model', '=', 'repair.order'],
      ['date', '>=', since],
      ['message_type', '=', 'comment'],
    ] as OdooDomain], { fields: ['author_id', 'res_id'], limit: 0 })) as Msg[];
  } catch (e) {
    notes.push(`Chatter posts could not be read — that column reads 0 for everyone: ${errText(e)}`);
  }

  // 4 ── Stage moves: chatter messages carrying a tracked change of
  // repair_state. Same v17 / legacy split as the rest of this file — newer
  // instances reference the field by id, older ones by name.
  let stageMsgs: Msg[] = [];
  try {
    const tvMeta = (await call('mail.tracking.value', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
    const useFieldId = Object.prototype.hasOwnProperty.call(tvMeta, 'field_id');
    let fieldId: number | null = null;
    if (useFieldId) {
      const frs = (await call('ir.model.fields', 'search_read', [[
        ['model', '=', 'repair.order'], ['name', '=', 'repair_state'],
      ] as OdooDomain], { fields: ['id'], limit: 1 })) as { id: number }[];
      fieldId = frs[0]?.id ?? null;
      if (fieldId == null) throw new Error('repair_state is not a field on repair.order in this instance');
    }

    const msgs = (await call('mail.message', 'search_read', [[
      ['model', '=', 'repair.order'],
      ['date', '>=', since],
      ['tracking_value_ids', '!=', false],
    ] as OdooDomain], { fields: ['author_id', 'res_id', 'tracking_value_ids'], limit: 0 })) as Msg[];

    const tvIds = [...new Set(msgs.flatMap((m) => m.tracking_value_ids ?? []))];
    const ref = useFieldId ? 'field_id' : 'field';
    const isStageChange = new Set<number>();
    for (const chunk of idChunks(tvIds)) {
      const tvs = (await call('mail.tracking.value', 'read', [chunk], { fields: [ref] })) as Record<string, unknown>[];
      for (const tv of tvs) {
        const hit = useFieldId
          ? m2oId(tv.field_id) === fieldId
          // The legacy column holds the field NAME; some versions relate it instead.
          : (Array.isArray(tv.field) ? m2oName(tv.field) : String(tv.field ?? '')) === 'repair_state';
        if (hit && typeof tv.id === 'number') isStageChange.add(tv.id);
      }
    }
    stageMsgs = msgs.filter((m) => (m.tracking_value_ids ?? []).some((id) => isStageChange.has(id)));
  } catch (e) {
    notes.push(`Stage moves could not be read from the chatter — that column reads 0 for everyone: ${errText(e)}`);
  }

  // Both message signals hang off a repair order but carry no company of their
  // own, so the orders behind them are resolved once. That single lookup is what
  // keeps historical orders and untracked companies out of these two columns,
  // and it is also where the branch for a comment or a stage move comes from.
  const companyByRo = new Map<number, number>();
  if (comments.length || stageMsgs.length) {
    const roIds = [...new Set([...comments, ...stageMsgs]
      .map((m) => m.res_id)
      .filter((x): x is number => typeof x === 'number'))];
    try {
      for (const chunk of idChunks(roIds)) {
        const recs = (await call('repair.order', 'search_read', [[
          ['id', 'in', chunk],
          ['company_id', 'in', trackedIds],
          ...notHist,
        ] as OdooDomain], { fields: ['company_id'], limit: 0 })) as Record<string, unknown>[];
        for (const r of recs) {
          const cid = m2oId(r.company_id);
          if (typeof r.id === 'number' && cid != null) companyByRo.set(r.id, cid);
        }
      }
    } catch (e) {
      comments = [];
      stageMsgs = [];
      notes.push(`Chatter posts and stage moves read 0 — the repair orders behind them could not be checked for company or historical status: ${errText(e)}`);
    }
  }

  // Message authors are PARTNERS; the roster is keyed on users.
  const userByPartner = new Map<number, { id: number; name: string }>();
  const partnerIds = [...new Set([...comments, ...stageMsgs]
    .map((m) => m2oId(m.author_id))
    .filter((x): x is number => x != null))];
  if (partnerIds.length) {
    try {
      for (const chunk of idChunks(partnerIds)) {
        const users = (await call('res.users', 'search_read', [[
          ['partner_id', 'in', chunk],
        ] as OdooDomain], { fields: ['partner_id', 'name'], limit: 0 })) as Record<string, unknown>[];
        for (const u of users) {
          const pid = m2oId(u.partner_id);
          if (pid != null && typeof u.id === 'number') {
            userByPartner.set(pid, { id: u.id, name: (u.name as string) || `#${u.id}` });
          }
        }
      }
    } catch (e) {
      notes.push(`Chatter authors could not be matched to Odoo users, so chatter posts and stage moves read 0: ${errText(e)}`);
    }
  }

  const creditMessages = (msgs: Msg[], key: 'chatterPosts' | 'stageMoves'): number => {
    let skipped = 0;
    for (const m of msgs) {
      const pid = m2oId(m.author_id);
      const user = pid != null ? userByPartner.get(pid) : undefined;
      const cid = m.res_id != null ? companyByRo.get(m.res_id) : undefined;
      if (!user || cid == null) { skipped++; continue; }
      credit(user.id, user.name, key, 1, cid);
    }
    return skipped;
  };
  const skippedComments = creditMessages(comments, 'chatterPosts');
  const skippedStage = creditMessages(stageMsgs, 'stageMoves');
  if (skippedComments || skippedStage) {
    notes.push(`Not counted: ${skippedComments} comment(s) and ${skippedStage} stage move(s) — the author is not an Odoo user, or the order is historical or outside the tracked companies.`);
  }

  // 5 ── Job title and department, if this instance has HR at all. Optional by
  // design: the suggestion stands on the activity counts alone.
  const userIds = [...tally.keys()];
  const jobByUser = new Map<number, { jobTitle: string | null; department: string | null }>();
  if (userIds.length) {
    try {
      const meta = (await call('hr.employee', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
      const hasField = (f: string) => Object.prototype.hasOwnProperty.call(meta, f);
      if (!hasField('user_id')) throw new Error('hr.employee has no user_id to join on');
      // Ask only for the columns this instance has: requesting an absent field
      // fails the whole read.
      const fields = ['user_id', ...['job_title', 'department_id'].filter(hasField)];

      for (const chunk of idChunks(userIds)) {
        const emps = (await call('hr.employee', 'search_read', [[
          ['user_id', 'in', chunk],
        ] as OdooDomain], { fields, limit: 0 })) as Record<string, unknown>[];
        for (const emp of emps) {
          const uid = m2oId(emp.user_id);
          if (uid == null) continue;
          // A user can hold one employee record per company; first filled wins.
          const prev = jobByUser.get(uid);
          jobByUser.set(uid, {
            jobTitle: prev?.jobTitle ?? ((emp.job_title as string | false | undefined) || null),
            department: prev?.department ?? (m2oName(emp.department_id) || null),
          });
        }
      }
      notes.push(`hr.employee is available — job title or department found for ${jobByUser.size} of ${userIds.length} people.`);
    } catch (e) {
      notes.push(`Job titles were unavailable (hr.employee could not be read), so job title and department are blank: ${errText(e)}`);
    }
  }

  // Derive the two guesses. Branch: whichever carries the most activity, ties
  // broken on the branch order the dashboards already use, so the same evidence
  // always suggests the same branch. Section: raising an RO or a quotation is
  // advisor work — simple enough to explain, and the counts let a human overrule it.
  const people: RosterSuggestion[] = [];
  for (const [odooUserId, t] of tally) {
    const total = t.rosCreated + t.quotesCreated + t.stageMoves + t.chatterPosts;
    if (total <= 0) continue;
    let branch: string | null = null;
    let best = 0;
    for (const b of WORKSHOP_BRANCHES) {
      const n = t.branchCounts[b] ?? 0;
      if (n > best) { best = n; branch = b; }
    }
    const job = jobByUser.get(odooUserId);
    people.push({
      odooUserId,
      name: t.name,
      branch,
      section: t.rosCreated + t.quotesCreated > 0 ? 'advisor' : 'workshop',
      jobTitle: job?.jobTitle ?? null,
      department: job?.department ?? null,
      rosCreated: t.rosCreated,
      quotesCreated: t.quotesCreated,
      stageMoves: t.stageMoves,
      chatterPosts: t.chatterPosts,
      branchCounts: t.branchCounts,
    });
  }

  const totalOf = (p: RosterSuggestion) => p.rosCreated + p.quotesCreated + p.stageMoves + p.chatterPosts;
  people.sort((a, b) => totalOf(b) - totalOf(a) || a.name.localeCompare(b.name));

  const advisors = people.filter((p) => p.section === 'advisor').length;
  const unplaced = people.filter((p) => !p.branch).length;
  notes.unshift(`${people.length} people were active in the last ${ROSTER_DAYS} days`
    + ` — ${advisors} look like Service Advisors (they created a repair order or a quotation),`
    + ` ${people.length - advisors} like Workshop`
    + `${unplaced ? `; ${unplaced} could not be placed in a branch` : ''}.`);

  return { people, notes };
}
