/**
 * Needs attention — one ranked list of everything wrong right now.
 *
 * The CEO's landing page. Jobs open too long, repaired work nobody has billed
 * and invoices left in draft are three different failures, and reading them on
 * three tabs means ranking them by hand; put side by side and graded in the one
 * severity vocabulary, the worst thing in the company is the top row.
 *
 * The detail tabs behind this one carry the full lists. This page is the
 * exceptions only — an open job under the Watch limit is work in progress, and
 * showing it here would bury the fortnight-old ones in ordinary traffic.
 */

import { fullyBilled, loadCeoData, moneyAtRisk, uninvoicedValue, type CeoInvoice, type CeoJob } from './ceo-core';
import { CEO_LIMITS, SEVERITY_ORDER, SEVERITY_TONES, severityFor, type Severity } from './ceo-severity';
import { daysBetween, fmtAed, fmtDays } from './common';
import {
  BRANCH_KEY,
  SITE_KEY,
  type ReportColumn,
  type ReportModule,
  type ReportRow,
  type ReportSummaryItem,
  type Tone,
} from './types';

const CATEGORY = { job: 'Job too old', notInvoiced: 'Not invoiced', unposted: 'Invoice unposted' } as const;

const CATEGORY_TONES: Record<string, Tone> = {
  [CATEGORY.job]: 'warn',
  [CATEGORY.notInvoiced]: 'bad',
  [CATEGORY.unposted]: 'bad',
};

/** The source document is a pointer to the right record, not a transcript of invoice_origin. */
const SOURCE_MAX = 60;

const COLUMNS: ReportColumn[] = [
  { key: 'severity', label: 'Severity', kind: 'badge' },
  { key: 'category', label: 'What', kind: 'badge' },
  // One link per row: every row key ships to the browser as JSON under a 4 MB
  // cap, so the record number carries the only URL on the row.
  { key: 'ref', label: 'Record', kind: 'link', hrefKey: 'url' },
  { key: BRANCH_KEY, label: 'Branch', kind: 'text' },
  { key: SITE_KEY, label: 'Site', kind: 'text' },
  { key: 'subject', label: 'Vehicle / customer', kind: 'text' },
  { key: 'owner', label: 'Owner', kind: 'text' },
  { key: 'detail', label: 'Why', kind: 'text' },
  { key: 'days', label: 'Days', kind: 'days' },
  { key: 'aed', label: 'AED at risk', kind: 'currency' },
];

const plural = (n: number): string => (n === 1 ? '' : 's');
const fmtCount = (n: number): string => n.toLocaleString('en-US');

/** A row before it is flattened: the sort compares numbers, which CellValue is not. */
interface Item {
  severity: Severity;
  category: string;
  ref: string;
  url: string | null;
  branch: string;
  site: string;
  subject: string;
  owner: string;
  detail: string;
  days: number | null;
  aed: number;
}

/**
 * What a job's own row is allowed to carry.
 *
 * The headline tile is the sum of this column, so no riyal may appear twice: a
 * job carries the part of its order no invoice covers yet. What is already on a
 * draft invoice is counted on that invoice by source C below, and what is on a
 * posted one is revenue in the books — so subtracting both leaves exactly the
 * money nobody has billed, once.
 *
 * A subtraction rather than the set of cases this used to be. "A draft bill
 * exists, so carry nothing" was a stand-in for "the bill covers the order", and
 * it was wrong by the whole remainder on a job billed for part of its value —
 * which is the money the branch is least likely to chase. The amounts answer
 * the question the cases were approximating, and a fully covered order now
 * falls out at zero arithmetically instead of by a rule.
 *
 * The amounts come off the order, never from matching invoices back to jobs
 * through invoice_origin: a wrong match would cancel a real exception and
 * inflate another, and this way the three sources stay disjoint by
 * construction. A job with no quotation has no value to carry in any case.
 *
 * Warranty work carries nothing at all: EVS will never bill the customer for
 * it, so its value was never money anybody is waiting for.
 */
function jobAed(job: CeoJob): number {
  if (job.warranty) return 0;
  return moneyAtRisk(job);
}

