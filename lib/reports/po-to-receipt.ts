/**
 * Purchase order to parts received — purchase orders confirmed in the window
 * and how long their parts took to land in the branch stock, plus the ones
 * still on the way.
 *
 * "Received" means Odoo says so: the receipt was validated and the lines'
 * received quantities cover what was ordered. Judged on the order's own goods
 * lines — services never reach a stock location, so a labour or delivery-fee
 * line would otherwise hold an order open forever.
 */

import { readFieldsMeta, type FieldsMeta } from '../kpi';
import { formatNumber } from '../format';
import {
  companyIndex, unknownCompanyNote, m2o, m2oName, poTime, toOdooUtc, gulfDate,
  daysBetween, median, mean, fmtDays, fmtPct, searchReadAll, readChunked, idChunks, type Rec,
} from './common';
import {
  BRANCH_KEY,
  type ReportBuild, type ReportColumn, type ReportModule, type ReportRow, type ReportSummaryItem, type Tone,
} from './types';

const DAY_MS = 86400_000;
const CONFIRMED_STATES = ['purchase', 'done'];
/** Quantities are floats; a received 0.9999999 of 1 is a full receipt, not a part one. */
const EPS = 1e-6;

const ON_TIME = 'On time';
const LATE = 'Late';
const NO_DATE = 'Received, no date';
const OVERDUE = 'Overdue';
const PARTLY = 'Partly received';
const WAITING = 'Waiting';

const COLUMNS: ReportColumn[] = [
  { key: 'po', label: 'PO', kind: 'text' },
  { key: BRANCH_KEY, label: 'Branch', kind: 'text' },
  { key: 'site', label: 'Site', kind: 'text' },
  { key: 'vendor', label: 'Vendor', kind: 'text' },
  { key: 'vehicle', label: 'Vehicle', kind: 'text' },
  { key: 'confirmed', label: 'Confirmed', kind: 'date' },
  { key: 'expected', label: 'Expected', kind: 'date' },
  { key: 'firstArrival', label: 'First arrival', kind: 'date' },
  { key: 'received', label: 'Fully received', kind: 'date' },
  { key: 'receivedInto', label: 'Received into', kind: 'text' },
  { key: 'days', label: 'Days', kind: 'days' },
  { key: 'status', label: 'Status', kind: 'badge' },
];

const BADGE_TONES: Record<string, Record<string, Tone>> = {
  status: {
    [ON_TIME]: 'good',
    [LATE]: 'bad',
    [NO_DATE]: 'neutral',
    [OVERDUE]: 'bad',
    [PARTLY]: 'warn',
    [WAITING]: 'neutral',
  },
};

const plural = (n: number, one = '', many = 's') => (n === 1 ? one : many);

const hasField = (meta: FieldsMeta | null, f: string) => !!meta && Object.prototype.hasOwnProperty.call(meta, f);

/**
 * The value a domain compares a field against. A plain date has no time, so it
 * takes the Gulf day; a datetime is stored in UTC and takes the instant.
 */
function bound(meta: FieldsMeta, field: string, ms: number): string {
  return meta[field]?.type === 'date' ? gulfDate(ms) : toOdooUtc(ms);
}

/** Good at 80% or more, a warning from half, bad below — and no colour when nothing was judged. */
function shareTone(part: number, whole: number): Tone | undefined {
  if (!whole) return undefined;
  const share = part / whole;
  return share >= 0.8 ? 'good' : share >= 0.5 ? 'warn' : 'bad';
}

// ── Goods lines ────────────────────────────────────────────────────

/** One goods line: ordered quantity and, when the instance tracks it, how much has come in (both in the line's unit). */
type GoodsLine = { qty: number; received: number | null };

/**
 * Product ids that are services, read from the product when the order line
 * does not carry the type itself. Null when no type can be read — the caller
 * then keeps every line and says so.
 */
async function serviceProducts(ids: number[]): Promise<Set<number> | null> {
  const meta = await readFieldsMeta('product.product');
  // 'type' on every version; 'detailed_type' on 15–17, where 'type' alone
  // lumps storable and consumable together — either one says 'service'.
  const typeFields = ['type', 'detailed_type'].filter((f) => hasField(meta, f));
  if (!typeFields.length) return null;
  if (!ids.length) return new Set();
  try {
    // `read` by id also returns archived products, which old orders still point at.
    const recs = await readChunked('product.product', ids, typeFields);
    return new Set(recs.filter((p) => typeFields.some((f) => p[f] === 'service')).map((p) => p.id as number));
  } catch (e) {
    console.warn('[evhub/po-to-receipt] product.product read failed:', e);
    return null;
  }
}

