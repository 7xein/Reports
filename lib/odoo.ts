/**
 * Odoo JSON-RPC client for EVS WIP report data extraction.
 *
 * Authenticates via API key and runs read_group / search_count queries
 * that mirror the 7 saved-filter definitions used in the Odoo UI.
 *
 * Environment variables (set in Vercel):
 *   ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY
 */

import type { WipMetricKey, Branch, KpiConfig, StageSelector, KpiOwners } from './types';
import {
  BRANCHES, WORKSHOP_BRANCHES, KPI_BRANCHES, MAIN_STATION, subKey, SUB_BRANCH_COMPANY, resolveAgeField,
  KPI_OWNER_FLOOR, KPI_OWNER_WINDOW_DAYS,
} from './types';

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
export function companyIdFor(map: Record<string, number>, name: string): number | undefined {
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

/**
 * The one Odoo company that is a branch's own workshop — not its stations.
 *
 * Two shapes to cover: a branch with stations names its own site under
 * MAIN_STATION, while a branch without them has exactly one company and that is
 * the main one. Named here rather than inlined because "the main company" is
 * only self-evident for the branches that have stations to be the main one of.
 */
export function mainCompanyFor(branch: Branch): string | undefined {
  return SUB_BRANCH_COMPANY[branch]?.[MAIN_STATION] ?? BRANCH_CLUSTERS[branch]?.[0];
}

/**
 * Odoo id of a branch's main company, or undefined when that name no longer
 * resolves. Resolution and degradation match branchCompanyIds: the relaxed
 * companyIdFor match, a warning naming the company, and a drop rather than a
 * throw — one renamed company costs that branch its score instead of failing
 * the whole report.
 */
export async function mainCompanyIdFor(branch: Branch): Promise<number | undefined> {
  const name = mainCompanyFor(branch);
  if (!name) { console.warn(`⚠ Branch "${branch}" has no main company configured`); return undefined; }
  const map = await getCompanyIds();
  const id = companyIdFor(map, name);
  if (!id) console.warn(`⚠ Company "${name}" not found in Odoo`);
  return id;
}

/**
 * The company ids the KPI section scores: the five UAE main branches, stations
 * and Qatar and EV Hub excluded. Sequential on purpose — getCompanyIds caches
 * after the first call, so this costs one res.company read, not five.
 */
export async function kpiCompanyIds(): Promise<number[]> {
  const ids: number[] = [];
  for (const b of KPI_BRANCHES) {
    const id = await mainCompanyIdFor(b);
    if (id != null) ids.push(id);
  }
  return ids;
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
export const DOM_REPAIRED_NOT_INVOICED: OdooDomain   = [['state', '=', 'done'], ['priority_matrix_status', '!=', 'X']];

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

/**
 * How many repair orders each branch has parked in "Historical Orders".
 *
 * Every other read excludes them, so a page that shows open work can say how
 * much it is not showing. That makes it a caveat line, never the report itself:
 * an empty notHistorical() means the field does not exist on this instance, and
 * any failure reads as zero, because no count of parked orders is worth failing
 * a report over.
 */
export async function historicalRepairCounts(): Promise<Record<Branch, number>> {
  const zeros = () => {
    const out = {} as Record<Branch, number>;
    for (const branch of BRANCHES) out[branch] = 0;
    return out;
  };

  try {
    if (!(await notHistorical()).length) return zeros();

    const trackedIds = await allTrackedCompanyIds();
    const groups: ReadGroupResult[] = await call('repair.order', 'read_group', [[
      [HISTORICAL_FIELD, '=', true],
      ['company_id', 'in', trackedIds],
    ] as OdooDomain], {
      fields: ['company_id'],
      groupby: ['company_id'],
      lazy: true,
    });

    const perCompanyId: Record<number, number> = {};
    for (const g of groups) {
      const cid = g.company_id?.[0];
      if (cid) perCompanyId[cid] = (g.company_id_count ?? g.__count ?? 0) as number;
    }

    const out = zeros();
    for (const branch of BRANCHES) {
      const ids = await branchCompanyIds(branch);
      out[branch] = ids.reduce((sum, id) => sum + (perCompanyId[id] ?? 0), 0);
    }
    return out;
  } catch {
    return zeros();
  }
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
export function fmtGulfDate(raw: unknown): string {
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
 * string, so invoices to the Dubai main company, the Emarat stations, Almushrif
 * and EV HUB were all counted as outside revenue.
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
export async function excludeInternalSales(): Promise<OdooDomain> {
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
    hasStatusSince: boolean;
    hasDateLastStageUpdate: boolean;
    hasSaleOrderId: boolean;
    stageAgeField: string;   // what resolveAgeField() picks under Automatic on this instance
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

/**
 * Takes no config, deliberately. The one part of this report that needed the
 * saved stage mapping was the ownership map, and that has moved to its own route
 * — so the Admin page no longer reads the config store just to render its
 * dropdowns, and this call costs exactly what it did before the map existed.
 */
export async function fetchKpiOdooOptions(): Promise<KpiOdooOptions> {
  cachedUid = null;
  companyIdCache = null;

  // `store` and `readonly` are requested so the report below can tell a real
  // database column from a computed, non-stored field. Odoo's button-visibility
  // fields (the `repair_is_*` "Access" family) are computed per reading user, so
  // a KPI that filters on one is filtering on permissions, not on the record.
  const meta = (await call('repair.order', 'fields_get', [], {
    attributes: ['string', 'type', 'relation', 'selection', 'store', 'readonly'],
  })) as Record<string, { string?: string; type?: string; relation?: string; selection?: [string, string][]; store?: boolean; readonly?: boolean }>;
  const has = (f: string) => Object.prototype.hasOwnProperty.call(meta, f);
  // Whether this Odoo answered the `store` question at all. Checked once, across
  // every field, so the report can distinguish "nothing is computed" from "we
  // could not tell" — two readings that look identical field by field.
  const storeReported = Object.values(meta).some((m) => typeof m.store === 'boolean');

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

  // Purchasing chain: the three new workshop KPIs run from quotation approval →
  // RFQ → purchase order → parts received, and every one of those needs a field
  // name this instance actually uses. Discover rather than assume.
  try {
    const pm = (await call('purchase.order', 'fields_get', [], {
      attributes: ['string', 'type', 'relation', 'selection'],
    })) as Record<string, { string?: string; type?: string; relation?: string; selection?: [string, string][] }>;

    const vehicleFields = Object.entries(pm)
      .filter(([n, m]) => m.relation === 'fleet.vehicle' || /vehicle|fleet/i.test(n) || /vehicle/i.test(m.string ?? ''))
      .map(([n, m]) => `${n}${m.string ? ` (${m.string})` : ''} [${m.type}${m.relation ? ` → ${m.relation}` : ''}]`);
    notes.push(`purchase.order vehicle-ish fields: ${vehicleFields.join(' · ') || '(none)'}`);

    notes.push(`purchase.order state values: ${(pm.state?.selection ?? []).map(([v, l]) => `${v}=${l}`).join(', ') || '(none)'}`);

    const poDates = Object.entries(pm)
      .filter(([, m]) => m.type === 'date' || m.type === 'datetime')
      .map(([n, m]) => `${n}${m.string ? ` (${m.string})` : ''}`)
      .sort();
    notes.push(`purchase.order date fields: ${poDates.join(', ') || '(none)'}`);

    const since30po = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const poCount = (await call('purchase.order', 'search_count', [[['create_date', '>=', since30po]]])) as number;
    notes.push(`purchase orders created in the last 30 days: ${poCount}`);
  } catch (e) {
    notes.push(`⚠ purchase.order could not be read — the purchasing KPIs cannot work: ${e instanceof Error ? e.message : String(e)}`);
  }

  // What marks a repair order as "historical"? Orders moved to that tab must
  // stop counting, and a menu tab in Odoo is just a domain over the same model —
  // so something on the record has to carry the distinction.
  try {
    const flagged = Object.entries(meta)
      .filter(([n, m]) => /histor|archiv|legacy|old/i.test(n) || /histor|archiv|legacy|old/i.test(m.string ?? ''))
      .map(([n, m]) => `${n}${m.string ? ` (${m.string})` : ''} [${m.type}]`);
    notes.push(`Fields mentioning historical/archive/legacy: ${flagged.join(' · ') || '(none)'}`);

    // Annotate only the unusual ones (computed and/or readonly) so they stand out
    // in a long plain-text list; a stored writable boolean needs no tag.
    const booleans = Object.entries(meta)
      .filter(([, m]) => m.type === 'boolean')
      .map(([n, m]) => {
        const tags: string[] = [];
        if (m.store === false) tags.push('computed');
        if (m.readonly) tags.push('readonly');
        return `${n}${m.string ? ` (${m.string})` : ''}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
      });
    // Said once rather than tagged on every field: if this Odoo omits `store`
    // altogether, the absence of a [computed] tag means nothing, and a reader
    // would otherwise take silence for a clean bill of health.
    const legend = storeReported
      ? 'unannotated fields are stored and writable; [computed] means non-stored (derived per reading user)'
      : '⚠ this Odoo did not report the "store" attribute, so computed fields could NOT be identified here and the absence of a [computed] tag proves nothing';
    notes.push(`Boolean fields on repair.order: ${booleans.join(' · ') || '(none)'} — ${legend}.`);

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

  // A non-stored field has no column: Odoo recomputes it for whoever reads it, so
  // for the `repair_is_*` "Access" family the value is the integration user's
  // button permission, not a fact about this repair order. KPI 13 filters its
  // population on repair_is_qa, so if that field is computed the population is
  // "everything" or "nothing" depending on our login — and advisors get fined on it.
  // Three states, not two. `store === undefined` means this Odoo did not answer
  // the question, which is not the same as "stored" — and reporting the
  // comforting reading of an unanswered question is the exact habit this whole
  // diagnostic exists to break.
  const storageOf = (f: string) => {
    const s = meta[f]?.store;
    return s === false ? 'computed (NOT stored)' : s === true ? 'stored' : 'storage UNKNOWN — Odoo did not report it';
  };
  notes.push(`Customer follow-up field: ${followUpField ? `${followUpField} — ${storageOf(followUpField)}` : 'NOT FOUND on repair.order'}`
    + `; QA-eligibility flag: ${has('repair_is_qa') ? `repair_is_qa — ${storageOf('repair_is_qa')}` : 'not present (all repaired ROs will be counted)'}`);
  if (has('repair_is_qa') && meta.repair_is_qa?.store === false) {
    notes.push("⚠ repair_is_qa is computed, not stored — it is a button-access field, so it reflects whether the user we log in as may press QA, not whether this repair order was ever QA'd. KPI 13's population is therefore governed by our permissions and will include either every RO or none of them. Do not score KPI 13 until it filters on a stored field that records the QA step.");
  }
  if (followUpField && meta[followUpField]?.store === false) {
    notes.push(`⚠ ${followUpField} is computed, not stored — its value is derived for the reading user rather than saved on the record, so the follow-up screenshot check cannot be trusted either. KPI 13 should not be scored until it reads a stored field.`);
  }
  // An unanswered question is not a clean answer: without `store` we cannot tell
  // a real column from a button-permission field, so the question stays open
  // rather than being quietly resolved in KPI 13's favour.
  if (has('repair_is_qa') && !storeReported) {
    notes.push('⚠ Could not determine whether repair_is_qa is a stored field or a computed button-access one, because this Odoo did not report the "store" attribute. Until that is checked directly in Odoo (Settings → Technical → Fields → repair.order → repair_is_qa), treat KPI 13 as unverified: if the field is computed it reflects our login\'s permissions rather than anything the advisor did.');
  }

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

  // The field report cannot see the saved ageBasis, so it describes the Automatic
  // setting — resolved through the same helper the KPI engine uses, so this note
  // cannot drift away from what the dashboard actually measures.
  const hasDateLastStageUpdate = has('date_last_stage_update');
  const stageAgeField = resolveAgeField(has);
  const AGE_NOTE: Record<string, string> = {
    status_since: 'Under Automatic, awaiting parts/labour age from status_since — how long the vehicle has been in its current status.',
    date_last_stage_update: 'Under Automatic, awaiting parts/labour age from date_last_stage_update — time since the last stage change.',
    create_date: 'Under Automatic, awaiting parts/labour fall back to create_date, i.e. the age of the RO itself, because neither status_since nor date_last_stage_update exists on this instance.',
  };
  notes.push(AGE_NOTE[stageAgeField] ?? `Under Automatic, awaiting parts/labour age from ${stageAgeField}.`);

  // NOT the ownership map. It used to run here and cost this request 28-36 extra
  // Odoo calls against a 60-second limit, on EVERY Admin page load — the page the
  // owner configures everything from, including the thresholds the KPI engine
  // reads. It now lives behind its own button on its own 300-second route
  // (app/api/kpi/role-proposal, the ownership refresh), so it is paid for when it is asked for and a
  // slow Odoo can no longer take the Admin page down with it.

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
      hasStatusSince: has('status_since'),
      hasDateLastStageUpdate,
      hasSaleOrderId: has('sale_order_id'),
      stageAgeField,
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

// ── KPI ownership: who actually performs each KPI-bearing action ───
/**
 * The owner's question is not "which of two buckets does this KPI sit in" but
 * "whose hands do this work": Mohammed Ansari raises Dubai's RFQs, so KPI 18 is
 * his — and if anyone else raises one, it is theirs too. That makes ownership
 * SET-valued, per branch and per action, which neither `section` (two buckets,
 * advisor/workshop) nor `rfqCoordinators` (exactly one person per branch) can
 * express.
 *
 * What follows measures that from Odoo, reading only. Two things are built on
 * top: the derived KpiOwners (fetchKpiOwners, at the bottom of this file), which
 * the KPI engine scores people by, and the plain-text diagnostic that travels
 * with it as its evidence.
 *
 * It does NOT run on the Admin page load. It used to, inside
 * fetchKpiOdooOptions, and 28-36 Odoo calls against that route's 60-second limit
 * is why this was never deployed — a slow Odoo would have taken down the page
 * the owner configures everything from. It has its own route and its own
 * 300-second limit (app/api/kpi/role-proposal, now the ownership refresh) and
 * runs nightly from the sync cron.
 */

/**
 * Both windows are KPI_OWNER_WINDOW_DAYS, so the count and the floor it is
 * compared against (KPI_OWNER_FLOOR) always cover the same period. They used to
 * differ — 90 days for create stamps, 30 for chatter — and a floor measured
 * against two different windows means two different things.
 */
const OWNERSHIP_DIRECT_DAYS = KPI_OWNER_WINDOW_DAYS;
/** Chatter-derived evidence. Narrowed to OWNERSHIP_CHATTER_DAYS_NARROW on a busy model, and then it is NOT comparable with the floor. */
const OWNERSHIP_CHATTER_DAYS = KPI_OWNER_WINDOW_DAYS;
/** Used where a model has too many touched records for the window above to be affordable. */
const OWNERSHIP_CHATTER_DAYS_NARROW = 7;
/** Most records whose branch we will resolve per model. Beyond this the window narrows, then the bucket is dropped with a note. */
const OWNERSHIP_RECORD_CAP = 12_000;
/** Hard ceiling on rows read per transition. Hitting it is reported, never swallowed. */
const OWNERSHIP_MSG_CAP = 20_000;
/** Names printed per bucket before the remainder becomes "+N more". */
const OWNERSHIP_NAME_CAP = 8;
/**
 * Default wall-clock budget for the whole ownership map, for a caller that does
 * not state its own: deliberately short, because a caller that has not thought
 * about the budget is a caller sharing a request with something else.
 *
 * The map stops early and SAYS it stopped, naming the buckets it never reached,
 * rather than letting the request die with nothing in it. The dedicated route
 * passes its own, larger budget instead.
 */
const OWNERSHIP_BUDGET_MS = 25_000;

/** The fields_get shape this section passes around — the same one fetchKpiOdooOptions reads. */
type OwnershipFieldMeta = Record<string, {
  string?: string; type?: string; relation?: string; selection?: [string, string][]; store?: boolean; readonly?: boolean;
}>;

/** actor id → their display name and the per-branch split of their activity. */
export type OwnershipActors = Map<number, { name: string; byBranch: Map<string, number> }>;

/**
 * One activity bucket: the action, the KPIs it owns, and the evidence behind it.
 *
 * `unavailable` is the whole point of the shape. A bucket nobody performed and a
 * bucket we could not measure look identical once both are empty, and this
 * codebase's rule is that they must never read the same — so an unmeasurable
 * bucket carries its reason and is printed as a warning rather than as silence.
 */
export interface OwnershipBucket {
  label: string;
  kpis: number[];
  /** 'user' → keyed by res.users id; 'partner' → a chatter author, keyed by res.partner id. */
  actorKind: 'user' | 'partner';
  /** Days of history this bucket covers — printed on every line, because they differ. */
  days: number;
  /** Exactly what was queried and how it was attributed. */
  method: string;
  /** Non-null when the bucket could not be populated at all, holding the reason. */
  unavailable: string | null;
  actors: OwnershipActors;
  /** Matched activity on a record belonging to no KPI branch. */
  outOfScope: number;
  /** Matched activity whose author resolves to no Odoo user. */
  nonUser: number;
  /** True when a read hit OWNERSHIP_MSG_CAP, i.e. the counts are floors. */
  truncated: boolean;
}

/**
 * Thrown to jump from "there is no chatter route here" to the stamp fallback
 * without inventing an error message for a read that was never attempted.
 */
class OwnershipSkip extends Error {}

/** "KPIs 2, 3, 4" / "KPI 18". */
function kpiTag(ids: number[]): string {
  if (!ids.length) return 'no KPI';
  return `${ids.length === 1 ? 'KPI' : 'KPIs'} ${ids.join(', ')}`;
}

/**
 * A stage selector → the (field, labels) pair Odoo's change log records.
 *
 * This is lib/kpi.ts's `trackedField`, re-stated rather than imported: kpi.ts
 * imports THIS module, so the dependency runs one way only, and exporting it
 * from there would mean editing the scoring engine for a diagnostic. The two
 * must stay in step — the chatter stores the human LABEL of what changed, so a
 * selection field resolves through its selection list and stage_id through stage
 * names, which is why stageNames has to be resolved before this is called.
 */
function ownershipTrackedField(
  sel: StageSelector | undefined,
  meta: OwnershipFieldMeta,
  stageNames: Record<number, string>,
): { field: string; labels: string[] } | null {
  if (!sel || !sel.values?.length) return null;
  if (sel.kind === 'stage') {
    if (!meta.stage_id) return null;
    const labels = sel.values.map((v) => stageNames[Number(v)]).filter((x): x is string => !!x);
    return labels.length ? { field: 'stage_id', labels } : null;
  }
  const field = sel.kind === 'state' ? 'state'
    : sel.kind === 'repairState' ? 'repair_state'
    : sel.kind === 'priority' ? 'priority_matrix_status'
    : null;
  if (!field) return null;
  const options = meta[field]?.selection ?? [];
  const labels = sel.values
    .map((v) => options.find(([code]) => code === String(v))?.[1])
    .filter((x): x is string => !!x);
  return labels.length ? { field, labels } : null;
}

/** The canonical bucket order — the order the report prints and the proposal walks. */
const OWNERSHIP_ORDER = [
  'opensJobCards', 'movesToInspection', 'writesQuotations', 'confirmsQuotations',
  'raisesRfqs', 'confirmsPos', 'receivesParts', 'movesThroughQa', 'marksRepaired',
  'postsInvoices', 'uploadsFollowUp',
] as const;

/** One of the eleven activity buckets, by its stable key. */
export type OwnershipBucketKey = typeof OWNERSHIP_ORDER[number];

/**
 * The KPIs each action makes a person answer for. The single source: the
 * collector below stamps these onto its buckets, and the owner derivation reads
 * them even for a bucket that was never reached.
 *
 *  - KPI 13 (Customer follow-up) is always whoever opened the repair order —
 *    the owner's rule — so it rides on opensJobCards, and uploadsFollowUp maps
 *    to no KPI at all (still measured, for the diagnostic).
 *  - KPIs 20 (Parts placed) and 6 (Awaiting parts) sit on receivesParts: the
 *    receipt is the only point in the parts chain where a person is recorded.
 */
export const OWNERSHIP_BUCKET_KPIS: Record<OwnershipBucketKey, readonly number[]> = {
  opensJobCards: [5, 8, 13],
  movesToInspection: [14, 15],
  writesQuotations: [12, 21],
  confirmsQuotations: [2, 3, 4],
  raisesRfqs: [18],
  confirmsPos: [19],
  receivesParts: [20, 6],
  movesThroughQa: [16],
  marksRepaired: [22],
  postsInvoices: [1, 11],
  uploadsFollowUp: [],
};
const bucketKpis = (key: OwnershipBucketKey): number[] => [...OWNERSHIP_BUCKET_KPIS[key]];

/** A bucket carrying its own key, so a consumer can map it to its KPIs. */
export interface OwnershipBucketEntry extends OwnershipBucket {
  key: OwnershipBucketKey;
}

/**
 * The measured activity map: eleven buckets, each either populated or carrying
 * the reason it is not.
 *
 * Returned as data rather than as text because two very different consumers read
 * it — the KPI owner derivation, and the plain-text diagnostic below
 * — and only one of them can use a sentence.
 */
export interface KpiOwnershipMap {
  /** Every bucket that was set, in OWNERSHIP_ORDER. */
  ordered: OwnershipBucketEntry[];
  /** Bucket keys that were never set at all: UNKNOWN, and never to be read as empty. */
  neverReached: string[];
  /** Branches whose company resolved, i.e. the ones any of this can speak about. */
  inScopeBranches: Branch[];
  /** KPI branches left out because their company did not resolve — blank, not idle. */
  missingBranches: Branch[];
  /** Global caveats about the tracking table and the field-id lookup. */
  noteTracking: string[];
  /**
   * Non-null when chatter authors could NOT be matched to Odoo users.
   *
   * Decisive for anything keyed on a user id. The chatter buckets then still
   * hold their counts, but keyed on res.partner rather than res.users — good
   * enough to print a name beside, and useless for writing a roster entry,
   * because a partner id is a different person's user id. A consumer that keys
   * on users must treat every `actorKind: 'partner'` bucket as unreadable.
   */
  partnerLookupFailed: string | null;
  /** True when the wall-clock budget ran out, so some buckets say they were never read. */
  budgetSpent: boolean;
  /** The budget this run was given, in ms — printed, because it differs per caller. */
  budgetMs: number;
  /** Non-null when nothing could be measured at all; every other field is then empty. */
  fatal: string | null;
}

/**
 * Per-branch, per-action ownership, measured from Odoo.
 *
 * Reads only. Every bucket is wrapped in its own try/catch and announces its own
 * failure, so one unreadable model costs one bucket and nothing else; the
 * wall-clock budget stops the run early rather than letting the request time
 * out, and names the buckets it never reached.
 *
 * The meta, stage names and tracked-change counts are passed in so a caller that
 * has already paid for them does not pay twice; `fetchKpiOwners` reads its
 * own because it is the only thing in its request.
 */
export async function collectKpiOwnership(args: {
  /**
   * The LIVE config, read from the store. Never DEFAULT_KPI_CONFIG: the shipped
   * defaults map `repaired` onto priority_matrix_status, which carries no
   * tracked changes on this instance, so assuming them would report that nobody
   * marks cars repaired.
   */
  config: KpiConfig | null;
  repairMeta: OwnershipFieldMeta;
  stageNames: Record<number, string>;
  /** Tracked chatter changes per repair.order field, last 30 days, as the field report measured them. -1 means that probe errored. */
  trackCounts: Record<string, number>;
  /**
   * Wall-clock budget. Defaults to the 25 seconds the map was written for when it
   * shared a 60-second Admin request; the dedicated route passes its own, larger
   * one, because there it is the only thing in the request.
   */
  budgetMs?: number;
}): Promise<KpiOwnershipMap> {
  const { config, repairMeta, stageNames, trackCounts } = args;
  const budgetMs = args.budgetMs ?? OWNERSHIP_BUDGET_MS;
  /** Nothing measurable: the one shape where every other field is meaningless. */
  const fatal = (why: string): KpiOwnershipMap => ({
    ordered: [], neverReached: [...OWNERSHIP_ORDER], inScopeBranches: [], missingBranches: [...KPI_BRANCHES],
    noteTracking: [], partnerLookupFailed: null, budgetSpent: false, budgetMs, fatal: why,
  });
  const deadline = Date.now() + budgetMs;
  const budgetLeft = () => Date.now() < deadline;
  const sinceIso = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const hasRepairField = (f: string) => Object.prototype.hasOwnProperty.call(repairMeta, f);

  // ── Scope: the five KPI branches' own workshops ──────────────────
  // KPI_BRANCHES, and each branch's MAIN company rather than its whole cluster:
  // that is exactly the population the KPI section scores, so ownership read
  // over any wider set would credit people for work no KPI ever judges.
  const branchOfCompany = new Map<number, Branch>();
  try {
    for (const b of KPI_BRANCHES) {
      const id = await mainCompanyIdFor(b);
      if (id != null) branchOfCompany.set(id, b);
    }
  } catch (e) {
    return fatal(`⚠ KPI ownership map could not run — the branch companies did not resolve in Odoo: ${errText(e)}`);
  }
  const scopeIds = [...branchOfCompany.keys()];
  if (!scopeIds.length) {
    return fatal('⚠ KPI ownership map could not run — none of the five KPI branches resolved to an Odoo company, so no activity can be attributed to anyone.');
  }
  const inScopeBranches = new Set<string>([...branchOfCompany.values()]);
  const missingBranches = KPI_BRANCHES.filter((b) => !inScopeBranches.has(b));

  // ── Tracking-value shape: how this Odoo names the field that changed ──
  // Odoo 17 links it by id (field_id), older versions store the technical name
  // in `field`. Both shapes are already handled in fetchRosterSuggestion and in
  // lib/kpi.ts; getting it wrong silently matches nothing, so it is resolved
  // once, up front, for every (model, field) the buckets below ask about.
  const noteTracking: string[] = [];
  let tvRef: 'field_id' | 'field' = 'field';
  let tvRefUsable = true;
  const tvFieldId = new Map<string, number>();
  try {
    const tvMeta = (await call('mail.tracking.value', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
    tvRef = Object.prototype.hasOwnProperty.call(tvMeta, 'field_id') ? 'field_id' : 'field';
  } catch (e) {
    tvRefUsable = false;
    noteTracking.push(`⚠ mail.tracking.value could not be read, so every chatter-derived ownership bucket is unavailable: ${errText(e)}`);
  }

  const fieldIdsAsked = new Set<string>();
  /** Look up ir.model.fields ids for tracked fields, once per (model, field). */
  const resolveFieldIds = async (pairs: { model: string; field: string }[]): Promise<void> => {
    if (tvRef !== 'field_id') return;
    const wanted = pairs.filter((p) => !fieldIdsAsked.has(`${p.model}.${p.field}`));
    if (!wanted.length) return;
    for (const p of wanted) fieldIdsAsked.add(`${p.model}.${p.field}`);
    const frs = (await call('ir.model.fields', 'search_read', [[
      ['model', 'in', [...new Set(wanted.map((p) => p.model))]],
      ['name', 'in', [...new Set(wanted.map((p) => p.field))]],
    ] as OdooDomain], { fields: ['model', 'name'], limit: 0 })) as { id: number; model: string; name: string }[];
    for (const f of frs) tvFieldId.set(`${f.model}.${f.name}`, f.id);
  };
  /** The domain leaf matching "this message records a change of <model>.<field>". */
  const tvLeaf = (model: string, field: string): [string, string, unknown] | null => {
    if (tvRef === 'field') return ['tracking_value_ids.field', '=', field];
    const id = tvFieldId.get(`${model}.${field}`);
    return id == null ? null : ['tracking_value_ids.field_id', '=', id];
  };

  // ── Per-model metadata, read once each ──────────────────────────
  const metaCache = new Map<string, OwnershipFieldMeta | null>([['repair.order', repairMeta]]);
  const modelMeta = async (model: string): Promise<OwnershipFieldMeta | null> => {
    if (metaCache.has(model)) return metaCache.get(model) ?? null;
    let m: OwnershipFieldMeta | null = null;
    try {
      m = (await call(model, 'fields_get', [], { attributes: ['string', 'type', 'relation', 'selection', 'store'] })) as OwnershipFieldMeta;
    } catch { m = null; }
    metaCache.set(model, m);
    return m;
  };
  const selectionLabel = (meta: OwnershipFieldMeta, field: string, code: string): string | null =>
    (meta[field]?.selection ?? []).find(([v]) => v === code)?.[1] ?? null;

  /**
   * Is this label unambiguous on this model?
   *
   * The chatter lookup asks for a message that records a change of field F and
   * holds the label L. Those are two conditions on the same list of changes, so
   * a message that changed F *and* changed some other tracked field to a value
   * also labelled L would match wrongly. That needs two fields on one model to
   * share a label — rare, but silently crediting the wrong person with a KPI is
   * exactly what this report exists to prevent, so it is checked and reported
   * rather than assumed away.
   */
  const labelIsAmbiguous = (meta: OwnershipFieldMeta, field: string, label: string): boolean =>
    Object.entries(meta).some(([name, m]) => name !== field && (m.selection ?? []).some(([, l]) => l === label));

  // ── Shared readers ──────────────────────────────────────────────
  const blank = (): OwnershipActors => new Map();
  const creditActor = (actors: OwnershipActors, id: number, name: string, branch: string, n: number) => {
    let a = actors.get(id);
    if (!a) { a = { name: name || `#${id}`, byBranch: new Map() }; actors.set(id, a); }
    else if (name && a.name.startsWith('#')) a.name = name;
    a.byBranch.set(branch, (a.byBranch.get(branch) ?? 0) + n);
  };

  /**
   * Actors from one read_group over a create/write stamp and company_id — the
   * cheapest shape there is: Odoo aggregates and we read one row per
   * (person, company), so the cost does not grow with the number of records.
   */
  const actorsByStamp = async (
    model: string, domain: OdooDomain, stamp: 'create_uid' | 'write_uid',
  ): Promise<{ actors: OwnershipActors; outOfScope: number }> => {
    const actors = blank();
    let outOfScope = 0;
    const groups = (await call(model, 'read_group', [domain], {
      fields: [stamp, 'company_id'], groupby: [stamp, 'company_id'], lazy: false,
    })) as ReadGroupResult[];
    for (const g of groups) {
      const n = (g.__count ?? 0) as number;
      const uid = m2oId(g[stamp]);
      if (uid == null || n <= 0) continue;
      const cid = m2oId(g.company_id);
      const branch = cid != null ? branchOfCompany.get(cid) : undefined;
      if (!branch) { outOfScope += n; continue; }
      creditActor(actors, uid, m2oName(g[stamp]), branch, n);
    }
    return { actors, outOfScope };
  };

  /**
   * record id → branch, for every in-scope record this model could have been
   * changed on inside the window.
   *
   * `write_date >= since` is a deliberate SUPERSET: a tracked change writes the
   * record, so anything that transitioned inside the window carries a write_date
   * at or after that transition. It is the one filter keeping historical job
   * cards and other companies' records out of the chatter buckets, and it is
   * also where each change's branch comes from.
   */
  const branchByRecord = async (
    model: string, extra: OdooDomain,
  ): Promise<{ map: Map<number, Branch>; days: number; note: string | null }> => {
    let days = OWNERSHIP_CHATTER_DAYS;
    for (;;) {
      const recs = (await call(model, 'search_read', [[
        ['company_id', 'in', scopeIds],
        ['write_date', '>=', sinceIso(days)],
        ...extra,
      ] as OdooDomain], { fields: ['company_id'], limit: OWNERSHIP_RECORD_CAP + 1 })) as Record<string, unknown>[];
      if (recs.length > OWNERSHIP_RECORD_CAP) {
        // Too many to resolve inside an Admin request. Narrow once, then give up
        // loudly — a half-read branch map would quietly under-report everyone.
        if (days > OWNERSHIP_CHATTER_DAYS_NARROW) { days = OWNERSHIP_CHATTER_DAYS_NARROW; continue; }
        return { map: new Map(), days, note: `more than ${OWNERSHIP_RECORD_CAP} ${model} records were touched in ${days} days, which is more than one Admin request can resolve to branches` };
      }
      const map = new Map<number, Branch>();
      for (const r of recs) {
        const cid = m2oId(r.company_id);
        const branch = cid != null ? branchOfCompany.get(cid) : undefined;
        if (typeof r.id === 'number' && branch) map.set(r.id, branch);
      }
      return { map, days, note: null };
    }
  };

  /**
   * Chatter authors of a transition INTO one of `labels` on `model.field`.
   *
   * Attributed to mail.message.author_id — whom Odoo records as having posted
   * the change — resolved to a user further down, archived accounts included, so
   * an ex-employee still shows up by name instead of vanishing.
   */
  const actorsByChatter = async (
    model: string, field: string, labels: string[], branchOf: Map<number, Branch>, days: number,
  ): Promise<{ actors: OwnershipActors; outOfScope: number; noAuthor: number; truncated: boolean; matched: number }> => {
    const actors = blank();
    let outOfScope = 0;
    let noAuthor = 0;
    let truncated = false;
    let matched = 0;
    const leaf = tvLeaf(model, field);
    if (!leaf) throw new Error(`${model}.${field} is not a field this Odoo records changes of`);
    for (const label of labels) {
      const msgs = (await call('mail.message', 'search_read', [[
        ['model', '=', model],
        ['date', '>=', sinceIso(days)],
        leaf,
        ['tracking_value_ids.new_value_char', '=', label],
      ] as OdooDomain], { fields: ['author_id', 'res_id'], limit: OWNERSHIP_MSG_CAP })) as Record<string, unknown>[];
      if (msgs.length >= OWNERSHIP_MSG_CAP) truncated = true;
      for (const m of msgs) {
        matched++;
        const pid = m2oId(m.author_id);
        const rid = typeof m.res_id === 'number' ? m.res_id : null;
        const branch = rid != null ? branchOf.get(rid) : undefined;
        // Two different exclusions, counted apart: a change on a record that is
        // not ours, and a change Odoo attributes to nobody at all. Lumping them
        // together would report the second as the first and hide it.
        if (pid == null) { noAuthor++; continue; }
        if (!branch) { outOfScope++; continue; }
        creditActor(actors, pid, m2oName(m.author_id), branch, 1);
      }
      if (!budgetLeft()) break;
    }
    return { actors, outOfScope, noAuthor, truncated, matched };
  };

  // ── The buckets ─────────────────────────────────────────────────
  const buckets = new Map<string, OwnershipBucket>();
  const emptyBucket = (
    label: string, kpis: number[], actorKind: 'user' | 'partner', days: number, method: string, unavailable: string | null,
  ): OwnershipBucket => ({ label, kpis, actorKind, days, method, unavailable, actors: blank(), outOfScope: 0, nonUser: 0, truncated: false });

  // Historical job cards must not count here either: the KPI engine excludes
  // them, so attributing their work would credit people for work no KPI judges.
  const liveOnly = await notHistorical();

  // Every tracked field the buckets below will ask about, resolved in ONE
  // ir.model.fields read instead of one per bucket. Four round trips saved out
  // of a 60-second request is worth the one extra line, and the per-bucket
  // lookups further down then find these already cached and skip.
  try {
    await resolveFieldIds([
      ...['state', 'repair_state', 'priority_matrix_status', 'stage_id'].map((field) => ({ model: 'repair.order', field })),
      ...['sale.order', 'purchase.order', 'account.move', 'stock.picking'].map((model) => ({ model, field: 'state' })),
    ]);
  } catch (e) {
    // Not fatal: each bucket re-asks for its own field and reports its own miss.
    noteTracking.push(`⚠ The one-shot lookup of tracked field ids failed, so some ownership buckets below may report that their field is not tracked: ${errText(e)}`);
  }

  /** The three create-stamped buckets, each one read_group and nothing more. */
  const directBuckets: { key: string; label: string; kpis: number[]; model: string; extra: OdooDomain; method: string }[] = [
    {
      key: 'opensJobCards', label: 'Opens job cards', kpis: bucketKpis('opensJobCards'), model: 'repair.order', extra: liveOnly,
      method: 'repair.order grouped by create_uid and company_id, Historical job cards excluded',
    },
    {
      key: 'writesQuotations', label: 'Writes quotations', kpis: bucketKpis('writesQuotations'), model: 'sale.order', extra: [],
      method: 'sale.order grouped by create_uid and company_id',
    },
    {
      // The bucket the owner's own example names, and the one rfqCoordinators can
      // hold only a single person per branch of.
      key: 'raisesRfqs', label: 'Raises RFQs', kpis: bucketKpis('raisesRfqs'), model: 'purchase.order', extra: [],
      method: 'purchase.order grouped by create_uid and company_id',
    },
  ];
  for (const d of directBuckets) {
    try {
      const { actors, outOfScope } = await actorsByStamp(d.model, [
        ['create_date', '>=', sinceIso(OWNERSHIP_DIRECT_DAYS)],
        ['company_id', 'in', scopeIds],
        ...d.extra,
      ], 'create_uid');
      buckets.set(d.key, { ...emptyBucket(d.label, d.kpis, 'user', OWNERSHIP_DIRECT_DAYS, d.method, null), actors, outOfScope });
    } catch (e) {
      buckets.set(d.key, emptyBucket(d.label, d.kpis, 'user', OWNERSHIP_DIRECT_DAYS, d.method,
        `${d.model} could not be grouped by creator: ${errText(e)}`));
    }
  }

  // ── The three repair.order stage-change buckets, from the LIVE mapping ──
  // One branch map and one field lookup serve all three.
  const repairChatter: { key: string; label: string; kpis: number[]; sel: StageSelector | undefined }[] = [
    { key: 'movesToInspection', label: 'Moves to Inspection', kpis: bucketKpis('movesToInspection'), sel: config?.stageMap?.inspection },
    { key: 'movesThroughQa', label: 'Moves through QA', kpis: bucketKpis('movesThroughQa'), sel: config?.stageMap?.qa },
    { key: 'marksRepaired', label: 'Marks Repaired', kpis: bucketKpis('marksRepaired'), sel: config?.stageMap?.repaired },
  ];
  if (!config || !tvRefUsable) {
    const why = !config
      ? 'the live KPI config was not passed to this report, so the stage mapping is unknown — reading the shipped defaults instead would point at priority_matrix_status, which records no changes on this instance'
      : 'mail.tracking.value is unreadable, so no stage change can be traced to its author';
    for (const c of repairChatter) {
      buckets.set(c.key, emptyBucket(c.label, c.kpis, 'partner', OWNERSHIP_CHATTER_DAYS, 'repair.order chatter', why));
    }
  } else {
    const resolved = repairChatter.map((c) => ({ ...c, tf: ownershipTrackedField(c.sel, repairMeta, stageNames) }));
    const fields = [...new Set(resolved.map((r) => r.tf?.field).filter((f): f is string => !!f))];
    try {
      await resolveFieldIds(fields.map((f) => ({ model: 'repair.order', field: f })));
    } catch (e) {
      noteTracking.push(`⚠ The tracked repair.order fields could not be looked up in ir.model.fields, so the stage-change buckets below may report nothing: ${errText(e)}`);
    }

    let roBranch: { map: Map<number, Branch>; days: number; note: string | null };
    try {
      roBranch = await branchByRecord('repair.order', liveOnly);
    } catch (e) {
      roBranch = { map: new Map(), days: OWNERSHIP_CHATTER_DAYS, note: `the in-scope repair orders could not be read: ${errText(e)}` };
    }

    for (const r of resolved) {
      const method = r.tf
        ? `chatter author of the change recording repair.order.${r.tf.field} → ${r.tf.labels.map((l) => `"${l}"`).join(' / ')}, taken from the live stage mapping`
        : 'repair.order chatter';
      if (!r.tf) {
        buckets.set(r.key, emptyBucket(r.label, r.kpis, 'partner', roBranch.days, method,
          `the live stage mapping for this stage is ${r.sel ? `kind "${r.sel.kind}" with ${r.sel.values.length} value(s), which does not resolve to a field the chatter records` : 'unset in Admin'}`));
        continue;
      }
      if (trackCounts[r.tf.field] === 0) {
        buckets.set(r.key, emptyBucket(r.label, r.kpis, 'partner', roBranch.days, method,
          `repair.order.${r.tf.field} carries NO tracked changes at all in the last 30 days, so Odoo holds no record of who moves anything through this stage`));
        continue;
      }
      if (roBranch.note) { buckets.set(r.key, emptyBucket(r.label, r.kpis, 'partner', roBranch.days, method, roBranch.note)); continue; }
      if (!budgetLeft()) {
        buckets.set(r.key, emptyBucket(r.label, r.kpis, 'partner', roBranch.days, method, 'the request ran out of its time budget before this bucket was read'));
        continue;
      }
      try {
        const res = await actorsByChatter('repair.order', r.tf.field, r.tf.labels, roBranch.map, roBranch.days);
        const ambiguous = r.tf.labels.filter((l) => labelIsAmbiguous(repairMeta, r.tf!.field, l));
        // Nothing at all came back. That is NOT "nobody does this": it means the
        // chatter holds no such transition in the window, so either the stage is
        // unused or the change is not being tracked — and a per-branch list of
        // "(nobody)" would read as the first when it could be the second.
        buckets.set(r.key, {
          ...emptyBucket(r.label, r.kpis, 'partner', roBranch.days,
            method + (ambiguous.length
              ? ` ⚠ the label${ambiguous.length === 1 ? '' : 's'} ${ambiguous.map((l) => `"${l}"`).join(' / ')} also appear${ambiguous.length === 1 ? 's' : ''} on another tracked field of repair.order, so a single change touching both at once could be counted here`
              : ''),
            res.matched > 0 ? null
              : `the chatter holds NO change into ${r.tf.labels.map((l) => `"${l}"`).join(' / ')} on repair.order.${r.tf.field} in the last ${roBranch.days} days, anywhere in Odoo — so either this stage is not used or the change is not tracked, and nobody can be credited either way`),
          actors: res.actors, outOfScope: res.outOfScope, nonUser: res.noAuthor, truncated: res.truncated,
        });
      } catch (e) {
        buckets.set(r.key, emptyBucket(r.label, r.kpis, 'partner', roBranch.days, method, `the chatter could not be read for this transition: ${errText(e)}`));
      }
    }
  }

  /**
   * A confirmation bucket on a model other than repair.order: the chatter author
   * of `state` → the label for `code`, with a stamp-based fallback for when the
   * chatter holds nothing at all.
   *
   * The fallback is never a silent substitution. It answers a DIFFERENT question
   * — "who last wrote this record" rather than "who confirmed it" — so which
   * route produced the names is printed alongside them.
   */
  const stateBucket = async (spec: {
    key: string; label: string; kpis: number[]; model: string; code: string;
    /** Extra clauses narrowing the records in scope (e.g. customer invoices only). */
    recordExtra: OdooDomain;
    /** The stamp and date field to fall back on, and what that stamp actually means. */
    fallback: { stamp: 'create_uid' | 'write_uid'; dateField: string; caveat: string } | null;
    /** Printed with the method, e.g. "customer invoices only". */
    scopeNote?: string;
  }): Promise<void> => {
    const { key, label, kpis, model, code, recordExtra, fallback, scopeNote } = spec;
    const bare = `${model}.state → ${code}${scopeNote ? `, ${scopeNote}` : ''}`;
    const meta = await modelMeta(model);
    if (!meta) {
      buckets.set(key, emptyBucket(label, kpis, 'partner', OWNERSHIP_CHATTER_DAYS, bare, `${model} could not be read on this instance, so this action is invisible here`));
      return;
    }
    const stateLabel = selectionLabel(meta, 'state', code);
    if (!stateLabel) {
      buckets.set(key, emptyBucket(label, kpis, 'partner', OWNERSHIP_CHATTER_DAYS, bare, `${model}.state has no "${code}" value on this instance, so the confirmation step itself cannot be identified`));
      return;
    }
    // An unreadable tracking table kills the chatter route for every model at
    // once. That is a reason to take the weaker route and SAY so, not a reason
    // to report the action as if nobody performed it — so it is handled as "the
    // chatter gave us nothing" rather than as an early exit.
    let chatterEmpty: string | null = tvRefUsable
      ? null
      : 'mail.tracking.value is unreadable, so no confirmation could be traced to its author';
    if (!chatterEmpty) {
      try { await resolveFieldIds([{ model, field: 'state' }]); } catch { /* tvLeaf then returns null and actorsByChatter says so */ }
    }

    let recs: { map: Map<number, Branch>; days: number; note: string | null } =
      { map: new Map(), days: OWNERSHIP_CHATTER_DAYS, note: null };
    const method = `chatter author of the change recording ${model}.state → "${stateLabel}"${scopeNote ? `, ${scopeNote}` : ''}`;
    if (!chatterEmpty) {
      try {
        recs = await branchByRecord(model, recordExtra);
      } catch (e) {
        recs = { map: new Map(), days: OWNERSHIP_CHATTER_DAYS, note: `the in-scope ${model} records could not be read: ${errText(e)}` };
      }
      if (recs.note) { buckets.set(key, emptyBucket(label, kpis, 'partner', recs.days, method, recs.note)); return; }
      if (!budgetLeft()) {
        buckets.set(key, emptyBucket(label, kpis, 'partner', recs.days, method, 'the request ran out of its time budget before this bucket was read'));
        return;
      }
    }

    try {
      if (chatterEmpty) throw new OwnershipSkip();   // straight to the fallback, with the reason already set
      const res = await actorsByChatter(model, 'state', [stateLabel], recs.map, recs.days);
      if (res.matched > 0) {
        const ambiguous = labelIsAmbiguous(meta, 'state', stateLabel);
        buckets.set(key, {
          ...emptyBucket(label, kpis, 'partner', recs.days,
            method + (ambiguous ? ` ⚠ "${stateLabel}" also labels a value on another tracked field of ${model}, so a single change touching both at once could be counted here` : ''), null),
          actors: res.actors, outOfScope: res.outOfScope, nonUser: res.noAuthor, truncated: res.truncated,
        });
        return;
      }
      chatterEmpty = `${model}.state records no change into "${stateLabel}" in the last ${recs.days} days`;
    } catch (e) {
      // OwnershipSkip means we never tried and the reason is already in
      // chatterEmpty; anything else is a real read failure worth quoting.
      if (!(e instanceof OwnershipSkip)) {
        chatterEmpty = `the chatter could not be read for ${model}.state → "${stateLabel}": ${errText(e)}`;
      }
    }

    // The chatter yielded nothing. Fall back to a write stamp if one was offered,
    // and say in the same breath that it is the weaker answer.
    if (!fallback || !Object.prototype.hasOwnProperty.call(meta, fallback.dateField)) {
      buckets.set(key, emptyBucket(label, kpis, 'partner', recs.days, method,
        `${chatterEmpty}${fallback ? `, and ${model}.${fallback.dateField} does not exist here either, so there is no fallback left` : ', and no fallback stamp exists for it'}`));
      return;
    }
    if (!budgetLeft()) {
      buckets.set(key, emptyBucket(label, kpis, 'partner', recs.days, method, `${chatterEmpty}; the request ran out of time before the ${fallback.stamp} fallback could be read`));
      return;
    }
    // The scope note travels with the fallback too: which records were counted
    // matters exactly as much when the route changes under them.
    const fbMethod = `${model}.${fallback.stamp} on records with ${fallback.dateField} in the window${scopeNote ? `, ${scopeNote}` : ''} — ${fallback.caveat}`;
    // A plain date field gets a plain date: invoice_date is a date on Odoo 17
    // while date_approve and date_done are datetimes, and handing a date column
    // a 'YYYY-MM-DD HH:MM:SS' bound is left to the database to interpret.
    const fbSince = meta[fallback.dateField]?.type === 'date'
      ? sinceIso(OWNERSHIP_DIRECT_DAYS).slice(0, 10)
      : sinceIso(OWNERSHIP_DIRECT_DAYS);
    try {
      const { actors, outOfScope } = await actorsByStamp(model, [
        [fallback.dateField, '>=', fbSince],
        ['company_id', 'in', scopeIds],
        ...recordExtra,
      ], fallback.stamp);
      buckets.set(key, {
        ...emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, `FALLBACK — ${chatterEmpty}, so instead: ${fbMethod}`, null),
        actors, outOfScope,
      });
    } catch (e) {
      buckets.set(key, emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, fbMethod, `${chatterEmpty}, and the ${fallback.stamp} fallback failed too: ${errText(e)}`));
    }
  };

  // Confirms quotations (KPIs 2, 3, 4) — the service advisors, in the owner's
  // description: Wajid writes the quotation, somebody else approves it.
  await stateBucket({
    key: 'confirmsQuotations', label: 'Confirms quotations', kpis: bucketKpis('confirmsQuotations'),
    model: 'sale.order', code: 'sale', recordExtra: [], fallback: null,
  });

  // Confirms purchase orders (KPI 19).
  await stateBucket({
    key: 'confirmsPos', label: 'Confirms purchase orders', kpis: bucketKpis('confirmsPos'),
    model: 'purchase.order', code: 'purchase', recordExtra: [],
    fallback: { stamp: 'write_uid', dateField: 'date_approve', caveat: 'the LAST person to write the order, who is the confirmer only if nobody edited it afterwards' },
  });

  // Posts invoices (KPIs 1, 11). Customer invoices only: KPIs 1 and 11 measure
  // the invoice raised for the repair, so counting vendor bills and journal
  // entries here would hand a service advisor's KPI to the accounts desk. That
  // narrowing is a judgement, so it is printed where the owner can overrule it.
  await stateBucket({
    key: 'postsInvoices', label: 'Posts invoices', kpis: bucketKpis('postsInvoices'),
    model: 'account.move', code: 'posted',
    recordExtra: [['move_type', 'in', ['out_invoice', 'out_refund']]],
    scopeNote: 'customer invoices and credit notes only, not vendor bills or journal entries',
    fallback: { stamp: 'create_uid', dateField: 'invoice_date', caveat: 'whoever CREATED the invoice, which is not necessarily who posted it' },
  });

  // Receives parts (KPIs 20, 6). What this instance records about a receipt is
  // discovered, not assumed: KPI 20 already times the arrival through
  // purchase.order.effective_date, which Odoo computes from the receipt, so the
  // receipt is where a person can be found at all.
  {
    const label = 'Receives parts';
    const kpis = bucketKpis('receivesParts');
    const pickMeta = await modelMeta('stock.picking');
    if (!pickMeta) {
      buckets.set('receivesParts', emptyBucket(label, kpis, 'partner', OWNERSHIP_CHATTER_DAYS, 'stock.picking',
        'stock.picking could not be read on this instance, so nobody can be credited with receiving parts'));
    } else {
      // Tie receipts to purchasing where the link exists (purchase_id, added by
      // the purchase_stock module) — that is the exact population KPI 20 judges.
      // Otherwise fall back to "any incoming transfer", which is wider, and say so.
      const hasPick = (f: string) => Object.prototype.hasOwnProperty.call(pickMeta, f);
      let scopeClause: OdooDomain;
      let scopeNote: string;
      if (hasPick('purchase_id')) {
        scopeClause = [['purchase_id', '!=', false]];
        scopeNote = 'only receipts linked to a purchase order (stock.picking.purchase_id)';
      } else if (hasPick('picking_type_code')) {
        scopeClause = [['picking_type_code', '=', 'incoming']];
        scopeNote = 'ALL incoming transfers — stock.picking has no purchase_id here, so receipts could not be narrowed to purchase orders';
      } else {
        scopeClause = [['picking_type_id.code', '=', 'incoming']];
        scopeNote = 'ALL incoming transfers, by picking type — stock.picking has neither purchase_id nor picking_type_code here';
      }
      await stateBucket({
        key: 'receivesParts', label, kpis, model: 'stock.picking', code: 'done',
        recordExtra: scopeClause, scopeNote,
        fallback: { stamp: 'write_uid', dateField: 'date_done', caveat: 'the LAST person to write the receipt, who is the validator only if nobody edited it afterwards' },
      });
    }
  }

  // Uploads the follow-up screenshot (KPI 13).
  // A binary field is kept as an ir.attachment row carrying res_field, and THAT
  // row records who created it — the only place an uploader exists at all.
  // Four outcomes, all different: no such field; a computed field with nothing
  // stored to attribute; a value stored inline in the column with no uploader
  // recorded anywhere; or real uploads. None of them may read as "nobody does it".
  {
    const label = 'Uploads the follow-up screenshot';
    // Maps to no KPI: KPI 13 belongs to whoever opened the repair order.
    const kpis = bucketKpis('uploadsFollowUp');
    const method = 'ir.attachment.create_uid on the rows holding repair.order\'s follow-up screenshot field';
    const field = ['follow_up_screenshot', 'x_follow_up_screenshot'].find(hasRepairField);
    if (!field) {
      buckets.set('uploadsFollowUp', emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, method,
        'repair.order has no follow-up screenshot field on this instance, so KPI 13 has no action for anyone to own'));
    } else if (repairMeta[field]?.store === false) {
      buckets.set('uploadsFollowUp', emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, method,
        `repair.order.${field} is computed, not stored — Odoo saves no value and therefore no uploader, so KPI 13 cannot be owned by anyone until it reads a stored field`));
    } else if (!budgetLeft()) {
      buckets.set('uploadsFollowUp', emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, method,
        'the request ran out of its time budget before this bucket was read'));
    } else {
      try {
        // res_field is named explicitly: without it in the domain, Odoo's own
        // ir.attachment search hides every field attachment by default.
        const atts = (await call('ir.attachment', 'search_read', [[
          ['res_model', '=', 'repair.order'],
          ['res_field', '=', field],
          ['create_date', '>=', sinceIso(OWNERSHIP_DIRECT_DAYS)],
        ] as OdooDomain], { fields: ['create_uid', 'res_id'], limit: OWNERSHIP_MSG_CAP })) as Record<string, unknown>[];
        if (!atts.length) {
          // Either nothing was uploaded, or the value never becomes an
          // attachment at all. One count settles which, and they mean opposite
          // things: the first is a real (empty) answer, the second is a blind spot.
          let ever = -1;
          try { ever = (await call('repair.order', 'search_count', [[[field, '!=', false]] as OdooDomain])) as number; } catch { /* reported as unknown below */ }
          buckets.set('uploadsFollowUp', emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, method,
            ever > 0
              ? `${ever} repair order(s) carry a follow-up screenshot but Odoo holds NO attachment row for ${field}, so the value is stored inline in the column and no uploader is recorded anywhere — KPI 13 cannot be attributed to a person on this instance`
              : ever === 0
                ? null   // a genuine, measurable nobody: no screenshot has ever been uploaded
                : `no attachment rows exist for repair.order.${field}, and the all-time count of repair orders carrying one could not be read, so it is unknown whether nobody uploads a screenshot or the uploader simply is not recorded`));
        } else {
          // Branch comes from the repair order the attachment hangs on, never
          // from the attachment's own company_id — that is only whichever
          // company the uploader happened to be in at the time.
          const ids = [...new Set(atts.map((a) => (typeof a.res_id === 'number' ? a.res_id : null)).filter((x): x is number => x != null))];
          const roBranch = new Map<number, Branch>();
          let note: string | null = null;
          try {
            for (const chunk of idChunks(ids)) {
              const recs = (await call('repair.order', 'search_read', [[
                ['id', 'in', chunk],
                ['company_id', 'in', scopeIds],
                ...liveOnly,
              ] as OdooDomain], { fields: ['company_id'], limit: 0 })) as Record<string, unknown>[];
              for (const r of recs) {
                const cid = m2oId(r.company_id);
                const branch = cid != null ? branchOfCompany.get(cid) : undefined;
                if (typeof r.id === 'number' && branch) roBranch.set(r.id, branch);
              }
            }
          } catch (e) {
            note = `the repair orders behind the follow-up screenshots could not be checked for branch: ${errText(e)}`;
          }
          if (note) {
            buckets.set('uploadsFollowUp', emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, method, note));
          } else {
            const actors = blank();
            let outOfScope = 0;
            for (const a of atts) {
              const uid = m2oId(a.create_uid);
              const rid = typeof a.res_id === 'number' ? a.res_id : null;
              const branch = rid != null ? roBranch.get(rid) : undefined;
              if (uid == null || !branch) { outOfScope++; continue; }
              creditActor(actors, uid, m2oName(a.create_uid), branch, 1);
            }
            buckets.set('uploadsFollowUp', {
              ...emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, method, null),
              actors, outOfScope, truncated: atts.length >= OWNERSHIP_MSG_CAP,
            });
          }
        }
      } catch (e) {
        buckets.set('uploadsFollowUp', emptyBucket(label, kpis, 'user', OWNERSHIP_DIRECT_DAYS, method,
          `ir.attachment could not be read, so the screenshot uploader is unknown: ${errText(e)}`));
      }
    }
  }

  // ── Chatter authors are PARTNERS; the roster is keyed on users ────
  // Resolved once for every chatter bucket, with active_test:false so a departed
  // employee still resolves to their archived user and keeps their name — the
  // same treatment lib/kpi.ts gives chatter mentions for KPI 17. An author with
  // no user behind it is a customer or an automated action, counted and named as
  // such rather than quietly printed as a member of staff.
  const partnerIds = [...new Set(
    [...buckets.values()].filter((b) => b.actorKind === 'partner').flatMap((b) => [...b.actors.keys()]),
  )];
  const userByPartner = new Map<number, { id: number; name: string }>();
  let partnerLookupFailed: string | null = null;
  if (partnerIds.length) {
    try {
      for (const chunk of idChunks(partnerIds)) {
        const us = (await call('res.users', 'search_read', [[['partner_id', 'in', chunk]] as OdooDomain], {
          fields: ['partner_id', 'name'], limit: 0, context: { active_test: false },
        })) as Record<string, unknown>[];
        for (const u of us) {
          const pid = m2oId(u.partner_id);
          if (pid != null && typeof u.id === 'number') userByPartner.set(pid, { id: u.id, name: (u.name as string) || `#${u.id}` });
        }
      }
    } catch (e) {
      partnerLookupFailed = errText(e);
    }
  }
  for (const b of buckets.values()) {
    if (b.actorKind !== 'partner' || !b.actors.size) continue;
    if (partnerLookupFailed) {
      // The names still print. A chatter author name is a weaker identity than a
      // user, not a useless one, and dropping the bucket would lose more than it
      // protects — so it is labelled instead.
      b.method += ` ⚠ authors could NOT be matched to Odoo users (${partnerLookupFailed}), so these are raw chatter author names and may include customers or automation`;
      continue;
    }
    const resolved: OwnershipActors = new Map();
    for (const [pid, a] of b.actors) {
      const user = userByPartner.get(pid);
      if (!user) {
        for (const n of a.byBranch.values()) b.nonUser += n;
        continue;
      }
      const prev = resolved.get(user.id);
      if (!prev) resolved.set(user.id, { name: user.name, byBranch: new Map(a.byBranch) });
      else for (const [br, n] of a.byBranch) prev.byBranch.set(br, (prev.byBranch.get(br) ?? 0) + n);
    }
    b.actors = resolved;
  }

  // ── Collect ─────────────────────────────────────────────────────
  // A bucket that never got set at all would otherwise just be absent, and an
  // absent bucket is the one failure this report must not be able to produce:
  // the owner would read eleven actions as ten and never know which one left.
  const neverReached = OWNERSHIP_ORDER.filter((k) => !buckets.has(k));
  const ordered = OWNERSHIP_ORDER
    .map((k) => { const b = buckets.get(k); return b ? { ...b, key: k } : null; })
    .filter((b): b is OwnershipBucketEntry => !!b);

  return {
    ordered,
    neverReached: [...neverReached],
    inScopeBranches: KPI_BRANCHES.filter((b) => inScopeBranches.has(b)),
    missingBranches,
    noteTracking,
    partnerLookupFailed,
    budgetSpent: !budgetLeft(),
    budgetMs,
    fatal: null,
  };
}

