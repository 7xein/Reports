/**
 * Open parts and why — every part still short on an open repair order, with
 * the step of the purchasing chain it is stuck at.
 *
 * "Parts without RFQ" stops at the first missing link (no RFQ at all); this
 * follows each part down the chain — RFQ, confirmation, receipt, issue to the
 * job — so a branch can see which step its backlog is piling up behind.
 */

import {
  loadPartsChain, CONFIRMED_STATES,
  type LinkedPo, type OpenRo, type PartsChain, type PoLine, type PoLines, type ShortLine,
} from './parts-chain';
import { daysBetween, gulfDate } from './common';
import type { ReportColumn, ReportModule, ReportRow, ReportSummaryItem, Tone } from './types';

const REASON = {
  inStock: 'In stock, not issued',
  noVehicle: 'No vehicle on RO',
  noRfq: 'No RFQ',
  notOnRfq: 'Not on any RFQ',
  unconfirmed: 'RFQ not confirmed',
  overdue: 'Ordered, overdue',
  ordered: 'Ordered, not received',
  received: 'Received, not issued',
} as const;

const REASON_TONES: Record<string, Tone> = {
  [REASON.inStock]: 'warn',
  [REASON.noVehicle]: 'neutral',
  [REASON.noRfq]: 'bad',
  [REASON.notOnRfq]: 'bad',
  [REASON.unconfirmed]: 'warn',
  [REASON.overdue]: 'bad',
  [REASON.ordered]: 'neutral',
  [REASON.received]: 'warn',
};

const COLUMNS: ReportColumn[] = [
  { key: 'ro', label: 'Repair order', kind: 'text' },
  { key: 'branch', label: 'Branch', kind: 'text' },
  { key: 'site', label: 'Site', kind: 'text' },
  { key: 'vehicle', label: 'Vehicle', kind: 'text' },
  { key: 'part', label: 'Part', kind: 'text' },
  { key: 'demand', label: 'Needed', kind: 'number' },
  { key: 'done', label: 'Done', kind: 'number' },
  { key: 'added', label: 'Part added', kind: 'date' },
  { key: 'age', label: 'Age', kind: 'days' },
  { key: 'reason', label: 'Why', kind: 'badge' },
  { key: 'po', label: 'RFQ / PO', kind: 'text' },
  { key: 'poStatus', label: 'PO status', kind: 'text' },
  { key: 'confirmed', label: 'PO confirmed', kind: 'date' },
  { key: 'expected', label: 'Expected', kind: 'date' },
  { key: 'received', label: 'Received qty', kind: 'number' },
];

const plural = (n: number): string => (n === 1 ? '' : 's');
const fmtCount = (n: number): string => n.toLocaleString('en-US');
const day = (t: number | null): string | null => (t == null ? null : gulfDate(t));

/** How far down the chain a purchase order line has got: 1 RFQ, 2 confirmed, 3 fully received. */
type Stage = 1 | 2 | 3;
type Match = { po: LinkedPo; line: PoLine; stage: Stage };

function stageOf(po: LinkedPo, line: PoLine, hasReceived: boolean): Stage {
  if (!CONFIRMED_STATES.includes(po.state)) return 1;
  // A zero-quantity line orders nothing, so "received all of nothing" is not a
  // delivery. Without qty_received, an Arrival date is the only receipt evidence.
  const received = hasReceived ? line.qty > 0 && (line.received ?? 0) >= line.qty : po.arrived != null;
  return received ? 3 : 2;
}

/** Raised later — the id breaks a tie, since ids grow with creation too. */
function later(a: LinkedPo, b: LinkedPo): boolean {
  const ta = a.created ?? -Infinity;
  const tb = b.created ?? -Infinity;
  return ta !== tb ? ta > tb : a.id > b.id;
}

/**
 * The purchase order line that best explains this part: the furthest along the
 * chain wins, then the newest order. One part is often re-quoted or split
 * across orders, and the one that got furthest is the one the job is actually
 * waiting on.
 */
function bestMatch(ro: OpenRo, part: ShortLine, chain: PartsChain, lines: PoLines): Match | null {
  if (part.productId == null || !ro.poIds) return null;
  let best: Match | null = null;
  for (const id of ro.poIds) {
    const po = chain.pos.get(id);
    if (!po) continue;
    for (const line of lines.byOrder.get(id) ?? []) {
      if (line.productId !== part.productId) continue;
      const m: Match = { po, line, stage: stageOf(po, line, lines.hasReceived) };
      if (!best || m.stage > best.stage || (m.stage === best.stage && later(po, best.po))) best = m;
    }
  }
  return best;
}

