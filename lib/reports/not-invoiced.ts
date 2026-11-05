/**
 * Repaired, not invoiced — work the workshop has finished and nobody has
 * billed.
 *
 * The same population as the WIP dashboard's tile (DOM_REPAIRED_NOT_INVOICED),
 * listed job by job with what each is worth, so the figure can be chased to a
 * vehicle instead of only counted. The invoice column is the point of the
 * report: "nobody raised a bill" and "we could not check" are different
 * failures, and a job with no quotation behind it is a third one again.
 */

import { loadCeoData } from './ceo-core';
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
  posted: 'Posted, not closed',
  unchecked: 'Unchecked',
  warranty: 'Warranty',
} as const;

const INVOICE_TONES: Record<string, Tone> = {
  [INVOICE.noQuote]: 'bad',
  [INVOICE.none]: 'bad',
  [INVOICE.draft]: 'warn',
  [INVOICE.posted]: 'neutral',
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
  { key: 'value', label: 'Value (AED)', kind: 'currency' },
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
  async build(params) {
    const data = await loadCeoData(params);
    const now = Date.now();

    /** How many waits came from each clock — the note has to say which the reader is looking at. */
    let fromStatus = 0;
    let fromCreated = 0;

    const rows: ReportRow[] = data.repairedNotInvoiced.map((job) => {
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
        : job.invoiceState === 'posted' ? INVOICE.posted
        : INVOICE.unchecked;

      let severity = severityFor(waiting, CEO_LIMITS.notInvoiced);
      // A posted invoice means the money is booked; warranty work will never be
      // billed at all. Either way what is left is closing the job card, which is
      // housekeeping, and letting that age into Critical would put paperwork
      // above a vehicle nobody has billed. This column grades how urgently
      // somebody should raise a bill, and for both of these the answer is never.
      // Read off the state and not the badge, because a warranty job now shows
      // the warranty badge over its posted one and would otherwise lose the cap.
      if ((job.invoiceState === 'posted' || job.warranty) && SEVERITY_ORDER[severity] < SEVERITY_ORDER.Watch) severity = 'Watch';

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
        value: job.value,
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

    return {
      slug: 'not-invoiced',
      title: 'Repaired, not invoiced',
      description: 'Repair orders the workshop has finished while no customer invoice has been posted against them, with the untaxed value of each quotation and where its invoice stands.',
      windowDays: null,
      columns: COLUMNS,
      rows,
      branchScoped: true,
      badgeTones: { invoice: INVOICE_TONES, severity: SEVERITY_TONES },
      notes: [waitNote, ...data.notes],
    };
  },

  summarise(rows): ReportSummaryItem[] {
    const waits = rows.map((r) => r.waiting).filter((w): w is number => typeof w === 'number');
    const noQuote = rows.filter((r) => r.invoice === INVOICE.noQuote).length;
    // A posted invoice is money already booked, and warranty work is money the
    // customer will never be billed, so counting either here would inflate what
    // the branches still have to bill.
    const unbilled = rows
      .filter((r) => r.invoice !== INVOICE.posted && r.invoice !== INVOICE.warranty)
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
        hint: 'excludes jobs already invoiced but not closed, and warranty work the customer is never billed for',
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
