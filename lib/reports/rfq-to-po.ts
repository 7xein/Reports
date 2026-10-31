/**
 * RFQ to purchase order — every RFQ raised in the window, how long it took to
 * be confirmed into a purchase order, and which are still waiting.
 *
 * The question KPI 19 asks, but listed order by order and across every branch —
 * EV Hub included, since it buys parts too — so a slow confirmation can be
 * traced to its vendor and to whoever raised it instead of read off a share.
 */

import { readFieldsMeta, type FieldsMeta } from '../kpi';
import { formatNumber } from '../format';
import {
  companyIndex, unknownCompanyNote, m2o, m2oName, poTime, toOdooUtc, gulfDate,
  daysBetween, median, mean, fmtDays, fmtPct, searchReadAll, type Rec,
} from './common';
import {
  BRANCH_KEY,
  type ReportBuild, type ReportColumn, type ReportModule, type ReportRow, type ReportSummaryItem, type Tone,
} from './types';

const DAY_MS = 86400_000;

// Not yet committed to: an RFQ anybody could still walk away from. Note the
// space in 'to approve' — that is the stored value, not a label.
const RFQ_STATES = ['draft', 'sent', 'to approve'];
const CONFIRMED_STATES = ['purchase', 'done'];

const ON_TIME = 'On time';
const LATE = 'Late';
const NO_DATE = 'Confirmed, no date';
const STILL_OVERDUE = 'Still RFQ, overdue';
const STILL = 'Still RFQ';

const COLUMNS: ReportColumn[] = [
  { key: 'po', label: 'RFQ / PO', kind: 'text' },
  { key: BRANCH_KEY, label: 'Branch', kind: 'text' },
  { key: 'site', label: 'Site', kind: 'text' },
  { key: 'vendor', label: 'Vendor', kind: 'text' },
  { key: 'vehicle', label: 'Vehicle', kind: 'text' },
  { key: 'createdBy', label: 'Raised by', kind: 'text' },
  { key: 'odooStatus', label: 'Odoo status', kind: 'text' },
  { key: 'created', label: 'RFQ raised', kind: 'date' },
  { key: 'confirmed', label: 'Confirmed', kind: 'date' },
  { key: 'days', label: 'Days', kind: 'days' },
  { key: 'status', label: 'Status', kind: 'badge' },
];

const BADGE_TONES: Record<string, Record<string, Tone>> = {
  status: {
    [ON_TIME]: 'good',
    [LATE]: 'bad',
    [NO_DATE]: 'neutral',
    [STILL_OVERDUE]: 'bad',
    [STILL]: 'warn',
  },
};

const plural = (n: number, one = '', many = 's') => (n === 1 ? one : many);

const hasField = (meta: FieldsMeta, f: string) => Object.prototype.hasOwnProperty.call(meta, f);

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

