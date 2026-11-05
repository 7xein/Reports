/**
 * Repaired, not invoiced — work the workshop has finished and nobody has
 * billed.
 *
 * The WIP dashboard's tile population (DOM_REPAIRED_NOT_INVOICED), less the job
 * cards whose posted invoices already cover the quotation, listed job by job
 * with what each still owes — so the figure can be chased to a vehicle instead
 * of only counted. That tile reads the matrix status as "has been billed";
 * here the invoices are read instead, because the status is not reliably set,
 * so this list is shorter than the tile by exactly the jobs that were billed
 * and never marked.
 *
 * The invoice column is the point of the report: "nobody raised a bill", "part
 * of it was billed" and "we could not check" are different failures, and a job
 * with no quotation behind it is a fourth one again.
 */

import { fullyBilled, loadCeoData, moneyAtRisk } from './ceo-core';
import { CEO_LIMITS, SEVERITY_ORDER, SEVERITY_TONES, severityFor, type Severity } from './ceo-severity';
import { daysBetween, fmtAed, fmtDays } from './common';
import type { CellValue, ReportColumn, ReportModule, ReportRow, ReportSummaryItem, Tone } from './types';

/**
 * What the invoice chain says about a finished job.
 *
 * `noQuote` is kept apart from `none` and from `unchecked` deliberately: a job
 * with no sale order has nothing to bill from, which is a different thing to
 * ask a branch about than a quotation that was never invoiced, and both are
 * different again from a chain this read could not follow.
 *
 * `partly` is the one that used to read "Posted, not closed". A posted invoice
 * is no longer a category of its own, because a job whose posted invoices cover
 * its order is not listed at all — see the drop below. What is left under a
 * posted bill is an order billed for part of its value, which is money the
 * branch still has to collect and not housekeeping.
 *
 * `warranty` answers over all of them: EVS will never bill the customer for
 * warranty work, so where its bill stands is not the question this column asks.
 * Nothing goes unseen by covering a state with it — an invoice actually raised
 * against the job is still listed on the unposted invoices tab, which warranty
 * does not filter.
 */
const INVOICE = {
  noQuote: 'No quotation',
  none: 'None raised',
  draft: 'Draft, unposted',
  partly: 'Partly invoiced',
  unchecked: 'Unchecked',
  warranty: 'Warranty',
} as const;

const INVOICE_TONES: Record<string, Tone> = {
  [INVOICE.noQuote]: 'bad',
  [INVOICE.none]: 'bad',
  [INVOICE.draft]: 'warn',
  // Real unbilled money, exactly like "None raised": the part of the order
  // nobody has billed is owed whether or not the rest of it was.
  [INVOICE.partly]: 'bad',
  [INVOICE.unchecked]: 'neutral',
  // Not a failure to chase: the work is unbillable by agreement, and only the
  // job card is still open.
  [INVOICE.warranty]: 'neutral',
};

const COLUMNS: ReportColumn[] = [
  { key: 'ro', label: 'Repair order', kind: 'link', hrefKey: 'url' },
  { key: 'branch', label: 'Branch', kind: 'text' },
  { key: 'site', label: 'Site', kind: 'text' },
  { key: 'vehicle', label: 'Vehicle', kind: 'text' },
  { key: 'customer', label: 'Customer', kind: 'text' },
  { key: 'openedBy', label: 'Opened by', kind: 'text' },
  { key: 'matrix', label: 'Matrix status', kind: 'text' },
  { key: 'waiting', label: 'Waiting', kind: 'days' },
  { key: 'invoice', label: 'Invoice', kind: 'badge' },
  // One money column, carrying what is still owed rather than what the
  // quotation was worth. A second column beside it would have the row adding up
  // to more than anybody is waiting for, and every figure the tabs and tiles
  // quote — the total below, the sort, the money at risk on "Needs attention" —
  // is the unbilled part, so a column named for the order's whole value would
  // be the only figure on the page that is not.
  { key: 'value', label: 'Not billed (AED)', kind: 'currency' },
  { key: 'severity', label: 'Severity', kind: 'badge' },
];

const fmtCount = (n: number): string => n.toLocaleString('en-US');

/** Descending, missing figures last: subtracting two absent numbers gives NaN and leaves the order to chance. */
function desc(a: CellValue, b: CellValue): number {
  const x = typeof a === 'number' ? a : null;
  const y = typeof b === 'number' ? b : null;
  if (x == null) return y == null ? 0 : 1;
  if (y == null) return -1;
  return y - x;
}