/**
 * The ownership map as plain text — the diagnostic form, returned alongside the
 * structured proposal so the evidence the owner approves can also be read, and
 * pasted, as prose.
 *
 * One note per line, and every line carries a prefix unique across the whole
 * report. The Admin card keys these lines by their own text, so two identical
 * lines would collapse into one on screen — a silent loss of exactly the kind
 * this report exists to prevent. That is also why each branch's lines name the
 * branch rather than sitting under a header.
 */
export function kpiOwnershipLines(map: KpiOwnershipMap, config: KpiConfig | null): string[] {
  const lines: string[] = [];
  if (map.fatal) return [map.fatal];
  const { ordered, neverReached, missingBranches, noteTracking } = map;
  const inScopeBranches = new Set<string>(map.inScopeBranches);

  lines.push('═══ KPI OWNERSHIP MAP — who performs each KPI-bearing action, per branch. A person answers for a KPI in a branch when they performed its action more than ${KPI_OWNER_FLOOR} times there in the last ${KPI_OWNER_WINDOW_DAYS} days. ═══');
  lines.push(`Ownership scope: ${[...inScopeBranches].join(', ')} — each branch's own workshop company, which is exactly the population the KPI section scores.`
    + `${missingBranches.length ? ` ⚠ LEFT OUT because its company did not resolve in Odoo: ${missingBranches.join(', ')} — those branches are blank below for that reason, not because nobody works there.` : ''}`);
  lines.push(`Ownership windows: every action is read over ${KPI_OWNER_WINDOW_DAYS} days, the same period the ownership floor (more than ${KPI_OWNER_FLOOR}) is stated for; a chatter-derived line showing fewer days was narrowed on a busy model and is NOT comparable with the floor. A branch here is the company on the record the action touched, not where the person usually works.`);

  for (const branch of KPI_BRANCHES) {
    if (!inScopeBranches.has(branch)) continue;
    for (const b of ordered) {
      if (b.unavailable) continue;   // said once, globally, below
      const people = [...b.actors.values()]
        .map((a) => ({ name: a.name, n: a.byBranch.get(branch) ?? 0 }))
        .filter((p) => p.n > 0)
        .sort((x, y) => y.n - x.n || x.name.localeCompare(y.name));
      const shown = people.slice(0, OWNERSHIP_NAME_CAP).map((p) => `${p.name} (${p.n})`).join(' · ');
      const more = people.length > OWNERSHIP_NAME_CAP ? ` · +${people.length - OWNERSHIP_NAME_CAP} more` : '';
      lines.push(`${branch} · ${b.label} → ${kpiTag(b.kpis)} [${b.days}d]: `
        + (people.length ? shown + more : '(nobody — nobody here performed this action in the window)')
        + (b.truncated ? ' ⚠ truncated at the row cap, so these counts are floors' : ''));
    }
  }

  // Why each bucket says what it says. Kept out of the branch lines so those
  // stay pasteable, but printed in full: an ownership claim nobody can check is
  // worth less than no claim at all.
  for (const b of ordered) {
    lines.push(`How "${b.label}" (${kpiTag(b.kpis)}) was measured: ${b.method}.`);
  }
  for (const b of ordered) {
    if (b.unavailable) {
      lines.push(`⚠ NOT ATTRIBUTABLE — "${b.label}" (${kpiTag(b.kpis)}): ${b.unavailable}. This is NOT the same as nobody doing it: the action is invisible to us here, so no name list exists to print.`);
    }
  }
  for (const b of ordered) {
    const bits: string[] = [];
    if (b.outOfScope) bits.push(`${b.outOfScope} on records outside the five KPI branches (another company, a station, or a Historical job card)`);
    if (b.nonUser) bits.push(`${b.nonUser} whose author is not an Odoo user — a customer replying, or an automated action`);
    if (bits.length) lines.push(`Left out of "${b.label}": ${bits.join('; ')}.`);
  }

  // Anyone doing work in more than one branch. The saved roster holds one branch
  // per person, so these are precisely the names that model cannot express.
  const branchesByPerson = new Map<string, Set<string>>();
  for (const b of ordered) {
    for (const a of b.actors.values()) {
      const set = branchesByPerson.get(a.name) ?? new Set<string>();
      for (const [br, n] of a.byBranch) if (n > 0) set.add(br);
      branchesByPerson.set(a.name, set);
    }
  }
  const multi = [...branchesByPerson.entries()]
    .filter(([, s]) => s.size > 1)
    // Branches in the dashboards' own order, so the same evidence always reads
    // the same way rather than in whatever order the queries happened to run.
    .map(([name, s]) => `${name} (${KPI_BRANCHES.filter((b) => s.has(b)).join(', ')})`)
    .sort();
  lines.push(multi.length
    ? `Appearing in more than one branch: ${multi.join(' · ')} — ownership is per branch, so each branch is judged on its own count.`
    : 'Appearing in more than one branch: nobody — every person listed above worked in a single branch during the window.');

  // The KPIs no individual performs, stated rather than left out: a KPI missing
  // from this report would otherwise look like one we failed to measure.
  lines.push('No individual actor: KPI 7 (Awaiting labour) and KPI 9 (Weekly closure rate) are branch-level — they measure a queue and a throughput ratio, so nobody performs them and they are attributed to no person.');
  lines.push('Not assigned: KPI 17 (Chatter response) falls on anyone who can be @mentioned, so it belongs to everybody rather than to one bucket.');
  if (config?.rfqCoordinators && Object.keys(config.rfqCoordinators).length) {
    lines.push(`For comparison, the RFQ coordinators currently saved in Admin — one person per branch, which is what KPI 18 follows today: ${Object.entries(config.rfqCoordinators).map(([b, c]) => `${b} = ${c?.name ?? '?'}`).join(' · ')}.`);
  }
  if (neverReached.length) {
    lines.push(`⚠ These ownership buckets were never reached, so they appear nowhere above and are UNKNOWN rather than empty: ${neverReached.join(', ')}.`);
  }
  for (const n of noteTracking) lines.push(n);
  if (map.budgetSpent) {
    lines.push(`⚠ The ownership map used its whole ${Math.round(map.budgetMs / 1000)}-second budget. Any bucket above that reports running out of time was never read — treat it as unknown rather than empty, and run it again to try it.`);
  }
  lines.push('═══ end of KPI ownership map ═══');

  return lines;
}


