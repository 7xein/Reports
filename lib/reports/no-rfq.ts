/**
 * Parts without RFQ — open repair orders short of parts that nobody has asked
 * a supplier for yet.
 *
 * The backlog behind KPI 18: that KPI judges, week by week, whether an RFQ went
 * out in time; this lists, right now, every job still waiting on one, so it can
 * be chased rather than merely scored.
 */

import { loadPartsChain, type OpenRo } from './parts-chain';
import { daysBetween, fmtDays, gulfDate } from './common';
import type { ReportColumn, ReportModule, ReportRow, ReportSummaryItem, Tone } from './types';

const DAY_MS = 86400_000;
/** The parts cell is a reminder of what to order, not the full list — Odoo has that. */
const PARTS_MAX = 120;

const STATUS = { noVehicle: 'No vehicle', overdue: 'Overdue', fresh: 'New' } as const;

const STATUS_TONES: Record<string, Tone> = {
  [STATUS.noVehicle]: 'neutral',
  [STATUS.overdue]: 'bad',
  [STATUS.fresh]: 'warn',
};

const COLUMNS: ReportColumn[] = [
  { key: 'ro', label: 'Repair order', kind: 'text' },
  { key: 'branch', label: 'Branch', kind: 'text' },
  { key: 'site', label: 'Site', kind: 'text' },
  { key: 'vehicle', label: 'Vehicle', kind: 'text' },
  { key: 'customer', label: 'Customer', kind: 'text' },
  { key: 'repairStatus', label: 'Repair status', kind: 'text' },
  { key: 'partsShort', label: 'Parts short', kind: 'number' },
  { key: 'parts', label: 'Parts', kind: 'text' },
  { key: 'opened', label: 'RO opened', kind: 'date' },
  { key: 'added', label: 'Part added', kind: 'date' },
  { key: 'waiting', label: 'Waiting', kind: 'days' },
  { key: 'status', label: 'Status', kind: 'badge' },
];

const plural = (n: number): string => (n === 1 ? '' : 's');
const fmtCount = (n: number): string => n.toLocaleString('en-US');

/** Names, not lines: the same part on two lines is still one thing to order. */
function partsList(ro: OpenRo): string | null {
  const text = [...new Set(ro.short.map((l) => l.product).filter(Boolean))].join(', ');
  if (!text) return null;
  return text.length > PARTS_MAX ? `${text.slice(0, PARTS_MAX - 1).trimEnd()}…` : text;
}

export const report: ReportModule = {
  async build(params) {
    const chain = await loadPartsChain(params);
    const now = Date.now();
    const limitDays = params.thresholds.rfqAfterApprovalDays;

    const rows: ReportRow[] = [];
    let unchecked = 0;
    for (const ro of chain.ros) {
      // Odoo's own verdict decides whether anything needs buying: an order whose
      // short parts are all reserved in stock is waiting on the store, not on a
      // supplier. Without the flag, being short is the only evidence left.
      if (chain.has.partsAvailable && ro.partsAvailable !== false) continue;
      if (ro.poIds === null) { unchecked++; continue; }
      // Any live purchase order for the visit takes the job off this list, even
      // one that lacks this part — which part is missing from which RFQ is the
      // "Open parts" report's question.
      if (ro.poIds.length) continue;

      // The oldest short part sets the wait, as KPI 6 ages an order by it.
      const stamps = ro.short.map((l) => l.added).filter((t): t is number => t != null);
      const added = stamps.length ? Math.min(...stamps) : null;
      // An order with no vehicle can never be linked to an RFQ, so it is listed
      // for that reason before any clock is applied to it.
      const status = ro.vehicleId == null
        ? STATUS.noVehicle
        : added != null && now - added > limitDays * DAY_MS ? STATUS.overdue : STATUS.fresh;

      rows.push({
        ro: ro.name,
        branch: ro.branch,
        site: ro.site,
        vehicle: ro.vehicle,
        customer: ro.customer,
        repairStatus: ro.status || null,
        partsShort: ro.short.length,
        parts: partsList(ro),
        opened: ro.created != null ? gulfDate(ro.created) : null,
        added: added != null ? gulfDate(added) : null,
        waiting: added != null ? daysBetween(added, now) : null,
        status,
      });
    }

    // Longest wait first; an order with no date to age from goes last.
    const wait = (r: ReportRow) => (typeof r.waiting === 'number' ? r.waiting : -Infinity);
    rows.sort((a, b) => wait(b) - wait(a) || String(a.ro).localeCompare(String(b.ro)));

    const notes = [
      'RFQs link to repair orders only through the vehicle: an RFQ or purchase order in any state but cancelled, raised for the same vehicle after the repair order was opened, counts for it.',
    ];
    if (!chain.has.partsAvailable) {
      notes.push('Odoo’s “All Parts are available” could not be read here, so every open repair order with a part short counts as needing parts — including ones whose parts are already reserved in stock.');
    }
    if (unchecked) {
      notes.push(`${unchecked} repair order${plural(unchecked)} short of parts ${unchecked === 1 ? 'was' : 'were'} left out because ${unchecked === 1 ? 'its' : 'their'} vehicle’s purchase orders could not be read.`);
    }
    notes.push(...chain.notes);

    return {
      slug: 'no-rfq',
      title: 'Parts without RFQ',
      description: 'Open repair orders that still need parts procured (Odoo’s “All Parts are available” is off) and have at least one part short, while no RFQ or purchase order has been raised for the vehicle since the repair order was opened.',
      windowDays: null,
      columns: COLUMNS,
      rows,
      branchScoped: true,
      badgeTones: { status: STATUS_TONES },
      notes,
    };
  },

  summarise(rows, params): ReportSummaryItem[] {
    const n = params.thresholds.rfqAfterApprovalDays;
    const overdue = rows.filter((r) => r.status === STATUS.overdue).length;
    const noVehicle = rows.filter((r) => r.status === STATUS.noVehicle).length;
    const waits = rows.map((r) => r.waiting).filter((w): w is number => typeof w === 'number');
    return [
      { label: 'Waiting for an RFQ', value: fmtCount(rows.length), tone: rows.length > 0 ? 'bad' : 'good' },
      {
        label: 'Overdue',
        value: fmtCount(overdue),
        tone: overdue > 0 ? 'bad' : undefined,
        hint: `more than ${n} day${plural(n)} since the part was added`,
      },
      { label: 'Longest wait', value: fmtDays(waits.length ? Math.max(...waits) : null) },
      {
        label: 'No vehicle set',
        value: fmtCount(noVehicle),
        tone: noVehicle > 0 ? 'warn' : undefined,
        hint: 'can’t be linked to an RFQ',
      },
    ];
  },
};