export const report: ReportModule = {
  async build(params) {
    const base: Omit<ReportBuild, 'rows' | 'notes'> = {
      slug: 'rfq-to-po',
      title: 'RFQ to purchase order',
      description: 'Every RFQ raised in the window, how long it took to be confirmed into a purchase order, and which are still waiting.',
      windowDays: params.days,
      columns: COLUMNS,
      branchScoped: true,
      badgeTones: BADGE_TONES,
    };
    const notes: string[] = [];

    const meta = await readFieldsMeta('purchase.order');
    if (!meta) {
      return { ...base, rows: [], notes: ['purchase.order could not be read on this instance, so there are no RFQs to list.'] };
    }

    // Each optional field costs its own column when missing, not the report.
    const fields = ['name', 'state', 'company_id', 'create_date'];
    for (const f of ['date_approve', 'partner_id', 'fleet_id', 'create_uid']) if (hasField(meta, f)) fields.push(f);
    if (!hasField(meta, 'date_approve')) {
      notes.push('purchase.order has no Confirmation Date (date_approve) on this instance, so confirmed orders cannot be timed and show as "Confirmed, no date".');
    }
    const blank = ([['partner_id', 'Vendor'], ['fleet_id', 'Vehicle'], ['create_uid', 'Raised by']] as const)
      .filter(([f]) => !hasField(meta, f))
      .map(([f, label]) => `${label} (${f})`);
    if (blank.length) {
      notes.push(`purchase.order has no ${blank.join(', ')} field on this instance, so ${blank.length === 1 ? 'that column is' : 'those columns are'} empty.`);
    }

    const now = Date.now();
    const limitMs = params.thresholds.rfqConfirmDays * DAY_MS;

    let pos: Rec[];
    try {
      // Cancelled RFQs are out of the population: a withdrawn request was never
      // waiting on a confirmation, so listing it would read as one nobody acted on.
      pos = await searchReadAll('purchase.order', [
        ['create_date', '>=', bound(meta, 'create_date', now - params.days * DAY_MS)],
        ['state', '!=', 'cancel'],
      ], fields, 'create_date desc');
    } catch (e) {
      console.warn('[evhub/rfq-to-po] purchase.order read failed:', e);
      return { ...base, rows: [], notes: [...notes, `The RFQs raised in the last ${params.days} days could not be read from Odoo.`] };
    }

    // Labels as this instance names them, so the column matches what people see in Odoo.
    const selection = Array.isArray(meta.state?.selection) ? meta.state!.selection! : [];
    const stateLabel = new Map<string, string>(selection.map(([v, l]) => [v, l]));

    const index = await companyIndex();
    const unknown = new Map<string, number>();
    const oddStates = new Map<string, number>();
    let undated = 0;
    const rows: ReportRow[] = [];

    for (const po of pos) {
      const company = m2o(po.company_id);
      const where = company ? index.get(company[0]) : undefined;
      if (!where) {
        const name = company?.[1] || 'no company';
        unknown.set(name, (unknown.get(name) ?? 0) + 1);
        continue;
      }
      const created = poTime(po.create_date);
      if (created == null) continue;   // Odoo always sets create_date; without it there is nothing to time from

      const state = String(po.state ?? '');
      const approved = poTime(po.date_approve);
      let confirmedAt: number | null = null;
      let days: number | null;
      let status: string;

      if (RFQ_STATES.includes(state)) {
        // Judged on the state, not on date_approve: an order set back to draft
        // keeps its old confirmation date but is an RFQ again.
        days = daysBetween(created, now);
        status = now - created > limitMs ? STILL_OVERDUE : STILL;
      } else if (CONFIRMED_STATES.includes(state) || approved != null) {
        // A state this instance added is read as confirmed when it carries a
        // confirmation date — Odoo only stamps date_approve on confirmation.
        if (approved != null) {
          confirmedAt = approved;
          // A date-only confirmation reads as midnight UTC and can land before
          // a same-day creation; that is "same day", not negative time.
          const took = Math.max(0, approved - created);
          days = daysBetween(0, took);
          status = took <= limitMs ? ON_TIME : LATE;
        } else {
          // Confirmed but undated: there is no moment to measure to, and guessing
          // one would invent either a pass or a fail.
          days = null;
          status = NO_DATE;
          undated++;
        }
      } else {
        // An unknown state with no confirmation date is neither an open RFQ nor
        // a dated order, so it cannot be placed on either side.
        const label = stateLabel.get(state) ?? (state || 'no state');
        oddStates.set(label, (oddStates.get(label) ?? 0) + 1);
        continue;
      }

      rows.push({
        po: (po.name as string) || '',
        [BRANCH_KEY]: where.branch,
        site: where.site,
        vendor: m2oName(po.partner_id),
        vehicle: m2oName(po.fleet_id),
        createdBy: m2oName(po.create_uid),
        odooStatus: stateLabel.get(state) ?? state,
        created: gulfDate(created),
        confirmed: confirmedAt != null ? gulfDate(confirmedAt) : null,
        days,
        status,
      });
    }

    // Longest wait first; the stable sort keeps the newest-first read order among ties.
    rows.sort((a, b) => {
      const x = a.days as number | null;
      const y = b.days as number | null;
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
      return y - x;
    });

    const unknownNote = unknownCompanyNote(unknown, 'purchase orders');
    if (unknownNote) notes.push(unknownNote);
    if (undated) {
      notes.push(`${undated} confirmed purchase order${plural(undated)} carr${plural(undated, 'ies', 'y')} no confirmation date, so ${plural(undated, 'it is', 'they are')} listed as "Confirmed, no date" and left out of the timing.`);
    }
    if (oddStates.size) {
      const total = [...oddStates.values()].reduce((s, n) => s + n, 0);
      const list = [...oddStates.entries()].map(([l, n]) => `${l} (${n})`).join(', ');
      notes.push(`Skipped ${total} order${plural(total)} in a state this report does not recognise and with no confirmation date: ${list}.`);
    }
    notes.push('Cancelled RFQs are left out. Days run from the RFQ being raised to its confirmation, or to now while it is still an RFQ.');

    return { ...base, rows, notes };
  },

  summarise(rows, params): ReportSummaryItem[] {
    const threshold = params.thresholds.rfqConfirmDays;
    const count = (status: string) => rows.filter((r) => r.status === status).length;
    const onTime = count(ON_TIME);
    const late = count(LATE);
    const overdue = count(STILL_OVERDUE);
    const still = overdue + count(STILL);
    const timed = rows
      .filter((r) => (r.status === ON_TIME || r.status === LATE) && typeof r.days === 'number')
      .map((r) => r.days as number);

    return [
      { label: 'RFQs raised', value: formatNumber(rows.length), hint: `in the last ${params.days} days` },
      { label: 'Median time to confirm', value: fmtDays(median(timed)), hint: `average ${fmtDays(mean(timed))}` },
      { label: `Confirmed within ${fmtDays(threshold)}`, value: fmtPct(onTime, onTime + late), tone: shareTone(onTime, onTime + late) },
      { label: 'Still RFQ', value: formatNumber(still), hint: `${overdue} overdue`, tone: overdue > 0 ? 'bad' : undefined },
    ];
  },
};
