/**
 * Unposted invoices — customer invoices raised and left in draft.
 *
 * A draft is the one exception the branch cannot explain away as work in
 * progress: the bill exists, so the revenue has been earned, and until somebody
 * posts it the sales figures do not have it. Every tracked company is in scope,
 * EV Hub and Qatar included, because a draft is a draft wherever it was raised.
 */

import { loadCeoData } from './ceo-core';
import { CEO_LIMITS, SEVERITY_ORDER, SEVERITY_TONES, severityFor, type Severity } from './ceo-severity';
import { daysBetween, fmtAed, fmtDays, gulfDate } from './common';
import type { CellValue, ReportColumn, ReportModule, ReportRow, ReportSummaryItem } from './types';

/**
 * The mark on a service-note row, and the one spelling of it: the tile below
 * reads it back off the rows it is handed, so a second spelling would quietly
 * put a service note's amount back into the unbooked figure.
 */
const SERVICE_NOTE_YES = 'Yes';

const COLUMNS: ReportColumn[] = [
  { key: 'invoice', label: 'Invoice', kind: 'link', hrefKey: 'url' },
  { key: 'branch', label: 'Branch', kind: 'text' },
  { key: 'site', label: 'Site', kind: 'text' },
  { key: 'customer', label: 'Customer', kind: 'text' },
  { key: 'invoiceDate', label: 'Invoice date', kind: 'date' },
  { key: 'created', label: 'Draft created', kind: 'date' },
  { key: 'age', label: 'Age', kind: 'days' },
  { key: 'amount', label: 'Amount (AED)', kind: 'currency' },
  // Next to the amount it qualifies, so the column never reads as money the
  // branch is waiting to book — and so the gap between this column's total and
  // the unbooked tile is explained on the row rather than guessed at.
  //
  // Text, not a badge, although "Yes" is what a badge would say: the filter
  // chips above the table follow the first badge column, so a badge here would
  // take the severity chips over — and would remove them altogether on an
  // instance where no row is a service note and the chip row falls empty.
  { key: 'serviceNote', label: 'Service note', kind: 'text' },
  { key: 'source', label: 'Source', kind: 'text' },
  { key: 'severity', label: 'Severity', kind: 'badge' },
];

const plural = (n: number): string => (n === 1 ? '' : 's');
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

    const rows: ReportRow[] = data.draftInvoices.map((inv) => {
      const age = inv.created != null ? daysBetween(inv.created, now) : null;
      return {
        invoice: inv.name,
        url: inv.url,
        branch: inv.branch,
        site: inv.site,
        customer: inv.customer || null,
        // The day the branch put on the invoice, taken as stored: it is a date,
        // not an instant, and re-deriving it through a timezone would move it.
        invoiceDate: inv.invoiceDate,
        created: inv.created != null ? gulfDate(inv.created) : null,
        age,
        // The amount stays on the row: the branch raised it and somebody still
        // has to post it. Only the unbooked tile leaves a service note out.
        amount: inv.amount,
        serviceNote: inv.serviceNote ? SERVICE_NOTE_YES : null,
        source: inv.origin || null,
        severity: severityFor(age, CEO_LIMITS.unposted),
      };
    });

    // Worst grade first, then the biggest amount, then the oldest draft — the
    // order the invoices should be posted in.
    rows.sort((a, b) =>
      SEVERITY_ORDER[a.severity as Severity] - SEVERITY_ORDER[b.severity as Severity]
      || desc(a.amount, b.amount)
      || desc(a.age, b.age)
      || String(a.invoice).localeCompare(String(b.invoice)));

    /** What the service-note rule took out of the unbooked figure, counted on the rows it took it from. */
    const serviceNotes = data.draftInvoices.filter((inv) => inv.serviceNote);
    const serviceNoteAmount = serviceNotes.reduce((sum, inv) => sum + inv.amount, 0);

    const notes = [
      'A draft invoice is revenue the branch has earned and not booked, so it is missing from the sales figures until somebody posts it. Cancelled invoices are deliberately out of this list: withdrawing a bill is a decision somebody took, not money going unbooked.',
    ];
    // Only where the journals could actually identify one. Where they could
    // not, the shared notes below say so, and claiming the rule here as well
    // would promise an exclusion that is not running.
    if (data.has.serviceNoteJournal) {
      notes.push('A service note is warranty work raised in its own journal and never billed to a customer, so it is listed here — somebody still has to post it — while its amount is left out of the AED unbooked figure, because that money was never going to be booked as revenue.');
    }
    // Beside the rule it explains: the unbooked figure drops the moment service
    // notes are identified, and a drop nobody can attribute is a drop nobody
    // can trust.
    if (serviceNotes.length) {
      notes.push(`Left out of the AED unbooked figure, though still listed above: ${fmtCount(serviceNotes.length)} unposted service note${plural(serviceNotes.length)} worth AED ${fmtAed(serviceNoteAmount)} that would otherwise have counted.`);
    }
    notes.push(...data.notes);

    return {
      slug: 'unposted',
      title: 'Unposted invoices',
      description: 'Customer invoices still in draft across every tracked company, with the untaxed amount each one is keeping out of the books and how long it has sat there.',
      windowDays: null,
      columns: COLUMNS,
      rows,
      branchScoped: true,
      badgeTones: { severity: SEVERITY_TONES },
      notes,
    };
  },

  summarise(rows): ReportSummaryItem[] {
    const ages = rows.map((r) => r.age).filter((a): a is number => typeof a === 'number');
    // A service note is warranty: the customer will never be billed for it, so
    // its amount is not revenue waiting to be booked. The row is still counted
    // in the tile beside this one, because it is still an invoice to post.
    const unbooked = rows.reduce(
      (sum, r) => sum + (r.serviceNote !== SERVICE_NOTE_YES && typeof r.amount === 'number' ? r.amount : 0),
      0,
    );
    const branches = new Set(rows.map((r) => String(r.branch ?? '')).filter(Boolean));
    return [
      {
        label: 'Unposted invoices',
        value: fmtCount(rows.length),
        tone: rows.length > 0 ? 'bad' : 'good',
      },
      {
        label: 'AED unbooked',
        value: fmtAed(unbooked),
        hint: 'service notes excluded — warranty, never billed to a customer',
      },
      { label: 'Oldest draft', value: fmtDays(ages.length ? Math.max(...ages) : null) },
      { label: 'Branches affected', value: fmtCount(branches.size) },
    ];
  },
};
