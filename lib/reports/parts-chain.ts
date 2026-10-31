/**
 * The open-parts population the two purchasing-chain reports share.
 *
 * "Parts without RFQ" and "Open parts and why" ask different questions of the
 * same facts — which open repair orders are short of parts, which parts, and
 * which purchase orders were raised for them. Reading those facts in one place
 * keeps the two tabs agreeing about every repair order, and the memo below
 * means opening both costs one Odoo read, not two.
 *
 * The purchase-order link is KPI 18's (lib/kpi.ts) seen from the other side: a
 * purchase order reaches a repair order only through the vehicle, and counts
 * for this visit only if it was raised once the job card existed.
 */

import { WORKSHOP_BRANCHES, type Branch } from '../types';
import { call, notHistorical, type OdooDomain } from '../odoo';
import { readFieldsMeta, resolvePartsFields, type FieldsMeta } from '../kpi';
import { companyIndex, companyIdsFor, idChunks, m2o, odooTime, poTime, searchReadAll, type Rec } from './common';
import type { ReportParams } from './types';

/** Ids per request — keeps every payload, and Odoo's IN clause, a sane size. */
const CHUNK = 2000;
/** Long enough to cover opening both tabs; short enough that a refresh soon sees a new RFQ. */
const TTL_MS = 2 * 60 * 1000;

/** Not yet committed to. Note the space in 'to approve' — that is the stored value, not a label. */
export const RFQ_STATES: readonly string[] = ['draft', 'sent', 'to approve'];
export const CONFIRMED_STATES: readonly string[] = ['purchase', 'done'];

// ── Shapes ─────────────────────────────────────────────────────────

export interface ShortLine {
  id: number;
  productId: number | null;
  /** Product display name, '' when the line carries none. */
  product: string;
  demand: number;
  done: number;
  /** When the part was put on the job — the repair order's own creation when the line has no stamp. */
  added: number | null;
  /** stock.move state, null where this instance has no state field. */
  state: string | null;
}

export interface OpenRo {
  id: number;
  name: string;
  branch: Branch;
  site: string;
  vehicleId: number | null;
  vehicle: string | null;
  customer: string | null;
  created: number | null;
  /** Selection label of repair_state, or of state where repair_state is absent or unset. */
  status: string;
  /** Odoo's "All Parts are available"; null when it was not read for this order. */
  partsAvailable: boolean | null;
  /** Only the lines still short — an order with none is not in the population at all. */
  short: ShortLine[];
  /**
   * Purchase orders linked to this visit. Empty when there is no vehicle to link
   * through; null when the vehicle's purchase orders could not be read — "no
   * RFQ" and "could not look" must never read the same.
   */
  poIds: number[] | null;
}

export interface LinkedPo {
  id: number;
  name: string;
  state: string;
  stateLabel: string;
  created: number | null;
  /** Confirmation Date (date_approve). */
  approved: number | null;
  /** Expected Arrival (date_planned). */
  planned: number | null;
  /** Arrival (effective_date) — set once a receipt has been validated. */
  arrived: number | null;
}

export interface PoLine {
  orderId: number;
  productId: number | null;
  qty: number;
  /** null where purchase.order.line has no qty_received. */
  received: number | null;
  planned: number | null;
}

export interface PoLines {
  byOrder: Map<number, PoLine[]>;
  /** Orders whose lines could not be read — a part on one of them has an unknown stage. */
  unread: Set<number>;
  /** False when purchase.order.line has no qty_received and "received" falls back to the Arrival date. */
  hasReceived: boolean;
  notes: string[];
}

export interface PartsChain {
  /** Open workshop repair orders with at least one part short. */
  ros: OpenRo[];
  /** Every purchase order linked to at least one of `ros`. */
  pos: Map<number, LinkedPo>;
  /** Optional reads that worked here; each report words its own fallback. */
  has: { partsAvailable: boolean; moveState: boolean };
  /** Caveats that apply to both reports. */
  notes: string[];
  /** The linked orders' lines — read on first ask, since only one report needs them. */
  poLines(): Promise<PoLines>;
}

// ── Helpers ────────────────────────────────────────────────────────

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const idList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);
const plural = (n: number): string => (n === 1 ? '' : 's');

/** A selection's label for a stored value; the raw value when no label is known. */
function selectionLabel(meta: FieldsMeta | null, field: string, value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return meta?.[field]?.selection?.find(([v]) => v === value)?.[1] ?? value;
}

// ── Purchase order lines ───────────────────────────────────────────