// ── KPI owners: derived from what people do in Odoo ────────────────
/**
 * Who answers for each KPI in each branch, purely from activity: a person owns a
 * KPI in a branch when they performed that KPI's action more than
 * KPI_OWNER_FLOOR times there in the last KPI_OWNER_WINDOW_DAYS. No labels, no
 * approval step — the result is written straight into the stored KPI config by
 * the refresh route and the nightly cron (lib/kpi-owners-refresh.ts).
 *
 * Reads Odoo only. The one rule that matters most: a bucket that could not be
 * read is NOT zero. Its KPIs keep the owners stored by the previous refresh, and
 * the bucket is reported, because an unreadable bucket and an idle person look
 * identical once both are empty and reading the first as the second would strip
 * ownership from people who hold it.
 */

/**
 * Wall-clock budget for the map when it runs on its own 300-second route. Leaves
 * a wide margin for the reads around it and the store write after it, while
 * still stopping — and saying which buckets it never reached — rather than
 * letting the request die with nothing to show.
 */
export const KPI_OWNER_BUDGET_MS = 210_000;

/**
 * Logins and names that mean "not a person".
 *
 * Matched on the Odoo LOGIN and the display name, never on an id: ids differ per
 * database and a hardcoded one would silently stop matching after a restore or
 * on a second instance, which here means OdooBot quietly becoming Sharjah's
 * quotation owner — it writes 62 of them. `__system__` is OdooBot's own login,
 * and the `__` prefix is Odoo's convention for its internal accounts.
 */
