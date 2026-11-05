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
  HISTORICAL_FIELD,
  DOM_REPAIRED_NOT_INVOICED,
  PRIORITY_MATRIX_LABELS,
  type OdooDomain,
} from '../odoo';
import { readFieldsMeta, resolvePartsFields, resolveTagMatches, hasAnyTag, type FieldsMeta } from '../kpi';
import { companyIndex, idChunks, m2o, m2oName, odooTime, readChunked, searchReadAll, unknownCompanyNote, type Rec } from './common';
import { odooRecordUrl } from '../odoo-link';
import type { ReportParams } from './types';

/** Ids per request — keeps every payload, and Odoo's IN clause, a sane size. */
const CHUNK = 2000;
/** Long enough to cover opening all four tabs; short enough that a refresh soon sees a posted invoice. */
const TTL_MS = 2 * 60 * 1000;

/** The vehicle link is named differently per instance; the same list the Excel export probes. */
const VEHICLE_FIELDS = ['fleet_id', 'vehicle_id', 'lot_id', 'x_vehicle_id', 'x_vehicle'];

/** Matches tag names like "Warranty", "WARRANTY JOB", "Under warranty". */
const WARRANTY_TAG_RE = /warrant/i;

/** Matches the warranty button's own field name — is_warranty, warranty, under_warranty, x_studio_warranty. */
const WARRANTY_FLAG_RE = /warrant/i;

/**
 * Matches the accounting journal an SRN service note is raised in, by name or
 * by code — "SRN", "SRN Notes", "Service Notes", "service note".
 *
 * Anchored at the start of a word rather than a bare /srn/i: the three letters
 * appear inside ordinary words, and a journal matched by accident would
 * silently zero a real customer invoice — the opposite of the mistake this rule
 * exists to correct.
 *
 * No closing \b, though. Journal codes are short and numbered, so the one this
 * has to catch is as likely to read SRN1 or SRNAE as a bare SRN, and \bSRN\b
 * matches none of those — it would find nothing and quietly leave every service
 * note counted as customer revenue.
 */
const SERVICE_NOTE_RE = /\bSRN|service\s*note/i;

/**
 * Where parts lines and labour lines live on repair.order, across the versions
 * this instance might be on: Odoo 17 keeps parts in `move_ids` where older ones
 * used `operations`, and labour in `fee_ids` where they used `fees_lines`.
 *
 * Which of the two lists a relation came from is used for nothing but naming
 * what marked a job, so a relation in neither still counts — it is only called
 * "line" rather than guessed at.
 */
const PARTS_LINE_FIELDS = ['move_ids', 'operations', 'repair_line_ids', 'move_ids_without_package', 'part_ids'];
const LABOUR_LINE_FIELDS = ['fee_ids', 'fees_lines', 'repair_fee_ids', 'service_ids'];

/**
 * A line table somebody added in Studio, caught by name because no fixed list
 * can enumerate what an instance has been customised with. Deliberately narrow:
 * every relation it matches costs a fields_get, and a comodel that is not a
 * line table at all could carry a warranty boolean meaning something else.
 */
