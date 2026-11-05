/**
 * Oldest open jobs — every open repair order, worst first.
 *
 * The CEO's standing question about work in progress: which vehicles have been
 * in the workshop longest, and how long each has sat in the status it is in
 * now. Every open job is listed, the ones grading OK included: a list filtered
 * down to exceptions answers "what is bad" while hiding how much work there is
 * behind it, and the table already sorts the bad ones to the top.
 */

import { loadCeoData } from './ceo-core';
import { CEO_LIMITS, SEVERITY_ORDER, SEVERITY_TONES, severityFor, type Severity } from './ceo-severity';
import { daysBetween, fmtDays, gulfDate, median } from './common';
import type { CellValue, ReportColumn, ReportModule, ReportRow, ReportSummaryItem, Tone } from './types';

/**
 * Warranty work gets its own column here because this tab has no invoice column
 * to carry it, as the not-invoiced tab's does. Neutral, not bad: the job card is
 * still open and still has to be closed, but the value beside it was never
 * money the company is waiting for — EVS will not bill the customer for it.
 */
const WARRANTY_TONES: Record<string, Tone> = { Yes: 'neutral' };

const COLUMNS: ReportColumn[] = [
  { key: 'ro', label: 'Repair order', kind: 'link', hrefKey: 'url' },
  { key: 'branch', label: 'Branch', kind: 'text' },
  { key: 'site', label: 'Site', kind: 'text' },
  { key: 'vehicle', label: 'Vehicle', kind: 'text' },
  { key: 'customer', label: 'Customer', kind: 'text' },
  { key: 'status', label: 'Repair status', kind: 'text' },
  { key: 'matrix', label: 'Matrix status', kind: 'text' },
  { key: 'opened', label: 'Opened', kind: 'date' },
  { key: 'age', label: 'Age', kind: 'days' },
  { key: 'inStatus', label: 'In status', kind: 'days' },
  { key: 'value', label: 'Value (AED)', kind: 'currency' },
  // Next to the value it qualifies, so the figure is never read as money owed.
  { key: 'warranty', label: 'Warranty', kind: 'badge' },
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

    const rows: ReportRow[] = data.openJobs.map((job) => {
      const age = job.created != null ? daysBetween(job.created, now) : null;
      return {
        ro: job.name,
        url: job.url,
        branch: job.branch,
        site: job.site,
        vehicle: job.vehicle || null,
        customer: job.customer || null,
        status: job.stateLabel || null,
        matrix: job.matrixLabel || null,
        opened: job.created != null ? gulfDate(job.created) : null,
        age,
        inStatus: job.statusSince != null ? daysBetween(job.statusSince, now) : null,
        value: job.value,
        warranty: job.warranty ? 'Yes' : null,
        severity: severityFor(age, CEO_LIMITS.openJob),
      };
    });

    // Worst grade first, then the biggest money, then the longest wait — a
    // Critical job worth nothing still outranks a High one worth a fortune,
    // because the grade is the judgement the page is for.
    rows.sort((a, b) =>
      SEVERITY_ORDER[a.severity as Severity] - SEVERITY_ORDER[b.severity as Severity]
      || desc(a.value, b.value)
      || desc(a.age, b.age)
      || String(a.ro).localeCompare(String(b.ro)));

    const notes = [
      `Every open repair order is listed, including the ones grading OK: a job is only flagged once it has been open ${CEO_LIMITS.openJob.watch} day${plural(CEO_LIMITS.openJob.watch)}, and the rest are here as the work in hand behind those.`,
      ...data.notes,
    ];

    return {
      slug: 'open-jobs',
      title: 'Oldest open jobs',
      description: 'Every open repair order by age, with how long it has sat in its current status and the untaxed value of the quotation behind it. "Open" follows the KPI page\'s closed-stage selector, and Historical Orders are excluded.',
      windowDays: null,
      columns: COLUMNS,
      rows,
      branchScoped: true,
      badgeTones: { severity: SEVERITY_TONES, warranty: WARRANTY_TONES },
      notes,
    };
  },

  summarise(rows): ReportSummaryItem[] {
    const critical = rows.filter((r) => r.severity === 'Critical').length;
    const ages = rows.map((r) => r.age).filter((a): a is number => typeof a === 'number');
    return [
      { label: 'Open jobs', value: fmtCount(rows.length) },
      {
        label: 'Critical',
        value: fmtCount(critical),
        tone: critical > 0 ? 'bad' : undefined,
        hint: `more than ${CEO_LIMITS.openJob.critical} days open`,
      },
      { label: 'Oldest job', value: fmtDays(ages.length ? Math.max(...ages) : null) },
      {
        label: 'Median age',
        value: fmtDays(median(ages)),
        hint: 'half the jobs are older than this',
      },
    ];
  },
};