const SYSTEM_LOGINS = new Set(['__system__', 'odoobot', 'admin', 'administrator', 'default', 'public', 'portaltemplate']);
const SYSTEM_NAMES = /^(odoobot|administrator|public user|default user|system|template user|portal user)$/i;

/** Why this account is not a person, or null when it is one. */
function systemAccountReason(login: string | null, name: string): string | null {
  const l = (login ?? '').trim().toLowerCase();
  if (l.startsWith('__')) return `its Odoo login "${login}" starts with "__", which is Odoo's own internal-account convention — this is automation, not a member of staff`;
  if (l && SYSTEM_LOGINS.has(l)) return `its Odoo login "${login}" is a known system account, so its activity is automation or administration rather than a person's work`;
  if (SYSTEM_NAMES.test(name.trim())) return `the Odoo user name "${name}" is a known system account, so its activity is automation or administration rather than a person's work`;
  return null;
}

/** One action's count behind one owner. */
export interface KpiOwnerCount {
  bucket: OwnershipBucketKey;
  /** 'Raises RFQs'. */
  label: string;
  count: number;
  /** Days of history behind `count`. */
  days: number;
  /** The read hit its row cap, so `count` is a floor. */
  truncated: boolean;
}

/** One owner of one KPI in one branch, with the evidence. */
export interface KpiOwnerEntry {
  userId: number;
  name: string;
  /** Every covering action this person performed here, zeroes left out. Empty for an owner carried over unmeasured. */
  counts: KpiOwnerCount[];
  /**
   * Non-null when this owner was carried over from the previous refresh rather
   * than earned on this one, holding why (an action behind the KPI could not be
   * read, or only partly, or the branch did not resolve).
   */
  kept: string | null;
}