const EXTRA_LINE_FIELD_RE = /line|fee|labou?r/i;

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
  /**
   * The untaxed total of this order's posted invoices, and of its draft ones.
   *
   * Whether a bill exists says nothing about whether the work has been paid
   * for: a job billed for part of its value and never billed for the rest is
   * indistinguishable from a settled one by `invoiceState` alone, and the
   * matrix status is not reliably set to Closed and Invoiced here, so neither
   * can stand in for "has been billed". The amounts can.
   *
   * These are the *order's* figures, not the job's. One sale order can carry
   * several repair orders — the KPI engine's `deadQuotations` exists for
   * exactly that — so a job's own share of either total is not separable, and
   * two jobs on one order read the same pair of numbers.
   *
   * null is the chain unread, exactly as 'unknown' is on `invoiceState` above:
   * not checked, which is a different fact from checked and nothing found. Zero
   * is the second one.
   */
  postedValue: number | null;
  draftValue: number | null;
  /**
   * Warranty work: tagged for it, or with the warranty button set on one of its
   * lines. EVS never bills the customer for it, so its value is not money at
   * risk — but the job card is still open and still has to be closed, so the
   * row stays wherever it would have been.
   */
  warranty: boolean;
  /**
   * What marked it — 'tag', 'parts line', 'labour line' — and '' when it is not
   * warranty. '' is also what every job reads as when neither signal could be
   * read, so `has` below decides whether 'not warranty' means anything.
   */
  warrantyVia: string;
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
  /**
   * An SRN service note: warranty, raised in its own accounting journal, and
   * never billed to the customer — so its amount is not money anybody is
   * waiting for. The row still stands, because an unposted service note is
   * still paperwork somebody has to post.
   *
   * False is also what every invoice reads as when the journal could not be
   * identified at all, so `has.serviceNoteJournal` below decides whether "not a
   * service note" means anything.
   */
  serviceNote: boolean;
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
    warrantyTag: boolean;        // a tag named for warranty exists in one of the repair-order tag fields
    warrantyLineFlag: boolean;   // a parts or labour line model carries a warranty boolean
    serviceNoteJournal: boolean; // at least one journal behind the unposted invoices is named or coded for service notes
  };
  notes: string[];
}

// ── What the invoiced amounts mean ─────────────────────────────────
// Derived here rather than on each tab, because "Needs attention" and
// "Repaired, not invoiced" have to agree about which job is settled and how
// much of it is still owed: two copies of this arithmetic would drift, and the
// headline tile on one page would stop reconciling with the list on the other.

/** Untaxed value of the order still not on any invoice, posted or draft. */
export function uninvoicedValue(job: CeoJob): number | null {
  // Any unknown and nothing can be concluded. A missing total treated as zero
  // would print the whole order as money owed on a job that may well be paid.
  if (job.value == null || job.postedValue == null || job.draftValue == null) return null;
  // Floored at zero: over-invoicing an order is somebody else's problem, and a
  // negative here would subtract from the money at risk on the other rows.
  return Math.max(0, job.value - job.postedValue - job.draftValue);
}

/**
 * What a job is treated as owing — the uninvoiced part, or the whole quotation
 * where that could not be worked out.
 *
 * An unread invoice chain is not evidence of payment. Letting it fall to zero
 * would quietly shrink the money at risk on exactly the jobs this read failed
 * on, which is the one direction the figure must never move by accident: a
 * number that drops because a query broke looks identical to a number that
 * drops because the branches did their job. Over-stating is visible and
 * correctable; under-stating is neither.
 */
export function moneyAtRisk(job: CeoJob): number {
  return uninvoicedValue(job) ?? job.value ?? 0;
}

