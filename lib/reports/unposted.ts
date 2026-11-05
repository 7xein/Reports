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

const COLUMNS: ReportColumn[] = [
  { key: 'invoice', label: 'Invoice', kind: 'link', hrefKey: 'url' },
  { key: 'branch', label: 'Branch', kind: 'text' },
  { key: 'site', label: 'Site', kind: 'text' },
  { key: 'customer', label: 'Customer', kind: 'text' },
  { key: 'invoiceDate', label: 'Invoice date', kind: 'date' },
  { key: 'created', label: 'Draft created', kind: 'date' },
  { key: 'age', label: 'Age', kind: 'days' },
  { key: 'amount', label: 'Amount (AED)', kind: 'currency' },
  { key: 'source', label: 'Source', kind: 'text' },
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
        amount: inv.amount,
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

    const notes = [
      'A draft invoice is revenue the branch has earned and not booked, so it is missing from the sales figures until somebody posts it. Cancelled invoices are deliberately out of this list: withdrawing a bill is a decision somebody took, not money going unbooked.',
      ...data.notes,
    ];

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
    const unbooked = rows.reduce((sum, r) => sum + (typeof r.amount === 'number' ? r.amount : 0), 0);
    const branches = new Set(rows.map((r) => String(r.branch ?? '')).filter(Boolean));
    return [
      {
        label: 'Unposted invoices',
        value: fmtCount(rows.length),
        tone: rows.length > 0 ? 'bad' : 'good',
      },
      { label: 'AED unbooked', value: fmtAed(unbooked) },
      { label: 'Oldest draft', value: fmtDays(ages.length ? Math.max(...ages) : null) },
      { label: 'Branches affected', value: fmtCount(branches.size) },
    ];
  },
};