/**
 * What the warranty rule took off a row, as against what the invoice rule had
 * already taken off it.
 *
 * The headline is dropping for two reasons at once — parked job cards and now
 * warranty — and a drop nobody can attribute to one of them is a drop nobody
 * can trust. So this is exactly what the row would have carried without the
 * warranty rule: its uninvoiced part, the same figure jobAed above would have
 * returned. Counting the whole order instead would overstate what warranty
 * removed by whatever has already been billed, and the note would stop
 * reconciling against the change in the tile.
 */
function warrantyAed(job: CeoJob): number {
  if (!job.warranty) return 0;
  return moneyAtRisk(job);
}

/** Warranty work is still a job card to close, so the row stays; the clause is what stops the reader asking where its value went. */
function withWarranty(detail: string, job: CeoJob): string {
  if (!job.warranty) return detail;
  const via = job.warrantyVia ? ` (${job.warrantyVia})` : '';
  return `${detail}; warranty work${via}, so not money at risk`;
}

/**
 * What an unposted invoice is allowed to carry.
 *
 * A service note is warranty under another name — raised in its own journal,
 * never billed to the customer — so the amount on it was never money anybody is
 * waiting for. Zeroed exactly as a warranty job is, and for the same reason.
 */
function invoiceAed(inv: CeoInvoice): number {
  if (inv.serviceNote) return 0;
  return inv.amount;
}

/** A service note still has to be posted, so the row stays; the clause is what stops the reader asking where its amount went. */
function withServiceNote(detail: string, inv: CeoInvoice): string {
  if (!inv.serviceNote) return detail;
  return `${detail}; service note (warranty), so not money at risk`;
}

/** The vehicle is what the branch calls the job; the customer is the fallback, never both. */
const subjectOf = (job: CeoJob): string => job.vehicle || job.customer;

/** Every clause inside a detail sentence measures days the same way, or one sentence contradicts itself. */
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function jobDetail(job: CeoJob, days: number | null, now: number): string {
  const age = days == null ? 'Open, with no creation date to age from' : `Open ${fmtDays(days)}`;
  // Where it sits matters as much as how long it has been open: a job stuck in
  // Awaiting Parts for six weeks is somebody else's queue, not the workshop's.
  const stuck = job.statusSince != null ? fmtDays(daysBetween(job.statusSince, now)) : null;
  const where = job.matrixLabel || 'in its current status';
  if (stuck != null) return `${age}; ${where} for ${stuck}`;
  return job.matrixLabel ? `${age}; ${job.matrixLabel}` : age;
}

/**
 * Why an unbilled job is on the list — one clause per failure, because the four
 * states need four different people to act. "Could not check" is kept apart
 * from "nothing raised": printing an unread chain as unbilled would accuse a
 * branch of work it may well have invoiced.
 */
function unbilledReason(job: CeoJob): string {
  // saleOrderId first: with no quotation there is nothing to go looking for, so
  // 'unknown' here would read as a failed check rather than as a missing bill.
  if (job.saleOrderId == null) return 'no quotation exists to bill from';
  switch (job.invoiceState) {
    case 'none':
      return 'no bill raised';
    case 'draft':
      return 'the bill is still in draft — counted on the unposted invoices tab, not here';
    case 'posted': {
      // No row reaches this fully billed — source B drops those — so a posted
      // bill here is one that does not cover the order. The remainder is named
      // rather than left to the AED column, because "invoiced and posted" on
      // its own reads as settled and would have the CEO skip the row.
      const left = uninvoicedValue(job);
      return left == null
        ? 'invoiced and posted in part, and how much of it is still unbilled could not be worked out'
        : `invoiced and posted in part, AED ${fmtAed(left)} of the quotation still unbilled`;
    }
    default:
      return 'the invoicing could not be checked';
  }
}

/**
 * `lead` is the open-age clause, present only for a job that is on the open list
 * too. It comes first because it is the older fact, and the wait clause then
 * reads as a second clause rather than a second heading.
 */
