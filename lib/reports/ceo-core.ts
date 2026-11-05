/**
 * The population the four CEO reports share.
 *
 * "Needs attention", "Oldest open jobs", "Repaired, not invoiced" and
 * "Unposted invoices" all ask about the same three facts — which jobs are open,
 * which are finished and unbilled, and which bills were never posted. Reading
 * them in one place keeps the four tabs agreeing about every job, and the memo
 * below means opening all four costs one Odoo read, not four.
 *
 * The domains are the WIP dashboard's own (lib/odoo.ts) and the KPI page's own
 * (params.openRoDomain), reused rather than restated, so a figure here
 * reconciles with the tile the CEO has already seen rather than contradicting it.
 */

import type { Branch } from '../types';
import {
  call,
  notHistorical,
  allTrackedCompanyIds,
  unresolvedCompanies,
  excludeInternalSales,
  historicalRepairCounts,
  DOM_REPAIRED_NOT_INVOICED,
  PRIORITY_MATRIX_LABELS,
  type OdooDomain,
} from '../odoo';
import { readFieldsMeta, type FieldsMeta } from '../kpi';
import { companyIndex, idChunks, m2o, m2oName, odooTime, searchReadAll, unknownCompanyNote, type Rec } from './common';
import { odooRecordUrl } from '../odoo-link';
import type { ReportParams } from './types';

/** Ids per request — keeps every payload, and Odoo's IN clause, a sane size. */
const CHUNK = 2000;
/** Long enough to cover opening all four tabs; short enough that a refresh soon sees a posted invoice. */
const TTL_MS = 2 * 60 * 1000;

/** The vehicle link is named differently per instance; the same list the Excel export probes. */
const VEHICLE_FIELDS = ['fleet_id', 'vehicle_id', 'lot_id', 'x_vehicle_id', 'x_vehicle'];

// ── Shapes ─────────────────────────────────────────────────────────

export interface CeoJob {
  id: number;
  name: string;                 // repair order number
  url: string | null;           // odooRecordUrl('repair.order', id, companyId)
  branch: Branch;
  site: string;                 // the Odoo company name, BRANCH_CLUSTERS spelling
  companyId: number;
  customer: string;
  vehicle: string;
  createdBy: string;            // create_uid display name
  created: number | null;       // epoch ms
  stateLabel: string;           // human label of `state`
  matrixLabel: string;          // PRIORITY_MATRIX_LABELS[priority_matrix_status]
  statusSince: number | null;   // epoch ms; null when the field is absent or unset
  saleOrderId: number | null;
  saleOrderName: string;
  value: number | null;         // sale.order amount_untaxed
  /**
   * 'none' is nobody raised a bill; 'unknown' is we could not check. Those are
   * different facts about a job, and a report that showed 'unknown' as 'none'
   * would accuse a branch of work it may well have invoiced.
   *
   * A job with no saleOrderId also reads 'unknown', because there is no bill to
   * go looking for. Check saleOrderId first and call that one "no quotation":
   * it is a third failure again, and the one the branch has to answer for.
   */
  invoiceState: 'none' | 'draft' | 'posted' | 'unknown';
}

export interface CeoInvoice {
  id: number;
  name: string;                 // account.move name — often '/' while in draft; fall back to `Draft #${id}` so a row is identifiable
  url: string | null;           // odooRecordUrl('account.move', id, companyId)
  branch: Branch;
  site: string;
  companyId: number;
  customer: string;
  created: number | null;       // create_date, epoch ms
  invoiceDate: string | null;   // 'YYYY-MM-DD' from invoice_date, else null
  amount: number;               // amount_untaxed
  origin: string;               // invoice_origin, '' when unavailable
  saleOrderNames: string[];     // source sale orders parsed out of `origin`
}

export interface CeoData {
  /** Open repair orders — params.openRoDomain, i.e. "open" as the KPI page defines it. */
  openJobs: CeoJob[];
  /** DOM_REPAIRED_NOT_INVOICED from lib/odoo.ts, so this reconciles with the WIP tile. */
  repairedNotInvoiced: CeoJob[];
  /** Customer invoices sitting in draft. */
  draftInvoices: CeoInvoice[];
  /** Repair orders each branch has parked in Historical Orders — the caveat, not the data. */
  historical: Record<Branch, number>;
  has: {
    statusSince: boolean;
    saleOrderId: boolean;
    vehicle: boolean;
    invoiceOrigin: boolean;
    invoiceState: boolean;   // whether the job → invoice state chain could be read at all
  };
  notes: string[];
}

// ── Helpers ────────────────────────────────────────────────────────

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const idList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);