async function readPoLines(orderIds: number[]): Promise<PoLines> {
  const out: PoLines = { byOrder: new Map(), unread: new Set(), hasReceived: true, notes: [] };
  if (!orderIds.length) return out;

  const meta = await readFieldsMeta('purchase.order.line');
  const has = (f: string) => !!meta && hasOwn(meta, f);
  if (!['order_id', 'product_id', 'product_qty'].every(has)) {
    for (const id of orderIds) out.unread.add(id);
    out.hasReceived = false;
    out.notes.push('Purchase order lines could not be read on this instance, so a part whose vehicle has an RFQ could not be matched to a line and its stage was left blank.');
    return out;
  }

  out.hasReceived = has('qty_received');
  if (!out.hasReceived) {
    out.notes.push('Purchase order lines carry no received quantity here, so a confirmed order counts as received once it has an Arrival date — a partial delivery reads as complete.');
  }
  const fields = ['order_id', 'product_id', 'product_qty', ...['qty_received', 'date_planned'].filter(has)];
  // Section and note rows are layout on the form, not something being bought.
  const notLayout: OdooDomain = has('display_type') ? [['display_type', '=', false]] : [];

  for (const part of idChunks(orderIds, CHUNK)) {
    try {
      for (const l of await searchReadAll('purchase.order.line', [['order_id', 'in', part], ...notLayout], fields)) {
        const orderId = m2o(l.order_id)?.[0];
        if (orderId == null) continue;
        const line: PoLine = {
          orderId,
          productId: m2o(l.product_id)?.[0] ?? null,
          qty: Number(l.product_qty ?? 0),
          received: out.hasReceived ? Number(l.qty_received ?? 0) : null,
          planned: poTime(l.date_planned),
        };
        const list = out.byOrder.get(orderId);
        if (list) list.push(line);
        else out.byOrder.set(orderId, [line]);
      }
    } catch {
      // A failed chunk leaves its orders unknown rather than empty: "no line for
      // this part" would otherwise read as "nobody asked a supplier for it".
      for (const id of part) out.unread.add(id);
    }
  }
  if (out.unread.size) {
    const n = out.unread.size;
    out.notes.push(`The lines of ${n} purchase order${plural(n)} could not be read, so parts on ${n === 1 ? 'its' : 'their'} repair orders were left without a stage.`);
  }
  return out;
}

/** Read the lines once, on first ask; a rejected read is forgotten so the next ask retries. */
function lazyPoLines(orderIds: number[]): () => Promise<PoLines> {
  let pending: Promise<PoLines> | null = null;
  return () => {
    if (!pending) {
      const p = readPoLines(orderIds);
      p.catch(() => {
        if (pending === p) pending = null;
      });
      pending = p;
    }
    return pending;
  };
}

// ── The population ─────────────────────────────────────────────────