/**
 * Each order's goods lines — no section or note rows, no services. Null when
 * the lines cannot be read at all, so the caller falls back to the order's own
 * Arrival date instead of judging nothing.
 */
async function readGoodsLines(
  orderIds: number[],
  notes: string[],
): Promise<{ byOrder: Map<number, GoodsLine[]>; receivedKnown: boolean } | null> {
  const meta = await readFieldsMeta('purchase.order.line');
  if (!meta || !hasField(meta, 'order_id') || !hasField(meta, 'product_qty')) {
    notes.push('The purchase order lines could not be read, so every order is treated as parts and judged on its Arrival date alone — part deliveries cannot be seen.');
    return null;
  }
  const fields = ['order_id', 'product_qty'];
  for (const f of ['qty_received', 'display_type', 'product_type', 'product_id']) if (hasField(meta, f)) fields.push(f);

  const raw: Rec[] = [];
  try {
    for (const part of idChunks(orderIds, 500)) {
      raw.push(...(await searchReadAll('purchase.order.line', [['order_id', 'in', part]], fields)));
    }
  } catch (e) {
    console.warn('[evhub/po-to-receipt] purchase.order.line read failed:', e);
    notes.push('The purchase order lines could not be read, so every order is treated as parts and judged on its Arrival date alone — part deliveries cannot be seen.');
    return null;
  }

  // The line carries the product type on most versions; otherwise ask the product.
  let isService: (line: Rec) => boolean;
  if (hasField(meta, 'product_type')) {
    isService = (line) => line.product_type === 'service';
  } else {
    const productIds = [...new Set(raw.map((l) => m2o(l.product_id)?.[0]).filter((x): x is number => x != null))];
    const services = hasField(meta, 'product_id') ? await serviceProducts(productIds) : null;
    if (services) {
      isService = (line) => services.has(m2o(line.product_id)?.[0] ?? -1);
    } else {
      notes.push('Product types could not be read, so service lines (labour, fees) count as parts and can keep an order from reading as received.');
      isService = () => false;
    }
  }

  const receivedKnown = hasField(meta, 'qty_received');
  if (!receivedKnown) {
    notes.push('purchase.order.line has no Received quantity (qty_received) on this instance, so an order counts as fully received once it has an Arrival date, and part deliveries cannot be seen.');
  }

  const byOrder = new Map<number, GoodsLine[]>();
  for (const line of raw) {
    if (line.display_type) continue;   // section and note rows carry no product
    if (isService(line)) continue;
    const order = m2o(line.order_id)?.[0];
    if (order == null) continue;
    const list = byOrder.get(order) ?? [];
    list.push({
      qty: Number(line.product_qty) || 0,
      received: receivedKnown ? Number(line.qty_received) || 0 : null,
    });
    byOrder.set(order, list);
  }
  return { byOrder, receivedKnown };
}

// ── Receipts ───────────────────────────────────────────────────────

type Receipts = { first: number | null; last: number | null; into: string };

/**
 * Each order's validated incoming receipts: the earliest, the latest, and the
 * stock location the earliest one went into — the branch's stock. Null when
 * the receipts cannot be read, so the caller falls back to the Arrival date.
 */
async function readReceipts(pos: Rec[], notes: string[]): Promise<Map<number, Receipts> | null> {
  const meta = await readFieldsMeta('stock.picking');
  if (!hasField(meta, 'state') || !hasField(meta, 'date_done')) return null;
  const typed = hasField(meta, 'picking_type_code');
  const fields = ['state', 'date_done'];
  if (typed) fields.push('picking_type_code');
  if (hasField(meta, 'location_dest_id')) fields.push('location_dest_id');

  const ids = [...new Set(pos.flatMap((po) => (Array.isArray(po.picking_ids) ? (po.picking_ids as number[]) : [])))];
  const byId = new Map<number, Rec>();
  try {
    for (const p of await readChunked('stock.picking', ids, fields, 1000)) byId.set(p.id as number, p);
  } catch (e) {
    console.warn('[evhub/po-to-receipt] stock.picking read failed:', e);
    return null;
  }
  if (!typed) {
    notes.push('stock.picking has no operation type code here, so every validated transfer on an order counts as a receipt — a return to the vendor would read as an arrival.');
  }

  const out = new Map<number, Receipts>();
  for (const po of pos) {
    let first: { t: number; into: string } | null = null;
    let last: number | null = null;
    for (const id of (Array.isArray(po.picking_ids) ? (po.picking_ids as number[]) : [])) {
      const p = byId.get(id);
      if (!p || p.state !== 'done') continue;
      if (typed && p.picking_type_code !== 'incoming') continue;   // a return to the vendor is not an arrival
      const t = poTime(p.date_done);
      if (t == null) continue;
      if (!first || t < first.t) first = { t, into: m2oName(p.location_dest_id) };
      if (last == null || t > last) last = t;
    }
    out.set(po.id as number, { first: first?.t ?? null, last, into: first?.into ?? '' });
  }
  return out;
}

