/**
 * EV Hub parts cost — what EV Hub paid per unit for each part on confirmed
 * purchase orders, month by month over the last 12 months, and how that cost
 * moved.
 *
 * A month's figure is a weighted average — everything paid for the part that
 * month divided by the units bought — so one small top-up order at a premium
 * does not read as the price of the month.
 */

import { BRANCH_CLUSTERS, type OdooDomain } from '../odoo';
import { readFieldsMeta, type FieldsMeta } from '../kpi';
import { formatCurrency, formatNumber } from '../format';
import {
  companyIdsFor, m2o, poTime, toOdooUtc, gulfDate, gulfMonthKey, monthLabel,
  searchReadAll, readChunked, type Rec,
} from './common';
import type { ReportBuild, ReportColumn, ReportModule, ReportRow, ReportSummaryItem, Tone } from './types';

/** Gulf time is UTC+4 all year — no DST — so a fixed offset is exact. */
const GULF_OFFSET_MS = 4 * 3600 * 1000;
const MONTHS_BACK = 12;
const CONFIRMED_STATES = ['purchase', 'done'];

const UP = 'Up over 10%';
const DOWN = 'Down over 10%';
const STABLE = 'Stable';
const ONCE = 'Bought once';

const BADGE_TONES: Record<string, Record<string, Tone>> = {
  trend: { [UP]: 'bad', [DOWN]: 'good', [STABLE]: 'neutral', [ONCE]: 'neutral' },
};

const plural = (n: number, one = '', many = 's') => (n === 1 ? one : many);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

const hasField = (meta: FieldsMeta | null, f: string) => !!meta && Object.prototype.hasOwnProperty.call(meta, f);

/**
 * The value a domain compares a field against. A plain date has no time, so it
 * takes the Gulf day; a datetime is stored in UTC and takes the instant.
 */
function bound(meta: FieldsMeta, field: string, ms: number): string {
  return meta[field]?.type === 'date' ? gulfDate(ms) : toOdooUtc(ms);
}

type Month = { key: string; start: number; end: number };

/**
 * The 12 Gulf calendar months ending with the current one, oldest first, each
 * with its [start, end) instants. Calendar months rather than "the last 365
 * days" so every column is a whole month and this month's grows as it goes.
 */
function windowMonths(now: number): Month[] {
  const [y, m] = gulfMonthKey(now).split('-').map(Number);
  const out: Month[] = [];
  for (let i = MONTHS_BACK - 1; i >= 0; i--) {
    // Date.UTC rolls a negative or 13th month into the right year.
    const start = Date.UTC(y, m - 1 - i, 1) - GULF_OFFSET_MS;
    const end = Date.UTC(y, m - i, 1) - GULF_OFFSET_MS;
    out.push({ key: gulfMonthKey(start), start, end });
  }
  return out;
}

const monthCol = (key: string) => `m_${key.replace('-', '_')}`;

function columnsFor(months: Month[], cur: string): ReportColumn[] {
  return [
    { key: 'part', label: 'Part', kind: 'text' },
    { key: 'ref', label: 'Ref', kind: 'text' },
    { key: 'uom', label: 'UoM', kind: 'text' },
    ...months.map((m): ReportColumn => ({ key: monthCol(m.key), label: monthLabel(m.key), kind: 'currency' })),
    { key: 'change', label: 'Change', kind: 'percent', trend: 'up-bad' },
    { key: 'trend', label: 'Trend', kind: 'badge' },
    { key: 'low', label: '12-mo low', kind: 'currency' },
    { key: 'high', label: '12-mo high', kind: 'currency' },
    { key: 'qty', label: 'Qty bought', kind: 'number' },
    { key: 'spend', label: `Total spend (${cur})`, kind: 'currency' },
  ];
}

/** Odoo prefixes a product's display name with "[code] "; the code has its own column. */
const partName = (display: string) => display.replace(/^\[[^\]]*\]\s*/, '');

type Agg = { name: string; amount: number; qty: number; months: Map<string, { amount: number; qty: number }> };