/** A selection's label for a stored value; the raw value when no label is known. */
function selectionLabel(meta: FieldsMeta | null, field: string, value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return meta?.[field]?.selection?.find(([v]) => v === value)?.[1] ?? value;
}

/**
 * invoice_date is a date field, not a datetime: it carries the day the branch
 * put on the invoice. Reading it through a timezone would move it by a day, so
 * the stored day is taken as it stands.
 */
function dateOnly(raw: unknown): string | null {
  return typeof raw === 'string' && raw ? raw.slice(0, 10) : null;
}

/**
 * Source document names out of invoice_origin, kept only where they match a
 * sale order already loaded. A name this read does not know is not guessed at:
 * only a confirmed match lets a later report say an invoice and a job are the
 * same money, and a wrong match would cancel out a real exception.
 */
function parseOrigin(origin: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const part of origin.split(/[,;]/)) {
    const name = part.trim();
    if (name && known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

// ── The population ─────────────────────────────────────────────────

async function load(params: ReportParams): Promise<CeoData> {
  const notes: string[] = [];
  const has = { statusSince: false, saleOrderId: false, vehicle: false, invoiceOrigin: false, invoiceState: true };

  // Thrown, not noted: without repair.order there is no population at all, and
  // four empty tabs would read as "nothing to attend to" for the cache's life.
  const meta = await readFieldsMeta('repair.order');
  if (!meta) throw new Error('repair.order could not be read, so the CEO reports have no jobs to show.');
  const roHas = (f: string) => hasOwn(meta, f);

  const vehicleField = VEHICLE_FIELDS.find(roHas) ?? null;
  has.vehicle = vehicleField != null;
  has.statusSince = roHas('status_since');
  has.saleOrderId = roHas('sale_order_id');

  if (!has.vehicle) {
    notes.push('repair.order has no vehicle field here, so no job could be shown against the vehicle it is for.');
  }
  if (has.statusSince) {
    notes.push('Time in status comes from Status Since, which records when the record entered its current status. Its trigger is not verified on this instance — it may stamp on the priority-matrix status or on the repair state — so read a time-in-status figure as time since the last tracked status change.');
  } else {
    notes.push('repair.order has no Status Since field here, so time in status cannot be shown and only the job\'s own age is available.');
  }
  if (!has.saleOrderId) {
    // No link to the quotation means no money and no invoice to follow, so the
    // whole chain is unread rather than read as "never billed".
    has.invoiceState = false;
    notes.push('repair.order has no sale order link here, so no job carries a value and nothing could be checked against invoicing.');
  }

  const missing: string[] = [];
  if (!roHas('partner_id')) missing.push('customer (jobs are listed without who they are for)');
  if (!roHas('create_uid')) missing.push('created-by user (the person who opened the job card cannot be named)');
  if (!roHas('state')) missing.push('repair status (the stage cannot be shown)');
  if (!roHas('priority_matrix_status')) missing.push('priority-matrix status (the matrix stage cannot be shown)');
  if (missing.length) notes.push(`Repair orders on this instance carry no ${missing.join('; no ')}.`);

  const companyIds = await allTrackedCompanyIds();
  const index = await companyIndex();
  const unknownJobs = new Map<string, number>();

  // A configured company Odoo cannot find costs its branch every row below, and
  // a branch with no rows reads exactly like a branch with no problems. Al Ain's
  // revenue went missing this way once already, so the names are printed rather
  // than left to be inferred from a suspiciously clean column.
  const unresolved = await unresolvedCompanies();
  if (unresolved.length) {
    notes.push(`Not found in Odoo, so nothing here is counted for ${unresolved.length === 1 ? 'it' : 'them'}: ${unresolved.join(', ')}. A renamed company has to be corrected in Admin before these figures are complete.`);
  }
  if (!companyIds.length) {
    notes.push('No configured company resolved in Odoo at all, so every figure here is empty for want of data rather than for want of problems.');
  }

  const roFields = [
    'name', 'company_id', 'create_date',
    ...['state', 'priority_matrix_status', 'partner_id', 'create_uid', 'sale_order_id', 'status_since'].filter(roHas),
    ...(vehicleField ? [vehicleField] : []),
  ];

  function toJob(r: Rec): CeoJob | null {
    const company = m2o(r.company_id);
    const where = company ? index.get(company[0]) : undefined;
    if (!where) {
      // Counted and reported, never silently dropped: a total that quietly lost
      // rows reads as complete when it is not.
      const name = company?.[1] || 'no company';
      unknownJobs.set(name, (unknownJobs.get(name) ?? 0) + 1);
      return null;
    }
    const id = r.id as number;
    const matrix = typeof r.priority_matrix_status === 'string' ? r.priority_matrix_status : '';
    const saleOrder = m2o(r.sale_order_id);
    return {
      id,
      name: String(r.name ?? ''),
      url: odooRecordUrl('repair.order', id, company?.[0]),
      branch: where.branch,
      site: where.site,
      companyId: company![0],
      customer: m2oName(r.partner_id),
      vehicle: vehicleField ? m2oName(r[vehicleField]) : '',
      createdBy: m2oName(r.create_uid),
      created: odooTime(r.create_date),
      stateLabel: selectionLabel(meta, 'state', r.state),
      // An unmapped letter falls through as itself: a new matrix code should
      // show as the code rather than as an empty cell nobody can act on.
      matrixLabel: matrix ? PRIORITY_MATRIX_LABELS[matrix] || matrix : '',
      statusSince: has.statusSince ? odooTime(r.status_since) : null,
      saleOrderId: saleOrder?.[0] ?? null,
      saleOrderName: saleOrder?.[1] ?? '',
      value: null,
      invoiceState: 'unknown',
    };
  }

  // "Open" is the KPI page's rule, so the two pages mean the same jobs by it;
  // "repaired, not invoiced" is the WIP dashboard's own domain, reused so the
  // tile and this list can never disagree. Historical orders are out of both.
  const openDomain: OdooDomain = [...params.openRoDomain, ['company_id', 'in', companyIds], ...(await notHistorical())];
  const doneDomain: OdooDomain = [...DOM_REPAIRED_NOT_INVOICED, ['company_id', 'in', companyIds], ...(await notHistorical())];

  const openJobs = (await searchReadAll('repair.order', openDomain, roFields)).map(toJob).filter((j): j is CeoJob => j != null);
  const repairedNotInvoiced = (await searchReadAll('repair.order', doneDomain, roFields)).map(toJob).filter((j): j is CeoJob => j != null);

  notes.push('"Open" follows the KPI page\'s closed-stage selector, so this count may differ from the WIP dashboard\'s open repair orders tile, which uses its own domain.');

  // ── Value and invoicing, through the sale order ──
  const allJobs = [...openJobs, ...repairedNotInvoiced];
  const saleOrderIds = [...new Set(allJobs.map((j) => j.saleOrderId).filter((x): x is number => x != null))];
  /** Sale order id → name, value and the invoices raised from it. */
  const orders = new Map<number, { name: string; value: number | null; invoiceIds: number[] }>();
  const invoiceStates = new Map<number, string>();
  const orderNames = new Set<string>();

  if (has.saleOrderId && saleOrderIds.length) {
    try {
      for (const part of idChunks(saleOrderIds, CHUNK)) {
        // amount_untaxed, not amount_total: the sales dashboard reports untaxed
        // figures (salesByBranch in lib/odoo.ts), and a CEO page that mixed the
        // two would not tie out against the revenue he reads every morning.
        for (const so of (await call('sale.order', 'read', [part], { fields: ['name', 'amount_untaxed', 'invoice_ids'] })) as Rec[]) {
          const name = String(so.name ?? '');
          orders.set(so.id as number, {
            name,
            value: so.amount_untaxed == null ? null : Number(so.amount_untaxed),
            invoiceIds: idList(so.invoice_ids),
          });
          if (name) orderNames.add(name);
        }
      }
      const invoiceIds = [...new Set([...orders.values()].flatMap((o) => o.invoiceIds))];
      for (const part of idChunks(invoiceIds, CHUNK)) {
        for (const inv of (await call('account.move', 'read', [part], { fields: ['state'] })) as Rec[]) {
          invoiceStates.set(inv.id as number, String(inv.state ?? ''));
        }
      }
    } catch {
      has.invoiceState = false;
      orders.clear();
      invoiceStates.clear();
      orderNames.clear();
      notes.push('The sale orders behind these jobs could not be read, so no job carries a value and its invoicing reads as unchecked rather than as not invoiced.');
    }
  }

  for (const job of allJobs) {
    const order = job.saleOrderId != null ? orders.get(job.saleOrderId) : undefined;
    if (!order) continue;   // no quotation, or the chain went unread — stays value null / 'unknown'
    job.saleOrderName = order.name || job.saleOrderName;
    job.value = order.value;
    const states = order.invoiceIds.map((id) => invoiceStates.get(id));
    if (states.some((s) => s === 'posted')) job.invoiceState = 'posted';
    else if (states.some((s) => s === 'draft')) job.invoiceState = 'draft';
    else if (states.some((s) => s == null)) job.invoiceState = 'unknown';   // an invoice we could not read is not an invoice we know about
    // Nothing raised, or every bill withdrawn: a cancelled invoice leaves the
    // job as unbilled as one that never had one, and 'unknown' stays reserved
    // for what could not be read.
    else job.invoiceState = 'none';
  }

  // ── Unposted customer invoices ──
  const draftInvoices: CeoInvoice[] = [];
  const unknownInvoices = new Map<string, number>();
  const moveMeta = await readFieldsMeta('account.move');
  if (!moveMeta) {
    notes.push('account.move could not be read on this instance, so no unposted invoice could be listed.');
  } else {
    const moveHas = (f: string) => hasOwn(moveMeta, f);
    has.invoiceOrigin = moveHas('invoice_origin');
    if (!has.invoiceOrigin) {
      notes.push('account.move has no source document field (invoice_origin) here, so the overlap between unposted invoices and uninvoiced jobs cannot be identified on this instance.');
    }
    if (!moveHas('invoice_date')) {
      notes.push('Unposted invoices carry no invoice date here, so only the date the draft was created is available.');
    }
    if (!moveHas('amount_untaxed')) {
      notes.push('account.move carries no untaxed amount here, so every unposted invoice reads as 0.');
    }

    const moveFields = ['name', 'company_id', 'create_date', ...['partner_id', 'invoice_origin', 'invoice_date', 'amount_untaxed'].filter(moveHas)];
    // Draft only, and never 'cancel': a cancelled invoice is a decision somebody
    // took, not revenue going unbooked. excludeInternalSales() is what keeps
    // unposted EVS-to-EVS transfers out — without it the same money moving
    // between our own companies would be reported to the CEO as lost revenue.
    const moveDomain: OdooDomain = [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'draft'],
      ['company_id', 'in', companyIds],
      ...(await excludeInternalSales()),
    ];
    for (const inv of await searchReadAll('account.move', moveDomain, moveFields)) {
      const company = m2o(inv.company_id);
      const where = company ? index.get(company[0]) : undefined;
      if (!where) {
        const name = company?.[1] || 'no company';
        unknownInvoices.set(name, (unknownInvoices.get(name) ?? 0) + 1);
        continue;
      }
      const id = inv.id as number;
      const origin = typeof inv.invoice_origin === 'string' ? inv.invoice_origin : '';
      const name = String(inv.name ?? '');
      draftInvoices.push({
        id,
        // A draft usually has no number yet, and Odoo stores '/' for it; a row
        // the CEO cannot name is a row he cannot chase.
        name: name && name !== '/' ? name : `Draft #${id}`,
        url: odooRecordUrl('account.move', id, company![0]),
        branch: where.branch,
        site: where.site,
        companyId: company![0],
        customer: m2oName(inv.partner_id),
        created: odooTime(inv.create_date),
        invoiceDate: dateOnly(inv.invoice_date),
        amount: Number(inv.amount_untaxed ?? 0),
        origin,
        saleOrderNames: origin ? parseOrigin(origin, orderNames) : [],
      });
    }
  }

  const jobsNote = unknownCompanyNote(unknownJobs, 'repair orders');
  if (jobsNote) notes.push(jobsNote);
  const invoicesNote = unknownCompanyNote(unknownInvoices, 'customer invoices');
  if (invoicesNote) notes.push(invoicesNote);

  // ── Historical orders ──
  const historical = await historicalRepairCounts();
  // The branches are being migrated one at a time, so a half-migrated branch
  // would read as spotless unless the page says what it is not showing.
  const parked = (Object.entries(historical) as [Branch, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (parked.length) {
    const list = parked.map(([branch, n]) => `${branch} ${n.toLocaleString('en-US')}`).join(', ');
    notes.push(`Historical Orders are excluded from every figure here: ${list}. A branch that has been moved to Historical Orders shows only the jobs opened since.`);
  }

  return { openJobs, repairedNotInvoiced, draftInvoices, historical, has, notes };
}

// ── Memo ───────────────────────────────────────────────────────────

type Entry = { key: string; promise: Promise<CeoData>; at?: number };
let memo: Entry | null = null;

/**
 * The shared population, read at most once per two minutes per set of params.
 * The in-flight promise is cached too, so four tabs opening at once share one
 * read; a rejected load is dropped so the next request retries instead of
 * replaying the failure.
 *
 * Keyed on all of params rather than on the open rule alone: nothing here reads
 * the window today, and a key on a subset would quietly serve one caller's
 * figures to another the day something does.
 */
export function loadCeoData(params: ReportParams): Promise<CeoData> {
  const key = JSON.stringify([params.openRoDomain, params.days, params.thresholds]);
  if (memo && memo.key === key && (memo.at == null || Date.now() - memo.at < TTL_MS)) return memo.promise;

  const entry: Entry = { key, promise: load(params) };
  entry.promise.then(
    () => { entry.at = Date.now(); },
    () => { if (memo === entry) memo = null; },
  );
  memo = entry;
  return entry.promise;
}