/** An action that could not be fully read, and so could not remove anybody. */
export interface KpiOwnersUnreadable {
  key: OwnershipBucketKey;
  label: string;
  kpis: number[];
  reason: string;
  /**
   * True when it WAS read, but over a shorter window than the floor's or with a
   * truncated count: anyone it shows above the floor still qualifies, but nobody
   * can be dropped on its strength. False when it could not be read at all.
   */
  partial: boolean;
}

/** The whole derivation, as the refresh route returns it and the Admin card renders it. */
export interface KpiOwnersResult {
  /** branch → KPI id → owner user ids. What gets written into kpiConfig.kpiOwners. */
  owners: KpiOwners;
  /** Same shape, with the name and counts behind every owner. */
  detail: Record<string, Record<string, KpiOwnerEntry[]>>;
  unreadable: KpiOwnersUnreadable[];
  /** Branches whose company did not resolve: their previous owners are kept whole. */
  missingBranches: string[];
  /** System accounts that would otherwise have qualified, and why they did not. */
  excluded: { userId: number; name: string; reason: string }[];
  /** Non-null when logins could not be read: only the NAME check ran. */
  systemCheckFailed: string | null;
  floor: number;
  windowDays: number;
  /** The ownership map in its plain-text diagnostic form, plus this layer's notes. */
  notes: string[];
  /** Non-null when nothing could be measured; `owners` is then the previous set, untouched, and must not be written. */
  fatal: string | null;
  computedAt: string;
}