export const report: ReportModule = {
  async build(): Promise<ReportBuild> {
    const now = Date.now();
    const months = windowMonths(now);
    const notes: string[] = [];
    const shell = (cur: string): Omit<ReportBuild, 'rows' | 'notes'> => ({
      slug: 'cost',
      title: 'EV Hub parts cost',
      description: 'What EV Hub paid per unit for each part on confirmed purchase orders, month by month over the last 12 months, and how that cost moved.',
      windowDays: null,
      columns: columnsFor(months, cur),
      branchScoped: false,
      badgeTones: BADGE_TONES,
    });

    const hubIds = await companyIdsFor(['EV Hub']);
    if (!hubIds.length) {
      return {
        ...shell('AED'),
        rows: [],
        notes: [`The EV Hub company (${BRANCH_CLUSTERS['EV Hub'].join(', ')}) could not be found in Odoo, so there are no purchase orders to price.`],
      };
    }

    // ── Company currency — what every amount is converted into ──
    const companyCur = new Map<number, [number, string]>();
    try {
      for (const c of await readChunked('res.company', hubIds, ['currency_id'])) {
        const cur = m2o(c.currency_id);
        if (cur) companyCur.set(c.id as number, cur);
      }
    } catch (e) {
      console.warn('[evhub/cost] res.company read failed:', e);
    }
    const curList = [...companyCur.values()];
    const cur = curList[0]?.[1] || 'AED';
    if (!curList.length) {
      notes.push('EV Hub\'s company currency could not be read, so every line is converted at its order\'s stored rate (1 for an order already in the company currency) and labelled AED.');
    } else if (new Set(curList.map((c) => c[0])).size > 1) {
      notes.push(`The EV Hub companies keep their books in different currencies (${[...new Set(curList.map((c) => c[1]))].join(', ')}), so each line is in its own company's currency although the columns say ${cur}.`);
    }

    // ── Schema ──
    const lineMeta = await readFieldsMeta('purchase.order.line');
    const poMeta = await readFieldsMeta('purchase.order');
    if (!lineMeta || !poMeta) {
      return { ...shell(cur), rows: [], notes: [...notes, 'The purchase orders or their lines could not be read on this instance, so there is nothing to price.'] };
    }
    const lineHas = (f: string) => hasField(lineMeta, f);
    const poHas = (f: string) => hasField(poMeta, f);
    const missing = ['order_id', 'product_id', 'price_subtotal'].filter((f) => !lineHas(f));
    if (!lineHas('product_qty') && !lineHas('product_uom_qty')) missing.push('product_qty');
    if (missing.length) {
      return { ...shell(cur), rows: [], notes: [...notes, `purchase.order.line has no ${missing.join(', ')} on this instance, so unit costs cannot be worked out.`] };
    }
    const dateFields = ['date_approve', 'date_order'].filter(poHas);
    if (!dateFields.length) {
      return { ...shell(cur), rows: [], notes: [...notes, 'purchase.order has neither a Confirmation Date nor an Order Date on this instance, so orders cannot be placed in a month.'] };
    }

    // The product's own unit makes months comparable: a part bought by the box
    // in March and by the piece in May would otherwise average boxes with pieces.
    const qtyField = lineHas('product_uom_qty') ? 'product_uom_qty' : 'product_qty';

    const baseDomain: OdooDomain = [
      ['order_id.company_id', 'in', hubIds],
      ['order_id.state', 'in', CONFIRMED_STATES],
      ['product_id', '!=', false],
    ];
    if (lineHas('display_type')) baseDomain.push(['display_type', '=', false]);

    const dateDomain = (m: Month): OdooDomain => {
      const range = (f: string): OdooDomain => [
        [`order_id.${f}`, '>=', bound(poMeta, f, m.start)],
        [`order_id.${f}`, '<', bound(poMeta, f, m.end)],
      ];
      if (poHas('date_approve') && poHas('date_order')) {
        // Placed by confirmation; an order confirmed without a stamp falls back
        // to its order date rather than vanishing from the window.
        return ['|', '&', ...range('date_approve'), '&', '&', ['order_id.date_approve', '=', false], ...range('date_order')];
      }
      return range(dateFields[0]);
    };

    // ── Lines, one month per request so no single response grows unbounded ──
    const fields = ['order_id', 'product_id', 'price_subtotal', qtyField];
    const lines: { rec: Rec; month: string }[] = [];
    const seen = new Set<number>();
    const failed: string[] = [];
    for (const m of months) {
      try {
        for (const rec of await searchReadAll('purchase.order.line', [...baseDomain, ...dateDomain(m)], fields)) {
          const id = rec.id as number;
          if (seen.has(id)) continue;
          seen.add(id);
          lines.push({ rec, month: m.key });
        }
      } catch (e) {
        console.warn(`[evhub/cost] purchase.order.line read failed for ${m.key}:`, e);
        failed.push(monthLabel(m.key));
      }
    }

    // ── The orders behind them: date, currency and the rate it was bought at ──
    const orderIds = [...new Set(lines.map((l) => m2o(l.rec.order_id)?.[0]).filter((x): x is number => x != null))];
    const poFields = ['company_id', ...dateFields, ...['currency_id', 'currency_rate'].filter(poHas)];
    const orders = new Map<number, Rec>();
    try {
      for (const o of await readChunked('purchase.order', orderIds, poFields)) orders.set(o.id as number, o);
    } catch (e) {
      console.warn('[evhub/cost] purchase.order read failed:', e);
      notes.push('The purchase orders behind the lines could not be read, so their currency is unknown and their lines were left out.');
    }

    const inWindow = new Set(months.map((m) => m.key));
    const aggs = new Map<number, Agg>();
    const undatedOrders = new Set<number>();
    let converted = 0;
    let unconvertible = 0;
    let nonPositive = 0;

    for (const { rec, month } of lines) {
      const product = m2o(rec.product_id);
      const orderId = m2o(rec.order_id)?.[0];
      if (!product || orderId == null) continue;
      const qty = Number(rec[qtyField]);
      if (!(qty > 0)) { nonPositive++; continue; }   // refunds and zero lines carry no unit price

      // Odoo stores currency_rate as how many order-currency units one
      // company-currency unit buys, so dividing by it lands in the company
      // currency — and it is 1 for an order already in that currency.
      const order = orders.get(orderId);
      const subtotal = Number(rec.price_subtotal) || 0;
      const orderCur = m2o(order?.currency_id)?.[0];
      const compCur = (companyCur.get(m2o(order?.company_id)?.[0] ?? -1) ?? curList[0])?.[0];
      let amount: number | null = null;
      if (orderCur != null && compCur != null && orderCur === compCur) {
        amount = subtotal;
      } else {
        const rate = Number(order?.currency_rate);
        if (order && rate > 0) {
          amount = subtotal / rate;
          if (orderCur != null && compCur != null) converted++;
        }
      }
      if (amount == null || !Number.isFinite(amount)) { unconvertible++; continue; }

      // The month the order was confirmed; the month it was fetched under
      // stands in when the order's own date cannot be read.
      let key = month;
      if (order) {
        const approved = poTime(order.date_approve);
        if (approved == null && poHas('date_approve')) undatedOrders.add(orderId);
        const t = approved ?? poTime(order.date_order);
        const k = t != null ? gulfMonthKey(t) : null;
        if (k && inWindow.has(k)) key = k;
      }

      const agg = aggs.get(product[0]) ?? { name: partName(product[1]), amount: 0, qty: 0, months: new Map() };
      agg.amount += amount;
      agg.qty += qty;
      const bucket = agg.months.get(key) ?? { amount: 0, qty: 0 };
      bucket.amount += amount;
      bucket.qty += qty;
      agg.months.set(key, bucket);
      aggs.set(product[0], agg);
    }

    // ── Product reference and unit ──
    const productIds = [...aggs.keys()];
    const prodMeta = productIds.length ? await readFieldsMeta('product.product') : null;
    const pFields = ['default_code', 'uom_id'].filter((f) => hasField(prodMeta, f));
    const products = new Map<number, Rec>();
    if (productIds.length) {
      if (!pFields.length) {
        notes.push('Product references and units could not be read, so the Ref and UoM columns are empty.');
      } else {
        try {
          // `read` by id also returns archived products, which old orders still point at.
          for (const p of await readChunked('product.product', productIds, pFields)) products.set(p.id as number, p);
        } catch (e) {
          console.warn('[evhub/cost] product.product read failed:', e);
          notes.push('Product references and units could not be read, so the Ref and UoM columns are empty.');
        }
      }
    }

    // ── Rows ──
    const rows: ReportRow[] = [];
    for (const [pid, agg] of aggs) {
      const p = products.get(pid);
      const row: ReportRow = {
        part: agg.name,
        ref: typeof p?.default_code === 'string' ? p.default_code : '',
        uom: m2o(p?.uom_id)?.[1] ?? '',
      };
      const priced: number[] = [];
      for (const m of months) {
        const b = agg.months.get(m.key);
        const unit = b && b.qty > 0 ? round2(b.amount / b.qty) : null;
        row[monthCol(m.key)] = unit;
        if (unit != null) priced.push(unit);
      }

      let change: number | null = null;
      let trend: string;
      if (priced.length < 2) {
        trend = ONCE;
      } else {
        const first = priced[0];
        const last = priced[priced.length - 1];
        if (first > 0) {
          // Rounded before it is judged so the badge never disagrees with the
          // figure shown beside it.
          change = round1(((last - first) / first) * 100);
          trend = change > 10 ? UP : change < -10 ? DOWN : STABLE;
        } else {
          // A free first month has no percentage to move from; the direction
          // still says which way the price went.
          trend = last > first ? UP : last < first ? DOWN : STABLE;
        }
      }
      row.change = change;
      row.trend = trend;
      row.low = priced.length ? Math.min(...priced) : null;
      row.high = priced.length ? Math.max(...priced) : null;
      row.qty = round2(agg.qty);
      row.spend = round2(agg.amount);
      rows.push(row);
    }
    rows.sort((a, b) => (b.spend as number) - (a.spend as number) || String(a.part).localeCompare(String(b.part)));

    // ── Notes ──
    notes.unshift('Each month is the weighted average EV Hub paid per unit (what was paid before tax divided by the units bought) on confirmed purchase orders only, placed in the month the order was confirmed. Change compares the first and last month the part was bought; the 12-month low and high are the cheapest and dearest of those months.');
    if (curList.length) {
      notes.push(`Amounts are in ${cur}, EV Hub's company currency. Orders in another currency are converted at the rate stored on the order${converted ? ` (${converted} line${plural(converted)} converted)` : ''}.`);
    }
    notes.push(qtyField === 'product_uom_qty'
      ? 'Quantities are in each product\'s own unit of measure (product_uom_qty), so months bought in different packs still compare.'
      : 'purchase.order.line has no base-unit quantity (product_uom_qty) here, so quantities are as ordered (product_qty) — a part bought by the box one month and by the piece the next would mix units.');
    if (!poHas('date_approve')) {
      notes.push('purchase.order has no Confirmation Date (date_approve) here, so orders are placed by their order date.');
    } else if (undatedOrders.size) {
      const n = undatedOrders.size;
      notes.push(`${n} confirmed order${plural(n)} carr${plural(n, 'ies', 'y')} no confirmation date and ${plural(n, 'is', 'are')} placed by ${plural(n, 'its', 'their')} order date instead.`);
    }
    if (unconvertible) {
      notes.push(`Skipped ${unconvertible} line${plural(unconvertible)} that could not be priced in ${cur}: another currency with no usable rate on the order, or an order that could not be read.`);
    }
    if (nonPositive) {
      notes.push(`Skipped ${nonPositive} line${plural(nonPositive)} with no positive quantity — refunds and zero lines carry no unit price.`);
    }
    if (failed.length) {
      notes.push(`The order lines for ${failed.join(', ')} could not be read, so ${failed.length === 1 ? 'that month is' : 'those months are'} empty.`);
    }

    return { ...shell(cur), rows, notes };
  },

  summarise(rows): ReportSummaryItem[] {
    const spend = rows.reduce((s, r) => s + (typeof r.spend === 'number' ? r.spend : 0), 0);
    const count = (trend: string) => rows.filter((r) => r.trend === trend).length;
    return [
      { label: 'Parts bought', value: formatNumber(rows.length) },
      { label: 'Total spend', value: formatCurrency(spend) },
      { label: 'Got more expensive', value: formatNumber(count(UP)), tone: 'bad' },
      { label: 'Got cheaper', value: formatNumber(count(DOWN)), tone: 'good' },
    ];
  },
};