/** Posted invoices cover the order: finished and billed, whatever the matrix status says. */
export function fullyBilled(job: CeoJob): boolean {
  if (job.value == null || job.postedValue == null) return false;
  // One AED of tolerance, because both sides are floating-point sums of line
  // amounts and a settled order lands a fraction of a fils either side of its
  // own total. Unknown is false above, never "billed": a chain this read could
  // not follow must keep its row, or a job vanishes on missing data.
  return job.value - job.postedValue < 1;
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

/** What to call a line in this relation on the row that says why a job is warranty. */
function lineVia(field: string): string {
  if (PARTS_LINE_FIELDS.includes(field)) return 'parts line';
  if (LABOUR_LINE_FIELDS.includes(field)) return 'labour line';
  // A relation recognised only by its name: "line" says what we know and no more.
  return 'line';
}

/**
 * The boolean on a line model that is the warranty button, or null.
 *
 * Discovered rather than hardcoded: the field is `is_warranty` on one instance
 * and `x_studio_warranty` on the next. The names are sorted so a model carrying
 * two matching booleans resolves to the same one on every refresh instead of to
 * whatever order the server answered in — the note names the field it used, and
 * a note that changed between reads would be unreadable.
 */
async function warrantyFlagOn(model: string): Promise<string | null> {
  try {
    const fields = (await call(model, 'fields_get', [], { attributes: ['type'] })) as Record<string, { type?: string }>;
    return Object.keys(fields).sort().find((f) => fields[f]?.type === 'boolean' && WARRANTY_FLAG_RE.test(f)) ?? null;
  } catch {
    // A comodel we cannot read contributes nothing, exactly like one without the
    // field — and the caller counts how many signals it ended up with, so an
    // instance where every probe failed says warranty cannot be identified
    // rather than that there is none.
    return null;
  }
}

// ── The population ─────────────────────────────────────────────────

async function load(params: ReportParams): Promise<CeoData> {
  const notes: string[] = [];
  const has = { statusSince: false, saleOrderId: false, vehicle: false, invoiceOrigin: false, invoiceState: true, warrantyTag: false, warrantyLineFlag: false, serviceNoteJournal: false };

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

  // Resolved before the read below so the tag fields that matter can ride along
  // in it: they are small id arrays, and testing membership in memory keeps the
  // warranty mark on exactly the population the rest of this read describes.
  // The same helper the KPI engine uses for its insurance tag, so both pages
  // agree about where this instance keeps tags and which comodel an id is in.
  const warrantyTags = await resolveTagMatches([], meta, WARRANTY_TAG_RE);
  const warrantyTagFields = warrantyTags.filter((m) => m.ids.size).map((m) => m.field);
  has.warrantyTag = warrantyTagFields.length > 0;

  const roFields = [
    'name', 'company_id', 'create_date',
    ...['state', 'priority_matrix_status', 'partner_id', 'create_uid', 'sale_order_id', 'status_since'].filter(roHas),
    ...(vehicleField ? [vehicleField] : []),
    // Only the fields that actually hold a warranty tag: asking for one that
    // does not exist would cost the whole read, not one column.
    ...warrantyTagFields,
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
    // Settled here, off the read above; the warranty button on the lines needs
    // its own read and is applied to both populations further down.
    const tagged = hasAnyTag(r, warrantyTags);
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
      postedValue: null,
      draftValue: null,
      warranty: tagged,
      warrantyVia: tagged ? 'tag' : '',
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
  /** Invoice id → its state and untaxed amount. Absent is an invoice this read could not see, which is not the same as one that is not there. */
  const invoices = new Map<number, { state: string; amount: number }>();
  const orderNames = new Set<string>();

  // account.move's fields are needed for the unposted-invoice list further down
  // in any case; read here because the invoice amounts below depend on one of
  // them. Asking for a field this instance has not got costs the whole read
  // rather than one column, and that read is also where every job's value comes
  // from — so losing it would leave the jobs without even their quotation value.
  const moveMeta = await readFieldsMeta('account.move');
  const hasInvoiceAmount = moveMeta != null && hasOwn(moveMeta, 'amount_untaxed');

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
        // amount_untaxed rides along on the state read rather than costing a
        // second query: how much of an order has actually been billed is the
        // only way to tell a part-invoiced job from a settled one, and the
        // state on its own cannot say.
        const fields = hasInvoiceAmount ? ['state', 'amount_untaxed'] : ['state'];
        for (const inv of (await call('account.move', 'read', [part], { fields })) as Rec[]) {
          invoices.set(inv.id as number, { state: String(inv.state ?? ''), amount: Number(inv.amount_untaxed ?? 0) });
        }
      }
    } catch {
      has.invoiceState = false;
      orders.clear();
      invoices.clear();
      orderNames.clear();
      notes.push('The sale orders behind these jobs could not be read, so no job carries a value and its invoicing reads as unchecked rather than as not invoiced.');
    }
  }

  for (const job of allJobs) {
    const order = job.saleOrderId != null ? orders.get(job.saleOrderId) : undefined;
    if (!order) continue;   // no quotation, or the chain went unread — stays value null / 'unknown'
    job.saleOrderName = order.name || job.saleOrderName;
    job.value = order.value;
    const states = order.invoiceIds.map((id) => invoices.get(id)?.state);
    if (states.some((s) => s === 'posted')) job.invoiceState = 'posted';
    else if (states.some((s) => s === 'draft')) job.invoiceState = 'draft';
    else if (states.some((s) => s == null)) job.invoiceState = 'unknown';   // an invoice we could not read is not an invoice we know about
    // Nothing raised, or every bill withdrawn: a cancelled invoice leaves the
    // job as unbilled as one that never had one, and 'unknown' stays reserved
    // for what could not be read.
    else job.invoiceState = 'none';

    // Totalled per state, so how much of the order is billed can be subtracted
    // from what it is worth. Both totals go null the moment one of the order's
    // invoices went unread, or the amount could not be asked for at all: a sum
    // missing an invoice reads as money still owed, and a job that is in fact
    // settled would be left on the page as an exception against a bill that
    // exists. An order with no invoices at all sums to zero, which is the
    // honest answer — nothing has been billed.
    const unread = !hasInvoiceAmount || order.invoiceIds.some((id) => !invoices.has(id));
    const billed = (state: string): number => order.invoiceIds.reduce((total, id) => {
      const inv = invoices.get(id);
      return inv?.state === state ? total + inv.amount : total;
    }, 0);
    job.postedValue = unread ? null : billed('posted');
    job.draftValue = unread ? null : billed('draft');
  }

  if (has.saleOrderId && saleOrderIds.length && !hasInvoiceAmount) {
    // Said plainly, because the consequence is a page that looks complete: with
    // no amount to compare against, no finished job can be identified as
    // already billed and every one keeps its whole quotation value.
    // Which of the two it was, named: a field this instance has not got is a
    // configuration somebody can fix, and a model that would not read at all is
    // not — and the second also costs the unposted-invoice list below.
    const why = moveMeta ? 'account.move carries no untaxed amount here' : 'account.move could not be read here';
    notes.push(`${why}, so how much of each quotation has actually been invoiced could not be worked out: no job was identified as already billed, and every finished job carries the full value of its quotation rather than only the part still unbilled.`);
  }

  // ── Warranty work ──
  // A warranty job is real work on a real job card, but EVS will never bill the
  // customer for it, so its value is not money at risk. The tag side is already
  // marked, off the read above; what is left is the warranty button on the
  // lines, whose field name is unknown and whose labour relation is named
  // differently per Odoo version — so both are discovered rather than assumed.
  const parts = await resolvePartsFields(meta);
  const lineRelations = [
    // The parts relation the KPI engine resolves, so warranty reads the same
    // table the parts shortage does rather than a second opinion about it.
    ...(parts ? [parts.lineField] : []),
    ...PARTS_LINE_FIELDS,
    ...LABOUR_LINE_FIELDS,
    ...Object.keys(meta).filter((f) => EXTRA_LINE_FIELD_RE.test(f)),
  ].filter((f) => meta[f]?.relation && (meta[f]?.type === 'one2many' || meta[f]?.type === 'many2many'));

  /** One source per comodel — the relation that reached it first. */
  const lineSources: { field: string; model: string; flag: string; via: string }[] = [];
  const probed = new Set<string>();
  for (const field of [...new Set(lineRelations)]) {
    const model = meta[field]!.relation!;
    // Cached per model, not per relation: two relations can be views onto the
    // same table — move_ids and move_ids_without_package are — and a probe is a
    // round trip that would then read the same lines twice.
    if (probed.has(model)) continue;
    probed.add(model);
    const flag = await warrantyFlagOn(model);
    if (flag) lineSources.push({ field, model, flag, via: lineVia(field) });
  }
  has.warrantyLineFlag = lineSources.length > 0;

  /** Job id → what marked it. Keyed by id because one job can be in both populations. */
  const lineWarranty = new Map<number, string>();
  const unreadable: string[] = [];

  if (lineSources.length && allJobs.length) {
    const jobIds = [...new Set(allJobs.map((j) => j.id))];
    for (const src of lineSources) {
      try {
        const byJob = new Map<number, number[]>();
        const lineIds = new Set<number>();
        for (const r of await readChunked('repair.order', jobIds, [src.field], CHUNK)) {
          const ids = idList(r[src.field]);
          byJob.set(r.id as number, ids);
          for (const id of ids) lineIds.add(id);
        }
        const flagged = new Set<number>();
        for (const part of idChunks([...lineIds], CHUNK)) {
          for (const line of (await call(src.model, 'read', [part], { fields: [src.flag] })) as Rec[]) {
            if (line[src.flag] === true) flagged.add(line.id as number);
          }
        }
        // One line is enough: a job with a single warranty part is warranty work.
        for (const [jobId, ids] of byJob) {
          if (!lineWarranty.has(jobId) && ids.some((id) => flagged.has(id))) lineWarranty.set(jobId, src.via);
        }
      } catch {
        // Caught per source so one unreadable relation costs neither the other
        // nor the tag signal, and is named in the note below rather than read as
        // "no warranty work on those lines".
        unreadable.push(`${src.model}.${src.flag}`);
      }
    }
  }

  for (const job of allJobs) {
    const via = lineWarranty.get(job.id);
    // A tag already marked it, and the tag is the job-level statement — the line
    // flag only says which line carried the button.
    if (via && !job.warranty) {
      job.warranty = true;
      job.warrantyVia = via;
    }
  }

  // What the page could actually see, stated plainly either way. A signal that
  // is missing and goes unsaid reads as "no warranty work anywhere", which is a
  // clean-looking wrong number — the exact thing this exclusion exists to stop.
  const flagList = lineSources.map((s) => `${s.model}.${s.flag}`).join(' and ');
  const noTag = warrantyTags.length
    ? 'No repair-order tag here is named for warranty'
    : 'repair.order carries no tag field here, so no tag can identify warranty work';
  if (has.warrantyTag && has.warrantyLineFlag) {
    notes.push(`Warranty work carries no money at risk, because EVS never bills the customer for it. A job counts as warranty when a repair-order tag is named for warranty, or when the warranty flag on its lines (${flagList}) is set.`);
  } else if (has.warrantyLineFlag) {
    notes.push(`Warranty work carries no money at risk, because EVS never bills the customer for it. ${noTag}, so a job counts as warranty only through the warranty flag on its lines (${flagList}).`);
  } else if (has.warrantyTag) {
    notes.push('Warranty work carries no money at risk, because EVS never bills the customer for it. No parts or labour line on repair.order carries a warranty flag on this instance, so warranty work is identified by tag alone: a job marked as warranty only on its lines still counts towards the money at risk.');
  } else {
    notes.push(`Warranty work cannot be identified on this instance at all: ${noTag}, and no parts or labour line carries a warranty flag. The money at risk therefore still includes warranty work, which EVS will never bill.`);
  }
  if (unreadable.length) {
    notes.push(`The warranty flag on ${unreadable.join(' and ')} could not be read, so no job was identified as warranty work through ${unreadable.length === 1 ? 'it' : 'them'} and a job marked as warranty only there still counts towards the money at risk.`);
  }

  // ── Invoices raised against a parked job card ──
  // The two repair-order populations above drop Historical Orders in their
  // domains; account.move cannot, because it carries no is_historical and the
  // query below never joins back to a job card. Without this lookup an unposted
  // invoice for a job since parked still lists and still carries its full
  // amount into the money at risk, so a branch already migrated reads as owing
  // money it does not.
  //
  // Followed by id — parked job card → sale_order_id → that order's invoice_ids
  // — never by invoice_origin text: the origin string is parsed for display
  // only, and a wrong textual match would delete a real exception.
  const historicalInvoiceIds = new Set<number>();
  let parkedInvoices = 0;

  // An empty clause means repair.order has no is_historical on this instance,
  // not that nothing is parked, so there is nothing to exclude and no caveat to
  // give: the lookup is skipped whole.
  if ((await notHistorical()).length) {
    if (!has.saleOrderId) {
      notes.push('Without a sale order link on repair.order there is no way to tell which unposted invoice belongs to which job card, so every unposted invoice is listed here and the money at risk may still include job cards moved to Historical Orders.');
    } else {
      try {
        const parkedJobs = await searchReadAll(
          'repair.order',
          [[HISTORICAL_FIELD, '=', true], ['company_id', 'in', companyIds]],
          ['sale_order_id'],
        );
        const parkedOrderIds = [...new Set(parkedJobs.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))]
          // A sale order a live job card still points at keeps its invoices.
          // One order can carry several repair orders — the KPI engine's
          // deadQuotations exists for exactly that — so parking one of them is
          // no reason to hide money still owed on another that is open.
          .filter((id) => !orders.has(id));
        for (const part of idChunks(parkedOrderIds, CHUNK)) {
          for (const so of (await call('sale.order', 'read', [part], { fields: ['invoice_ids'] })) as Rec[]) {
            for (const invoiceId of idList(so.invoice_ids)) historicalInvoiceIds.add(invoiceId);
          }
        }
      } catch {
        // Every invoice is kept, and the figure says so. Dropping the ones a
        // half-finished lookup happened to reach would remove some exceptions
        // and keep others on no principle at all, and silently at that.
        historicalInvoiceIds.clear();
        notes.push('The unposted invoices belonging to job cards in Historical Orders could not be identified, so none were left out: this list and the money at risk may still include invoices for job cards already moved to Historical Orders.');
      }
    }
  }

  // ── Unposted customer invoices ──
  const draftInvoices: CeoInvoice[] = [];
  const unknownInvoices = new Map<string, number>();
  /**
   * Draft invoice id → the journal it was raised in: the marker for a service
   * note. Kept aside rather than put on the row, because the journal's name and
   * code are resolved in one read below — a read per invoice would be a round
   * trip per row on a list that runs to hundreds.
   */
  const draftJournals = new Map<number, number>();
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

    // journal_id rides along only where it exists: asking for a field this
    // instance has not got would cost the whole read, not one column — and the
    // service-note rule below says so rather than reading its absence as "no
    // service notes here".
    const moveFields = ['name', 'company_id', 'create_date', ...['partner_id', 'invoice_origin', 'invoice_date', 'amount_untaxed', 'journal_id'].filter(moveHas)];
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
      // Dropped where the other two populations drop theirs — before the row is
      // built — so the amount cannot reach a total by any other path. Only an
      // invoice traced to a parked job card goes: one with no repair order
      // behind it at all stays, because EV Hub has no workshop and its genuine
      // customer invoices would otherwise empty the branch.
      if (historicalInvoiceIds.has(inv.id as number)) {
        parkedInvoices++;
        continue;
      }
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
      const journal = m2o(inv.journal_id);
      if (journal) draftJournals.set(id, journal[0]);
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
        // Settled below, off one read of the journals: the row has to exist
        // before its journal can be looked at, and looking at them one at a
        // time would be a round trip per invoice.
        serviceNote: false,
      });
    }

    if (parkedInvoices) {
      notes.push(`Left out of this list and of the money at risk: ${parkedInvoices.toLocaleString('en-US')} unposted invoice${parkedInvoices === 1 ? '' : 's'} whose job card has been moved to Historical Orders.`);
    }

    // ── Service notes ──
    // An SRN service note is warranty: EVS raises it against a vehicle it will
    // never bill the customer for, so its amount is not money anybody is
    // waiting for — exactly like a warranty job above, and zeroed the same way.
    //
    // The journal is the marker, because it is the only one that exists while
    // the note is unposted: a draft usually has no document number yet (Odoo
    // stores '/', which is why the row above falls back to `Draft #${id}`),
    // whereas journal_id is set the moment the note is raised.
    //
    // Nothing is dropped from the list. An unposted service note is still
    // paperwork somebody has to post, and hiding the row would lose a real task.
    //
    // Skipped whole when nothing is in draft: with no unposted invoice there is
    // no amount the rule could have been wrong about, and a caveat about an
    // empty list is noise on the three tabs that share these notes.
    if (draftInvoices.length) {
      if (!moveHas('journal_id')) {
        notes.push('account.move carries no journal field (journal_id) here, so service notes could not be identified on this instance and every unposted invoice keeps its amount: the money at risk may still include warranty work that will never be billed to a customer.');
      } else {
        try {
          /** The journals that are service-note journals, and what to call them in the note. */
          const srnJournals = new Set<number>();
          const srnNames = new Set<string>();
          for (const part of idChunks([...new Set(draftJournals.values())], CHUNK)) {
            for (const j of (await call('account.journal', 'read', [part], { fields: ['name', 'code'] })) as Rec[]) {
              const journalName = String(j.name ?? '');
              const journalCode = String(j.code ?? '');
              // Either side counts: one instance spells it out in the name and
              // codes it something else, the next codes it SRN and names it in
              // full, and matching only one of the two would read a real
              // service-note journal as an ordinary sales journal.
              if (!SERVICE_NOTE_RE.test(journalName) && !SERVICE_NOTE_RE.test(journalCode)) continue;
              srnJournals.add(j.id as number);
              srnNames.add(journalName || journalCode);
            }
          }
          // Marked only once every journal has been read, so a lookup that
          // throws half way through leaves every invoice with its money rather
          // than zeroing the ones it happened to reach.
          has.serviceNoteJournal = srnJournals.size > 0;
          for (const inv of draftInvoices) {
            const journal = draftJournals.get(inv.id);
            inv.serviceNote = journal != null && srnJournals.has(journal);
          }

          if (has.serviceNoteJournal) {
            // Sorted so the note reads the same on every refresh rather than in
            // whatever order the server answered in.
            const list = [...srnNames].sort().join(' and ');
            notes.push(`Service notes carry no money at risk, because a service note is warranty work EVS never bills the customer for. An unposted invoice counts as a service note when the journal it was raised in (${list}) is named or coded for service notes; the invoice is still listed, because somebody still has to post it.`);
          } else {
            // The distinction matters: a marker that matched nothing is a rule
            // that is not running, and saying so is the difference between a
            // figure the CEO can trust and one that looks clean because the
            // exclusion silently did nothing.
            notes.push('No journal behind these unposted invoices is named or coded for service notes (SRN), so none could be identified as one and every unposted invoice keeps its amount: the money at risk may still include warranty work that will never be billed to a customer.');
          }
        } catch {
          notes.push('The journals these unposted invoices were raised in could not be read, so no invoice could be identified as a service note and every one keeps its amount: the money at risk may still include warranty work that will never be billed to a customer.');
        }
      }
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
export function loadCeoData(params: ReportParams, refresh = false): Promise<CeoData> {
  const key = JSON.stringify([params.openRoDomain, params.days, params.thresholds]);
  // `refresh` is the Refresh button. Without it the registry rebuilds the report
  // off this memo and the page re-renders the same Odoo read, so a record the
  // user has just fixed in Odoo is still on screen and the button looks broken.
  if (!refresh && memo && memo.key === key && (memo.at == null || Date.now() - memo.at < TTL_MS)) return memo.promise;

  const entry: Entry = { key, promise: load(params) };
  entry.promise.then(
    () => { entry.at = Date.now(); },
    () => { if (memo === entry) memo = null; },
  );
  memo = entry;
  return entry.promise;
}