function notInvoicedDetail(job: CeoJob, days: number | null, lead: string | null): string {
  const clock = days == null
    ? 'no date to measure the wait from'
    : job.statusSince != null
      ? `repaired ${fmtDays(days)} ago`
      // With a lead clause the age has already been printed, and printing the
      // same figure twice in one sentence reads as two different measurements.
      : lead
        ? 'no repaired date, so the wait runs from when the job was opened'
        : `open ${fmtDays(days)}, no repaired date`;
  const parts = lead ? [lead, clock] : [upperFirst(clock)];
  parts.push(unbilledReason(job));
  return parts.join('; ');
}

function invoiceDetail(inv: CeoInvoice, days: number | null): string {
  const draft = days == null ? 'In draft, with no creation date to age from' : `Draft for ${fmtDays(days)}`;
  const raw = inv.saleOrderNames.length ? inv.saleOrderNames.join(', ') : inv.origin;
  const source = raw.length > SOURCE_MAX ? `${raw.slice(0, SOURCE_MAX - 1).trimEnd()}…` : raw;
  return source ? `${draft}, raised from ${source}` : draft;
}

/**
 * Oldest first, with nothing-to-age-by last. Arithmetic on two nulls would
 * return NaN, which a comparator reads as "equal" and which would swallow the
 * ref tie-break that keeps the order stable between refreshes.
 */
function byDays(a: Item, b: Item): number {
  if (a.days == null) return b.days == null ? 0 : 1;
  if (b.days == null) return -1;
  return b.days - a.days;
}

const toRow = (i: Item): ReportRow => ({
  severity: i.severity,
  category: i.category,
  ref: i.ref,
  url: i.url,
  [BRANCH_KEY]: i.branch,
  [SITE_KEY]: i.site,
  subject: i.subject || null,
  owner: i.owner || null,
  detail: i.detail,
  days: i.days,
  aed: i.aed,
});