async function load(params: ReportParams): Promise<PartsChain> {
  const notes: string[] = [];
  const ros: OpenRo[] = [];
  const pos = new Map<number, LinkedPo>();
  const has = { partsAvailable: false, moveState: false };
  const done = (): PartsChain => ({ ros, pos, has, notes, poLines: lazyPoLines([...pos.keys()]) });

  // Thrown, not noted: without repair.order there is no population at all, and
  // an empty report would read as "nothing waiting" for the whole cache life.
  const meta = await readFieldsMeta('repair.order');
  if (!meta) throw new Error('repair.order could not be read, so the open parts could not be listed.');
  const roHas = (f: string) => hasOwn(meta, f);

  const parts = await resolvePartsFields(meta);
  if (!parts) {
    notes.push('The parts lines (Demand/Done) could not be found on repair.order, so no part could be judged short.');
    return done();
  }

  const companyIds = await companyIdsFor(WORKSHOP_BRANCHES);
  if (!companyIds.length) {
    notes.push('No workshop company could be matched in Odoo, so there were no repair orders to read.');
    return done();
  }
  const index = await companyIndex();

  // "Open" is the KPI page's rule, plus Odoo's own done/cancel on both state
  // fields: the question is about jobs not yet marked done, and a stage map that
  // forgot a closed stage must not drag finished jobs back in. EV Hub runs no
  // workshop, so only workshop companies are read.
  const domain: OdooDomain = [
    ...params.openRoDomain,
    ['state', 'not in', ['done', 'cancel']],
    ...(roHas('repair_state') ? [['repair_state', 'not in', ['done', 'cancel']] as [string, string, unknown]] : []),
    ['company_id', 'in', companyIds],
    ...(await notHistorical()),
  ];
  const roFields = ['name', 'company_id', 'create_date', 'state', parts.lineField, ...['partner_id', 'fleet_id', 'repair_state'].filter(roHas)];
  const roRecs = await searchReadAll('repair.order', domain, roFields);
  if (!roHas('fleet_id')) {
    notes.push('repair.order has no vehicle field (fleet_id) here, so no repair order could be linked to a purchase order.');
  }

  // Product, state and line type are what tell a part being fitted from one
  // being taken out, and a cancelled line from a live one. Each is optional, so
  // a customised stock.move costs its own distinction rather than the report.
  const moveMeta = await readFieldsMeta(parts.model);
  const moveHas = (f: string) => !!moveMeta && hasOwn(moveMeta, f);
  const typed = moveHas('repair_line_type');
  has.moveState = moveHas('state');
  const missing: string[] = [];
  if (!moveHas('product_id')) missing.push('product (parts are unnamed and cannot be matched to purchase order lines)');
  if (!has.moveState) missing.push('state (cancelled lines cannot be skipped)');
  if (!typed) missing.push('line type (removed and recycled parts count as parts being fitted)');
  if (missing.length) notes.push(`Parts lines on this instance carry no ${missing.join('; no ')}.`);

  const lineFields = [parts.demand, parts.done, 'create_date', ...['product_id', 'state', 'repair_line_type'].filter(moveHas)];
  const lineIds = [...new Set(roRecs.flatMap((r) => idList(r[parts.lineField])))];
  const lines = new Map<number, Rec>();
  let unreadLines = 0;
  for (const part of idChunks(lineIds, CHUNK)) {
    try {
      for (const l of (await call(parts.model, 'read', [part], { fields: lineFields })) as Rec[]) lines.set(l.id as number, l);
    } catch {
      unreadLines += part.length;
    }
  }
  if (unreadLines) {
    notes.push(`${unreadLines} parts line${plural(unreadLines)} could not be read and ${unreadLines === 1 ? 'was' : 'were'} left out, so a repair order may be missing a part it is short of.`);
  }

  for (const r of roRecs) {
    const company = m2o(r.company_id);
    const where = company ? index.get(company[0]) : undefined;
    if (!where) continue;   // the domain only admits indexed companies; kept as a guard
    const created = odooTime(r.create_date);

    const short: ShortLine[] = [];
    for (const id of idList(r[parts.lineField])) {
      const l = lines.get(id);
      if (!l) continue;
      // Only parts going INTO the vehicle are ever bought; a removed or recycled
      // part's Demand says nothing about purchasing. An untyped line is kept, as
      // the KPI page keeps it: dropping it would hide a part someone added by hand.
      if (typed && (l.repair_line_type === 'remove' || l.repair_line_type === 'recycle')) continue;
      if (l.state === 'cancel') continue;
      const demand = Number(l[parts.demand] ?? 0);
      const doneQty = Number(l[parts.done] ?? 0);
      // KPI 6's definition of short, so the two pages count the same parts.
      if (!(demand > 0 && doneQty < demand)) continue;
      const product = m2o(l.product_id);
      short.push({
        id,
        productId: product?.[0] ?? null,
        product: product?.[1] ?? '',
        demand,
        done: doneQty,
        // As KPI 6: a line with no stamp is taken to be as old as its job card.
        added: odooTime(l.create_date) ?? created,
        state: typeof l.state === 'string' ? l.state : null,
      });
    }
    if (!short.length) continue;   // nothing short — neither report has anything to say about it

    const vehicle = m2o(r.fleet_id);
    ros.push({
      id: r.id as number,
      name: String(r.name ?? ''),
      branch: where.branch,
      site: where.site,
      vehicleId: vehicle?.[0] ?? null,
      vehicle: vehicle?.[1] || null,
      customer: m2o(r.partner_id)?.[1] || null,
      created,
      status: selectionLabel(meta, 'repair_state', r.repair_state) || selectionLabel(meta, 'state', r.state),
      partsAvailable: null,
      short,
      poIds: [],
    });
  }

  // Read on its own and only for the orders still short: it is a computed
  // field, and a customised compute that fails should cost the flag, not the
  // population. All or nothing, so no order is judged by half a rule.
  has.partsAvailable = roHas('is_parts_available');
  if (has.partsAvailable && ros.length) {
    const avail = new Map<number, boolean>();
    try {
      for (const part of idChunks(ros.map((r) => r.id), CHUNK)) {
        for (const rec of (await call('repair.order', 'read', [part], { fields: ['is_parts_available'] })) as Rec[]) {
          avail.set(rec.id as number, rec.is_parts_available === true);
        }
      }
      for (const ro of ros) ro.partsAvailable = avail.get(ro.id) ?? null;
    } catch {
      has.partsAvailable = false;
    }
  }

  // ── Purchase orders, through the vehicle ──
  const fleetIds = [...new Set(ros.map((r) => r.vehicleId).filter((x): x is number => x != null))];
  const byFleet = new Map<number, LinkedPo[]>();
  /** Vehicles whose purchase orders could not be read — their orders stay unjudged. */
  const unchecked = new Set<number>();
  if (fleetIds.length) {
    const poMeta = await readFieldsMeta('purchase.order');
    const poHas = (f: string) => !!poMeta && hasOwn(poMeta, f);
    if (!poHas('fleet_id')) {
      for (const f of fleetIds) unchecked.add(f);
      notes.push('purchase.order could not be read or has no vehicle field (fleet_id) here, so no repair order could be checked against purchasing.');
    } else {
      const poFields = ['name', 'state', 'fleet_id', 'create_date', ...['date_approve', 'date_planned', 'effective_date'].filter(poHas)];
      for (const part of idChunks(fleetIds, CHUNK)) {
        try {
          // Cancelled orders are out: a withdrawn RFQ is nobody getting the part.
          const recs = await searchReadAll('purchase.order', [['fleet_id', 'in', part], ['state', '!=', 'cancel']], poFields);
          for (const po of recs) {
            const fleet = m2o(po.fleet_id)?.[0];
            if (fleet == null) continue;
            const linked: LinkedPo = {
              id: po.id as number,
              name: String(po.name ?? ''),
              state: String(po.state ?? ''),
              stateLabel: selectionLabel(poMeta, 'state', po.state),
              created: poTime(po.create_date),
              approved: poTime(po.date_approve),
              planned: poTime(po.date_planned),
              arrived: poTime(po.effective_date),
            };
            const list = byFleet.get(fleet);
            if (list) list.push(linked);
            else byFleet.set(fleet, [linked]);
          }
        } catch {
          for (const f of part) unchecked.add(f);
        }
      }
      if (unchecked.size) {
        const n = unchecked.size;
        notes.push(`Purchase orders could not be read for ${n} vehicle${plural(n)}, so ${n === 1 ? 'its' : 'their'} repair orders could not be checked against purchasing.`);
      }
    }
  }

  const links = new Map<number, number>();
  for (const ro of ros) {
    if (ro.vehicleId == null) continue;   // nothing to link through — poIds stays empty
    if (unchecked.has(ro.vehicleId)) {
      ro.poIds = null;
      continue;
    }
    // KPI 18's bound, mirrored: a vehicle collects purchase orders over the
    // years, so only one raised once this job card existed is for this visit.
    const linked = (byFleet.get(ro.vehicleId) ?? [])
      .filter((po) => po.created != null && (ro.created == null || po.created >= ro.created));
    ro.poIds = linked.map((po) => po.id);
    for (const po of linked) {
      pos.set(po.id, po);
      links.set(po.id, (links.get(po.id) ?? 0) + 1);
    }
  }
  const shared = [...links.values()].filter((n) => n > 1).length;
  if (shared) {
    notes.push(`${shared} purchase order${plural(shared)} count${shared === 1 ? 's' : ''} for more than one repair order — the vehicle has several open repair orders, and a purchase order raised after each of them is linked to each.`);
  }

  return done();
}

// ── Memo ───────────────────────────────────────────────────────────

type Entry = { key: string; promise: Promise<PartsChain>; at?: number };
let memo: Entry | null = null;

/**
 * The shared population, read at most once per two minutes per open-RO rule.
 * The in-flight promise is cached too, so both tabs opening at once share one
 * read; a rejected load is dropped so the next request retries instead of
 * replaying the failure.
 */
export function loadPartsChain(params: ReportParams): Promise<PartsChain> {
  const key = JSON.stringify(params.openRoDomain);
  if (memo && memo.key === key && (memo.at == null || Date.now() - memo.at < TTL_MS)) return memo.promise;

  const entry: Entry = { key, promise: load(params) };
  entry.promise.then(
    () => { entry.at = Date.now(); },
    () => { if (memo === entry) memo = null; },
  );
  memo = entry;
  return entry.promise;
}