/** First match wins, in the order the chain is walked backwards from the job. */
function reasonFor(ro: OpenRo, part: ShortLine, lines: PoLines, match: Match | null, now: number): string | null {
  // Reserved on the shelf: nothing is missing but the consumption itself.
  if (part.state === 'assigned') return REASON.inStock;
  if (ro.vehicleId == null) return REASON.noVehicle;
  // Unknown is left blank rather than guessed: "no RFQ" from a failed read
  // would send someone chasing a request that already exists.
  if (ro.poIds === null) return null;
  if (!ro.poIds.length) return REASON.noRfq;
  if (ro.poIds.some((id) => lines.unread.has(id)) || part.productId == null) return null;
  if (!match) return REASON.notOnRfq;
  if (match.stage === 1) return REASON.unconfirmed;
  if (match.stage === 3) return REASON.received;
  // The line's own date first: one order can promise its lines on different days.
  const expected = match.line.planned ?? match.po.planned;
  return expected != null && now > expected ? REASON.overdue : REASON.ordered;
}

export const report: ReportModule = {
  async build(params) {
    const chain = await loadPartsChain(params);
    const lines = await chain.poLines();
    const now = Date.now();

    const rows: ReportRow[] = [];
    let unknown = 0;
    for (const ro of chain.ros) {
      for (const part of ro.short) {
        const match = bestMatch(ro, part, chain, lines);
        const reason = reasonFor(ro, part, lines, match, now);
        if (reason == null) unknown++;
        rows.push({
          ro: ro.name,
          branch: ro.branch,
          site: ro.site,
          vehicle: ro.vehicle,
          part: part.product || null,
          demand: part.demand,
          done: part.done,
          added: day(part.added),
          age: part.added != null ? daysBetween(part.added, now) : null,
          reason,
          // Shown whenever a line matched, whatever the reason: for a part on the
          // shelf it is where that part most likely came from.
          po: match?.po.name || null,
          poStatus: match?.po.stateLabel || null,
          confirmed: day(match?.po.approved ?? null),
          expected: day(match ? match.line.planned ?? match.po.planned : null),
          received: match?.line.received ?? null,
        });
      }
    }

    // Oldest part first; a part with no date to age from goes last.
    const age = (r: ReportRow) => (typeof r.age === 'number' ? r.age : -Infinity);
    rows.sort((a, b) => age(b) - age(a) || String(a.ro).localeCompare(String(b.ro)));

    const notes = [
      'RFQs link to repair orders only through the vehicle: an RFQ or purchase order in any state but cancelled, raised for the same vehicle after the repair order was opened, counts for it — and a part is on it when one of its lines carries the same product. Where several lines match, the one furthest along decides the stage.',
    ];
    if (!chain.has.moveState) {
      notes.push('Parts lines carry no state here, so a part already reserved in stock could not be recognised and “In stock, not issued” never appears.');
    }
    if (unknown) {
      notes.push(`${unknown} part${plural(unknown)} ${unknown === 1 ? 'was' : 'were'} left without a reason because purchasing could not be read for ${unknown === 1 ? 'it' : 'them'}.`);
    }
    notes.push(...lines.notes, ...chain.notes);

    return {
      slug: 'open-parts',
      title: 'Open parts and why',
      description: 'Every part still short (Done below Demand) on an open repair order, with where it is stuck in the purchasing chain.',
      windowDays: null,
      columns: COLUMNS,
      rows,
      branchScoped: true,
      badgeTones: { reason: REASON_TONES },
      notes,
    };
  },

  summarise(rows): ReportSummaryItem[] {
    const count = (...reasons: string[]) => rows.filter((r) => typeof r.reason === 'string' && reasons.includes(r.reason)).length;
    const ros = new Set(rows.map((r) => r.ro)).size;
    const noRfq = count(REASON.noRfq, REASON.notOnRfq);
    const overdue = count(REASON.overdue);
    const withPurchasing = count(REASON.unconfirmed, REASON.overdue, REASON.ordered);
    const arrived = count(REASON.inStock, REASON.received);
    return [
      { label: 'Parts short', value: fmtCount(rows.length), hint: `on ${fmtCount(ros)} repair order${plural(ros)}` },
      { label: 'No RFQ yet', value: fmtCount(noRfq), tone: noRfq > 0 ? 'bad' : undefined },
      {
        label: 'With purchasing',
        value: fmtCount(withPurchasing),
        tone: overdue > 0 ? 'warn' : undefined,
        hint: `${fmtCount(overdue)} past the expected date`,
      },
      { label: 'Arrived, not issued', value: fmtCount(arrived), tone: arrived > 0 ? 'warn' : undefined },
    ];
  },
};