/**
 * Derive KpiOwners from Odoo.
 *
 * `previous` is the set currently stored: it is what an unreadable bucket's KPIs
 * (and a branch that did not resolve) fall back to.
 */
export async function fetchKpiOwners(
  config: KpiConfig | null,
  previous: KpiOwners | undefined,
  budgetMs: number = KPI_OWNER_BUDGET_MS,
): Promise<KpiOwnersResult> {
  cachedUid = null;
  companyIdCache = null;
  const prev: KpiOwners = previous ?? {};
  const computedAt = new Date().toISOString();

  const fatalResult = (why: string): KpiOwnersResult => ({
    owners: prev, detail: {}, unreadable: [], missingBranches: [], excluded: [], systemCheckFailed: null,
    floor: KPI_OWNER_FLOOR, windowDays: KPI_OWNER_WINDOW_DAYS, notes: [why], fatal: why, computedAt,
  });

  // ── The reads the map needs ─────────────────────────────────────
  let repairMeta: OwnershipFieldMeta;
  try {
    repairMeta = (await call('repair.order', 'fields_get', [], {
      attributes: ['string', 'type', 'relation', 'selection', 'store', 'readonly'],
    })) as OwnershipFieldMeta;
  } catch (e) {
    return fatalResult(`⚠ KPI ownership could not be refreshed — repair.order could not be read in Odoo: ${errText(e)}`);
  }
  const has = (f: string) => Object.prototype.hasOwnProperty.call(repairMeta, f);

  // Stage names, because the chatter stores the human LABEL of what changed.
  const preNotes: string[] = [];
  let stageNames: Record<number, string> = {};
  if (has('stage_id') && repairMeta.stage_id?.relation) {
    try {
      const recs = (await call(repairMeta.stage_id.relation, 'search_read', [[]], { fields: ['display_name'], limit: 200 })) as { id: number; display_name?: string }[];
      stageNames = Object.fromEntries(recs.map((r) => [r.id, r.display_name || `#${r.id}`]));
    } catch (e) {
      preNotes.push(`⚠ repair.order.stage_id exists but its stage model could not be read (${errText(e)}), so any stage-mapped action below reports an unresolved mapping.`);
    }
  }

  const trackCounts = await chatterTrackingCounts(
    ['state', 'repair_state', 'priority_matrix_status', 'stage_id'].filter(has));

  let map: KpiOwnershipMap;
  try {
    map = await collectKpiOwnership({ config, repairMeta, stageNames, trackCounts, budgetMs });
  } catch (e) {
    return fatalResult(`⚠ KPI ownership could not be refreshed — the ownership map failed: ${errText(e)}`);
  }
  if (map.fatal) return fatalResult(map.fatal);

  const notes = [...preNotes, ...kpiOwnershipLines(map, config)];
  const byKey = new Map<OwnershipBucketKey, OwnershipBucketEntry>(map.ordered.map((b) => [b.key, b]));

  // ── Classify every KPI-bearing action: readable, partial, or unreadable ──
  const unreadable: KpiOwnersUnreadable[] = [];
  /** Buckets whose counts may be credited (fully or partly read). */
  const usable = new Map<OwnershipBucketKey, OwnershipBucketEntry>();
  /** Buckets that block REMOVAL of a previous owner of their KPIs, with why. */
  const blocking = new Map<OwnershipBucketKey, string>();
  for (const key of OWNERSHIP_ORDER) {
    const kpis = bucketKpis(key);
    if (!kpis.length) continue;   // drives no KPI (uploadsFollowUp)
    const b = byKey.get(key);
    let reason: string | null = null;
    if (!b) reason = 'this action was never reached on this run, so it is UNKNOWN rather than empty';
    else if (b.unavailable) reason = b.unavailable;
    else if (map.partnerLookupFailed && b.actorKind === 'partner') {
      // Keyed on res.partner ids, which are some OTHER person's user ids:
      // crediting them would hand the KPI to the wrong person.
      reason = `the chatter authors behind this action could NOT be matched to Odoo users (${map.partnerLookupFailed}), so its counts cannot be credited to anyone`;
    }
    if (!b || reason) {
      unreadable.push({ key, label: b?.label ?? key, kpis, reason: reason ?? 'unknown', partial: false });
      blocking.set(key, `"${b?.label ?? key}" could not be read on this run`);
      continue;
    }
    usable.set(key, b);
    const partial: string[] = [];
    if (b.days < KPI_OWNER_WINDOW_DAYS) partial.push(`it was read over only ${b.days} days (the model is too busy for ${KPI_OWNER_WINDOW_DAYS}), so a count below the floor is not a miss`);
    if (b.truncated) partial.push('a read hit its row cap, so its counts are floors');
    if (partial.length) {
      unreadable.push({ key, label: b.label, kpis, reason: partial.join('; '), partial: true });
      blocking.set(key, `"${b.label}" was only partly read on this run`);
    }
  }

  // ── Everyone who reaches the floor somewhere, plus everyone stored ──
  const scope: string[] = [...map.inScopeBranches];
  const nameById = new Map<number, string>();
  const candidates = new Set<number>();
  for (const b of usable.values()) {
    for (const [uid, a] of b.actors) {
      if (!nameById.has(uid) || nameById.get(uid)!.startsWith('#')) nameById.set(uid, a.name);
      for (const [br, n] of a.byBranch) if (n > KPI_OWNER_FLOOR && scope.includes(br)) candidates.add(uid);
    }
  }
  for (const byKpi of Object.values(prev)) {
    for (const ids of Object.values(byKpi ?? {})) for (const id of ids ?? []) candidates.add(id);
  }
  for (const r of config?.saRoster ?? []) if (!nameById.has(r.odooUserId)) nameById.set(r.odooUserId, r.name);

  // ── Logins, for the system-account check ────────────────────────
  // active_test:false so a deactivated account still resolves: OdooBot is often
  // inactive, and an unresolved automation account would read as a person.
  const loginById = new Map<number, string>();
  let systemCheckFailed: string | null = null;
  if (candidates.size) {
    try {
      for (const chunk of idChunks([...candidates])) {
        const us = (await call('res.users', 'search_read', [[['id', 'in', chunk]] as OdooDomain], {
          fields: ['login', 'name'], limit: 0, context: { active_test: false },
        })) as Record<string, unknown>[];
        for (const u of us) {
          if (typeof u.id !== 'number') continue;
          if (typeof u.login === 'string') loginById.set(u.id, u.login);
          if (typeof u.name === 'string' && u.name) nameById.set(u.id, u.name);
        }
      }
    } catch (e) {
      systemCheckFailed = errText(e);
      notes.push(`⚠ The Odoo logins could not be read (${systemCheckFailed}), so accounts were checked for being automation by NAME only — an automation account with an unusual name may appear as an owner on this run.`);
    }
  }
  const nameOf = (uid: number) => nameById.get(uid) ?? `#${uid}`;
  const systemWhy = new Map<number, string>();
  for (const uid of candidates) {
    const why = systemAccountReason(loginById.get(uid) ?? null, nameOf(uid));
    if (why) systemWhy.set(uid, why);
  }

  // ── Derive, per branch, per KPI ─────────────────────────────────
  const owners: KpiOwners = {};
  const detail: Record<string, Record<string, KpiOwnerEntry[]>> = {};
  const excludedSeen = new Map<number, string>();
  const allKpis = [...new Set(OWNERSHIP_ORDER.flatMap((k) => bucketKpis(k)))].sort((a, b) => a - b);
  const peak = (e: KpiOwnerEntry) => Math.max(0, ...e.counts.map((c) => c.count));

  for (const branch of scope) {
    for (const kpi of allKpis) {
      const covering = OWNERSHIP_ORDER.filter((k) => OWNERSHIP_BUCKET_KPIS[k].includes(kpi));
      const entries = new Map<number, KpiOwnerEntry>();
      for (const key of covering) {
        const b = usable.get(key);
        if (!b) continue;
        for (const [uid, a] of b.actors) {
          const n = a.byBranch.get(branch) ?? 0;
          if (n <= 0) continue;
          const e = entries.get(uid) ?? { userId: uid, name: nameOf(uid), counts: [], kept: null };
          e.counts.push({ bucket: key, label: b.label, count: n, days: b.days, truncated: b.truncated });
          entries.set(uid, e);
        }
      }
      // Union across covering actions: over the floor in ANY of them is enough.
      const qualified: KpiOwnerEntry[] = [];
      for (const e of entries.values()) {
        if (!e.counts.some((c) => c.count > KPI_OWNER_FLOOR)) continue;
        const why = systemWhy.get(e.userId);
        if (why) { excludedSeen.set(e.userId, why); continue; }
        qualified.push(e);
      }
      // An unreadable or partly read action: nobody stored before may be
      // dropped on the strength of this run.
      const blockers = covering.map((k) => blocking.get(k)).filter((x): x is string => !!x);
      if (blockers.length) {
        for (const uid of prev[branch]?.[String(kpi)] ?? []) {
          if (qualified.some((q) => q.userId === uid)) continue;
          const why = systemWhy.get(uid);
          if (why) { excludedSeen.set(uid, why); continue; }
          qualified.push({
            userId: uid, name: nameOf(uid), counts: entries.get(uid)?.counts ?? [],
            kept: `kept from the previous refresh — ${blockers.join('; ')}`,
          });
        }
      }
      if (!qualified.length) continue;
      qualified.sort((x, y) => (x.kept ? 1 : 0) - (y.kept ? 1 : 0) || peak(y) - peak(x) || x.name.localeCompare(y.name));
      (owners[branch] ??= {})[String(kpi)] = qualified.map((q) => q.userId).sort((a, b) => a - b);
      (detail[branch] ??= {})[String(kpi)] = qualified;
    }
  }

  // A branch the map could not speak about keeps its previous owners whole.
  for (const branch of map.missingBranches) {
    const was = prev[branch];
    if (!was) continue;
    owners[branch] = was;
    detail[branch] = Object.fromEntries(Object.entries(was).map(([kpi, ids]) => [kpi, (ids ?? []).map((uid) => ({
      userId: uid, name: nameOf(uid), counts: [],
      kept: `kept from the previous refresh — ${branch}'s Odoo company did not resolve on this run`,
    }))]));
  }

  const excluded = [...excludedSeen].map(([userId, reason]) => ({ userId, name: nameOf(userId), reason }));
  if (excluded.length) notes.push(`Left out as system accounts: ${excluded.map((x) => x.name).join(' · ')}.`);
  if (unreadable.length) {
    notes.push(`⚠ ${unreadable.length} action(s) could not be fully read: ${unreadable.map((u) => `"${u.label}" (${kpiTag(u.kpis)})`).join(' · ')}. Their KPIs keep the owners stored by the previous refresh, plus anyone this run shows above the floor.`);
  }
  notes.push(`Ownership rule in force: more than ${KPI_OWNER_FLOOR} actions in ${KPI_OWNER_WINDOW_DAYS} days, per KPI per branch.`);

  return {
    owners, detail, unreadable, missingBranches: map.missingBranches, excluded, systemCheckFailed,
    floor: KPI_OWNER_FLOOR, windowDays: KPI_OWNER_WINDOW_DAYS, notes, fatal: null, computedAt,
  };
}