export const report: ReportModule = {
  async build(params, opts) {
    const data = await loadCeoData(params, opts?.refresh);
    const now = Date.now();

    /** How many waits came from each clock — the note has to say which the reader is looking at. */
    let fromStatus = 0;
    let fromCreated = 0;

    // Finished and billed, whatever the matrix status says. The population is
    // Odoo's own (state done, matrix status not "Closed and Invoiced"), and the
    // matrix status is not reliably set here — plenty of fully invoiced job
    // cards at the station companies were simply never marked — so the posted
    // invoices are asked instead. Counted, because a list that quietly shed
    // rows reads as a branch with less to answer for than it has.
    let billed = 0;

    const rows: ReportRow[] = data.repairedNotInvoiced.filter((job) => {
      if (!fullyBilled(job)) return true;
      billed++;
      return false;
    }).map((job) => {
      // There is no "repaired on" field to age from, so Status Since is the
      // nearest thing; where it is missing the job's own creation date is all
      // that is left, and it ages the job from before the work even started.
      const since = job.statusSince ?? job.created;
      if (job.statusSince != null) fromStatus++;
      else if (job.created != null) fromCreated++;
      const waiting = since != null ? daysBetween(since, now) : null;

      const invoice = job.warranty
        ? INVOICE.warranty
        : job.saleOrderId == null ? INVOICE.noQuote
        : job.invoiceState === 'none' ? INVOICE.none
        : job.invoiceState === 'draft' ? INVOICE.draft
        // Anything that survived the drop above with a posted bill against it
        // is a bill that does not cover the order: part invoiced, part owed.
        : job.invoiceState === 'posted' ? INVOICE.partly
        : INVOICE.unchecked;

      let severity = severityFor(waiting, CEO_LIMITS.notInvoiced);
      // Warranty work will never be billed at all, so what is left is closing
      // the job card, which is housekeeping, and letting that age into Critical
      // would put paperwork above a vehicle nobody has billed. This column
      // grades how urgently somebody should raise a bill, and here the answer is
      // never. Read off the flag and not the badge, because a warranty job shows
      // the warranty badge over whatever else it said and would lose the cap.
      //
      // No cap for a posted invoice any more: the only posted rows left are
      // part-invoiced ones, where the unbilled remainder is a bill somebody
      // still has to raise and ageing it is the point.
      if (job.warranty && SEVERITY_ORDER[severity] < SEVERITY_ORDER.Watch) severity = 'Watch';

      return {
        ro: job.name,
        url: job.url,
        branch: job.branch,
        site: job.site,
        vehicle: job.vehicle || null,
        customer: job.customer || null,
        openedBy: job.createdBy || null,
        matrix: job.matrixLabel || null,
        waiting,
        invoice,
        // What is actually owed, not what the order was worth: a part-invoiced
        // job showing its whole quotation would have the branch chasing money
        // it has already collected. Where the chain could not be followed the
        // whole quotation stands, because an unread invoice is not a paid one —
        // the Unchecked badge beside it is what says the figure is unverified.
        value: moneyAtRisk(job),
        severity,
      };
    });

    // Worst grade first, then the biggest money, then the longest wait: within
    // a grade it is the unbilled value that decides what gets chased today.
    rows.sort((a, b) =>
      SEVERITY_ORDER[a.severity as Severity] - SEVERITY_ORDER[b.severity as Severity]
      || desc(a.value, b.value)
      || desc(a.waiting, b.waiting)
      || String(a.ro).localeCompare(String(b.ro)));

    const trigger = 'Odoo records no "repaired on" timestamp here, so the wait is measured from Status Since — for a repaired job that is normally when it was marked repaired, though the field\'s trigger is unverified on this instance.';
    let waitNote: string;
    if (fromStatus && fromCreated) {
      waitNote = `${trigger} ${fmtCount(fromCreated)} of the ${fmtCount(fromStatus + fromCreated)} jobs below have no Status Since, so their wait falls back to the job's own creation date, which overstates it.`;
    } else if (fromCreated) {
      waitNote = 'Odoo records no "repaired on" timestamp here, and no job below carries a Status Since, so every wait is measured from the job\'s own creation date instead — which overstates every wait, because it counts the repair itself.';
    } else {
      waitNote = trigger;
    }

    const notes = [waitNote];
    // Omitted at zero: a caveat about nothing left out is noise on a page whose
    // other notes all say something the CEO has to act on.
    if (billed) {
      notes.push(`Left out of this list: ${fmtCount(billed)} job card${billed === 1 ? '' : 's'} whose posted invoices already cover the quotation — finished work that has been billed, and only the matrix status still says otherwise. The matrix status is not used to decide this, because it is not reliably set to "Closed and Invoiced" here: a job card can be fully invoiced and never marked.`);
    }
    notes.push(...data.notes);

    return {
      slug: 'not-invoiced',
      title: 'Repaired, not invoiced',
      description: 'Repair orders the workshop has finished while all, or part, of the quotation is still unbilled, with the untaxed value nobody has invoiced yet and where each bill stands.',
      windowDays: null,
      columns: COLUMNS,
      rows,
      branchScoped: true,
      badgeTones: { invoice: INVOICE_TONES, severity: SEVERITY_TONES },
      notes,
    };
  },

  summarise(rows): ReportSummaryItem[] {
    const waits = rows.map((r) => r.waiting).filter((w): w is number => typeof w === 'number');
    const noQuote = rows.filter((r) => r.invoice === INVOICE.noQuote).length;
    // Every row's value is already only the part of its order no invoice covers,
    // so whatever has been billed is out of this total by subtraction rather
    // than by excluding rows. Warranty still goes by the row: the customer will
    // never be billed for it at all, so its remainder is not money owed.
    const unbilled = rows
      .filter((r) => r.invoice !== INVOICE.warranty)
      .reduce((sum, r) => sum + (typeof r.value === 'number' ? r.value : 0), 0);
    return [
      {
        label: 'Repaired, not billed',
        value: fmtCount(rows.length),
        tone: rows.length > 0 ? 'bad' : 'good',
      },
      {
        label: 'AED not billed',
        value: fmtAed(unbilled),
        hint: 'counts only the part of each quotation no invoice covers yet, and excludes warranty work the customer is never billed for',
      },
      { label: 'Longest wait', value: fmtDays(waits.length ? Math.max(...waits) : null) },
      {
        label: `"${INVOICE.noQuote}"`,
        value: fmtCount(noQuote),
        tone: noQuote > 0 ? 'bad' : undefined,
        hint: 'work finished with nothing to bill from',
      },
    ];
  },
};