export const report: ReportModule = {
  async build(params, opts) {
    const data = await loadCeoData(params, opts?.refresh);
    const now = Date.now();
    const items: Item[] = [];

    // The two job domains overlap by design: "open" is the KPI page's closed-stage
    // selector (by default priority_matrix_status != 'X') and "repaired, not
    // invoiced" is state done with the same exclusion, so a repaired job is an
    // open job too. One vehicle is one thing to deal with, and work that is
    // finished is not a job taking too long in the workshop — it is an unbilled
    // job, with a different owner and a different next step. So the overlap
    // emits a single row, under "Not invoiced", graded by whichever of the two
    // failures is worse; two rows would also make the headline count rows
    // rather than vehicles, and charge one vehicle's value twice.
    //
    // The set is every repaired job, including the ones source B drops as
    // already billed: a finished, billed job card is not work taking too long
    // in the workshop either, so it leaves this page altogether rather than
    // reappearing under "Job too old" — which is where the finished-and-billed
    // job cards nobody ever marked Closed and Invoiced would all pile up.
    const unbilledIds = new Set(data.repairedNotInvoiced.map((j) => j.id));
    const openIds = new Set(data.openJobs.map((j) => j.id));

    /** What the warranty rule removed, counted on the rows it removed it from — the overlap above means once per vehicle. */
    let warrantyJobs = 0;
    let warrantyRemoved = 0;

    // ── A: open too long ──
    for (const job of data.openJobs) {
      if (unbilledIds.has(job.id)) continue;   // claimed by source B below
      const days = job.created != null ? daysBetween(job.created, now) : null;
      const severity = severityFor(days, CEO_LIMITS.openJob);
      // Work in progress is not an exception. Every open job, graded or not, is
      // on the "Oldest open jobs" tab.
      if (severity === 'OK') continue;
      items.push({
        severity,
        category: CATEGORY.job,
        ref: job.name,
        url: job.url,
        branch: job.branch,
        site: job.site,
        subject: subjectOf(job),
        owner: job.createdBy,
        detail: withWarranty(jobDetail(job, days, now), job),
        days,
        aed: jobAed(job),
      });
      if (job.warranty) {
        warrantyJobs++;
        warrantyRemoved += warrantyAed(job);
      }
    }

    // ── B: repaired, not invoiced ──
    for (const job of data.repairedNotInvoiced) {
      // Finished and billed: the posted invoices cover the quotation, whatever
      // the matrix status says — and the status is not reliably set here, so a
      // job card can be fully invoiced and never marked. There is nothing for
      // anybody to chase, and this is the exceptions page. Dropped before the
      // row is built so neither the count nor the money can reach a tile by
      // another path; the full list is on the "Repaired, not invoiced" tab,
      // which says how many it left out for the same reason.
      if (fullyBilled(job)) continue;
      // Odoo stamps no "repaired on" date here, so Status Since is the closest
      // thing to one; creation is the last resort and overstates the wait.
      const from = job.statusSince ?? job.created;
      const unbilledAge = from != null ? daysBetween(from, now) : null;
      // No cap for a posted bill any more. It used to read "posted money is
      // booked, so only the job card is open" — but the jobs that were true of
      // are the ones dropped above, and what is left under a posted bill is an
      // order billed in part, where the unbilled remainder is a bill somebody
      // still has to raise. Capping it would park real money at Watch, and the
      // "Repaired, not invoiced" tab, which no longer caps it either, would
      // grade the same job differently.
      let severity = severityFor(unbilledAge, CEO_LIMITS.notInvoiced);

      // The open-list grading of the same job, for the overlap described above.
      // Uncapped, unlike the unbilled grading: a job card left open ninety days
      // is a real problem whatever its invoice says, and the AED column already
      // tells the reader whether money is at stake.
      let days = unbilledAge;
      let lead: string | null = null;
      if (openIds.has(job.id)) {
        const openAge = job.created != null ? daysBetween(job.created, now) : null;
        lead = jobDetail(job, openAge, now);
        const openSeverity = severityFor(openAge, CEO_LIMITS.openJob);
        // Worse wins, and on a tie the open age does: it is the larger figure
        // and the longer-standing fact, so the number explains the badge.
        if (SEVERITY_ORDER[openSeverity] <= SEVERITY_ORDER[severity]) {
          severity = openSeverity;
          days = openAge;
        }
      }

      items.push({
        severity,
        category: CATEGORY.notInvoiced,
        ref: job.name,
        url: job.url,
        branch: job.branch,
        site: job.site,
        subject: subjectOf(job),
        owner: job.createdBy,
        // The wait clause keeps the unbilled age whichever grading won: the
        // repaired date is what the branch has to answer for, not the row's sort key.
        detail: withWarranty(notInvoicedDetail(job, unbilledAge, lead), job),
        days,
        aed: jobAed(job),
      });
      if (job.warranty) {
        warrantyJobs++;
        warrantyRemoved += warrantyAed(job);
      }
    }

    // ── C: invoices never posted ──
    /** What the service-note rule removed, counted on the rows it removed it from. */
    let serviceNotes = 0;
    let serviceNoteRemoved = 0;

    for (const inv of data.draftInvoices) {
      const days = inv.created != null ? daysBetween(inv.created, now) : null;
      items.push({
        severity: severityFor(days, CEO_LIMITS.unposted),
        category: CATEGORY.unposted,
        ref: inv.name,
        url: inv.url,
        branch: inv.branch,
        site: inv.site,
        subject: inv.customer,
        // Nothing on a customer invoice names a person here, and a guessed owner
        // would send the chase to the wrong desk.
        owner: '',
        detail: withServiceNote(invoiceDetail(inv, days), inv),
        days,
        aed: invoiceAed(inv),
      });
      if (inv.serviceNote) {
        serviceNotes++;
        // What it would have contributed under the money rule above — the full
        // amount, since an unposted invoice carries its own money and nothing
        // else was already taking it off. Anything broader would not reconcile
        // against the change in the headline tile.
        serviceNoteRemoved += inv.amount;
      }
    }

    // Severity before money, deliberately: a critical row is a critical row
    // whatever it is worth, and sorting by value first would park a cheap job
    // that has been open four months below a fresh invoice.
    items.sort((a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.aed - a.aed ||
      byDays(a, b) ||
      a.ref.localeCompare(b.ref));

    const watch = CEO_LIMITS.openJob.watch;
    const notes = [
      'Every open exception across the branches in one list, worst first. The three tabs behind this one — oldest open jobs, repaired and not invoiced, unposted invoices — carry the full lists, including the rows this page leaves out as ordinary.',
      `An open repair order appears here only once it has been open longer than ${watch} day${plural(watch)}, so this is the exceptions and not a work list.`,
      'AED at risk counts each amount once: a job carries the part of its quotation that no invoice covers yet, so whatever is already on a draft invoice is counted on that invoice instead and whatever is on a posted one is revenue already booked. A finished job whose posted invoices cover the whole quotation is not an exception at all and is not listed. A warranty job carries nothing because the customer will never be billed for it, an unposted service note carries nothing because a service note is warranty raised in its own journal and is never billed to a customer either, and a job that is both open too long and unbilled is listed once, as unbilled, graded by whichever of the two is worse.',
    ];
    // Next to the rule they explain: the money at risk is falling for warranty,
    // for service notes and for parked job cards all at once, and a drop that
    // cannot be attributed to one of them is a drop nobody can trust.
    if (warrantyJobs) {
      notes.push(`Warranty work is listed but carries no money at risk: ${fmtCount(warrantyJobs)} job${plural(warrantyJobs)} worth AED ${fmtAed(warrantyRemoved)} that would otherwise have counted.`);
    }
    if (serviceNotes) {
      notes.push(`Service notes are listed but carry no money at risk: ${fmtCount(serviceNotes)} unposted service note${plural(serviceNotes)} worth AED ${fmtAed(serviceNoteRemoved)} that would otherwise have counted.`);
    }
    if (!data.has.invoiceState) {
      // A clean-looking total over an unverified basis is worse than no total:
      // the CEO would act on a figure that silently counts the same money twice.
      notes.push('The invoicing of each job could not be checked on this instance, so a job and its own draft invoice may both be counted and the money at risk is therefore an over-estimate.');
    }
    notes.push('Odoo records no "repaired on" timestamp here, so the not-invoiced wait runs from Status Since — normally when the job was marked repaired, though the field\'s trigger is unverified on this instance — or from the job\'s creation where Status Since is absent, which overstates the wait.');
    notes.push(...data.notes);

    return {
      slug: 'attention',
      title: 'Needs attention',
      description: 'Open repair orders past their age limit, repaired work that has not been billed, and customer invoices left in draft — ranked worst first, with the money at risk on each row counted once.',
      windowDays: null,
      columns: COLUMNS,
      rows: items.map(toRow),
      branchScoped: true,
      badgeTones: { severity: SEVERITY_TONES, category: CATEGORY_TONES },
      notes,
    };
  },

  // Called on the full rows and again per branch, so every tile is derived from
  // the rows handed in — a figure read from module scope would show the whole
  // company's total under one branch's name.
  summarise(rows): ReportSummaryItem[] {
    const aed = rows.reduce((sum, r) => sum + (typeof r.aed === 'number' ? r.aed : 0), 0);
    const critical = rows.filter((r) => r.severity === 'Critical').length;
    const ages = rows.map((r) => r.days).filter((d): d is number => typeof d === 'number');
    return [
      {
        label: 'AED at risk',
        value: fmtAed(aed),
        tone: aed > 0 ? 'bad' : 'good',
        hint: 'repaired work not billed, plus invoices never posted',
      },
      { label: 'Needs attention', value: fmtCount(rows.length), tone: rows.length > 0 ? 'bad' : 'good' },
      {
        label: 'Critical',
        value: fmtCount(critical),
        tone: critical > 0 ? 'bad' : undefined,
        hint: `open ${CEO_LIMITS.openJob.critical}+ days, unbilled ${CEO_LIMITS.notInvoiced.critical}+, or in draft ${CEO_LIMITS.unposted.critical}+`,
      },
      { label: 'Oldest', value: fmtDays(ages.length ? Math.max(...ages) : null) },
    ];
  },
};