// ── Report ─────────────────────────────────────────────────────────

export const report: ReportModule = {
  async build(params) {
    const base: Omit<ReportBuild, 'rows' | 'notes'> = {
      slug: 'po-to-receipt',
      title: 'Purchase order to parts received',
      description: 'Purchase orders confirmed in the window and how long their parts took to arrive in the branch stock (Odoo receipt validated), plus the ones still on the way.',
      windowDays: params.days,
      columns: COLUMNS,
      branchScoped: true,
      badgeTones: BADGE_TONES,
    };
    const notes: string[] = [];

    const poMeta = await readFieldsMeta('purchase.order');
    if (!poMeta) {
      return { ...base, rows: [], notes: ['purchase.order could not be read on this instance, so there are no purchase orders to list.'] };
    }
    if (!hasField(poMeta, 'date_approve')) {
      return { ...base, rows: [], notes: ['purchase.order has no Confirmation Date (date_approve) on this instance, so there is no moment to time the receipt from.'] };
    }

    const fields = ['name', 'company_id', 'date_approve'];
    for (const f of ['partner_id', 'fleet_id', 'date_planned', 'effective_date', 'picking_ids']) if (hasField(poMeta, f)) fields.push(f);
    const blank = ([['partner_id', 'Vendor'], ['fleet_id', 'Vehicle'], ['date_planned', 'Expected']] as const)
      .filter(([f]) => !hasField(poMeta, f))
      .map(([f, label]) => `${label} (${f})`);
    if (blank.length) {
      notes.push(`purchase.order has no ${blank.join(', ')} field on this instance, so ${blank.length === 1 ? 'that column is' : 'those columns are'} empty.`);
    }

    const now = Date.now();
    const limitMs = params.thresholds.partsPlacedDays * DAY_MS;

    let pos: Rec[];
    try {
      pos = await searchReadAll('purchase.order', [
        ['state', 'in', CONFIRMED_STATES],
        ['date_approve', '>=', bound(poMeta, 'date_approve', now - params.days * DAY_MS)],
      ], fields, 'date_approve desc');
    } catch (e) {
      console.warn('[evhub/po-to-receipt] purchase.order read failed:', e);
      return { ...base, rows: [], notes: [...notes, `The purchase orders confirmed in the last ${params.days} days could not be read from Odoo.`] };
    }

    const index = await companyIndex();
    const unknown = new Map<string, number>();
    const kept: { po: Rec; branch: string; site: string; confirmed: number }[] = [];
    for (const po of pos) {
      const company = m2o(po.company_id);
      const where = company ? index.get(company[0]) : undefined;
      if (!where) {
        const name = company?.[1] || 'no company';
        unknown.set(name, (unknown.get(name) ?? 0) + 1);
        continue;
      }
      const confirmed = poTime(po.date_approve);
      if (confirmed == null) continue;   // the domain requires a confirmation date; guard a malformed one
      kept.push({ po, branch: where.branch, site: where.site, confirmed });
    }

    const lines = await readGoodsLines(kept.map((k) => k.po.id as number), notes);

    let receipts: Map<number, Receipts> | null = null;
    if (hasField(poMeta, 'picking_ids')) receipts = await readReceipts(kept.map((k) => k.po), notes);
    if (!receipts) {
      notes.push(hasField(poMeta, 'effective_date')
        ? 'The receipts behind each order could not be read, so arrival comes from the order\'s Arrival date. That is the first receipt, so an order delivered in parts is timed to its first delivery, and "Received into" is empty.'
        : 'Neither the receipts behind each order nor an Arrival date can be read on this instance, so received orders cannot be timed.');
    }

    let noGoods = 0;
    let noDate = 0;
    const rows: ReportRow[] = [];

    for (const { po, branch, site, confirmed } of kept) {
      const id = po.id as number;
      const goods = lines ? lines.byOrder.get(id) ?? [] : null;
      // Only services or notes: nothing was ever going to arrive in stock.
      if (goods && !goods.length) { noGoods++; continue; }

      // The Arrival date is Odoo's own first validated receipt, so it stands in
      // whenever the receipts themselves say nothing.
      const effective = poTime(po.effective_date);
      let state: 'full' | 'partial' | 'none';
      if (goods && lines!.receivedKnown) {
        const full = goods.every((l) => (l.received ?? 0) >= l.qty - EPS);
        const any = goods.some((l) => (l.received ?? 0) > EPS);
        state = full ? 'full' : any ? 'partial' : 'none';
      } else {
        state = effective != null ? 'full' : 'none';
      }

      const rec = receipts?.get(id);
      const firstAt = state === 'none' ? null : rec?.first ?? effective;
      // The last receipt completes the order; only meaningful once it is complete.
      const fullAt = state === 'full' ? rec?.last ?? effective : null;

      let days: number | null;
      let status: string;
      if (state === 'full') {
        if (fullAt == null) {
          // Complete but undated: there is no moment to measure to, and guessing
          // one would invent either a pass or a fail.
          days = null;
          status = NO_DATE;
          noDate++;
        } else {
          // A date-only stamp reads as midnight UTC and can land before a
          // same-day confirmation; that is "same day", not negative time.
          const took = Math.max(0, fullAt - confirmed);
          days = daysBetween(0, took);
          status = took <= limitMs ? ON_TIME : LATE;
        }
      } else {
        days = daysBetween(confirmed, now);
        status = now - confirmed > limitMs ? OVERDUE : state === 'partial' ? PARTLY : WAITING;
      }

      const planned = poTime(po.date_planned);
      rows.push({
        po: (po.name as string) || '',
        [BRANCH_KEY]: branch,
        site,
        vendor: m2oName(po.partner_id),
        vehicle: m2oName(po.fleet_id),
        confirmed: gulfDate(confirmed),
        expected: planned != null ? gulfDate(planned) : null,
        firstArrival: firstAt != null ? gulfDate(firstAt) : null,
        received: fullAt != null ? gulfDate(fullAt) : null,
        receivedInto: state === 'none' ? '' : rec?.into ?? '',
        days,
        status,
      });
    }

    // Longest first; the stable sort keeps the newest-first read order among ties.
    rows.sort((a, b) => {
      const x = a.days as number | null;
      const y = b.days as number | null;
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
      return y - x;
    });

    const unknownNote = unknownCompanyNote(unknown, 'purchase orders');
    if (unknownNote) notes.push(unknownNote);
    if (noGoods) {
      notes.push(`Skipped ${noGoods} purchase order${plural(noGoods)} with no parts lines — only services or notes, so nothing was due to arrive in stock.`);
    }
    if (noDate) {
      notes.push(`${noDate} purchase order${plural(noDate)} ${plural(noDate, 'is', 'are')} fully received but carr${plural(noDate, 'ies', 'y')} no receipt date, so ${plural(noDate, 'it is', 'they are')} listed as "Received, no date" and left out of the timing.`);
    }
    notes.push('Days run from confirmation to the last receipt once every part is in, or to now while parts are still due. Service lines are ignored.');

    return { ...base, rows, notes };
  },

  summarise(rows, params): ReportSummaryItem[] {
    const threshold = params.thresholds.partsPlacedDays;
    const count = (status: string) => rows.filter((r) => r.status === status).length;
    const onTime = count(ON_TIME);
    const late = count(LATE);
    const overdue = count(OVERDUE);
    const open = overdue + count(PARTLY) + count(WAITING);
    const timed = rows
      .filter((r) => (r.status === ON_TIME || r.status === LATE) && typeof r.days === 'number')
      .map((r) => r.days as number);

    return [
      { label: 'POs confirmed', value: formatNumber(rows.length) },
      { label: 'Median time to receive', value: fmtDays(median(timed)), hint: `average ${fmtDays(mean(timed))}` },
      { label: `Received within ${fmtDays(threshold)}`, value: fmtPct(onTime, onTime + late), tone: shareTone(onTime, onTime + late) },
      { label: 'Not fully received', value: formatNumber(open), hint: `${overdue} overdue`, tone: overdue > 0 ? 'bad' : undefined },
    ];
  },
};
