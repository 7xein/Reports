/**
 * One severity vocabulary for every CEO report.
 *
 * The attention list ranks jobs against invoices against drafts, so the four
 * tabs have to grade in the same words: a "Critical" on one page and a
 * "Critical" on another must mean the same thing, or the ranked list is sorting
 * by labels that were never comparable.
 *
 * The limits are days, deliberately coarser than the KPI thresholds in
 * lib/types.ts. Those measure a stage against its business-hours target; these
 * answer a different question — how long before something is bad enough for the
 * CEO to be looking at it. They are constants here rather than Admin settings
 * because nobody has argued about the numbers yet; when somebody does, this is
 * the one place to move them from.
 */

import type { Tone } from './types';

export type Severity = 'Critical' | 'High' | 'Watch' | 'OK';

export const SEVERITY_TONES: Record<string, Tone> = {
  Critical: 'bad',
  High: 'warn',
  Watch: 'neutral',
  OK: 'good',
};

/** Worst first — the sort key behind every CEO table's default order. */
export const SEVERITY_ORDER: Record<Severity, number> = { Critical: 0, High: 1, Watch: 2, OK: 3 };

export interface SeverityLimits {
  critical: number;
  high: number;
  /** Everything at or above this is at least Watch. Zero means nothing in the population is ever OK. */
  watch: number;
}

/**
 * Day limits per kind of exception.
 *
 * `watch: 0` on the two money lists is the point: a repaired job nobody billed
 * is an exception on day one, so it must never grade OK. An open job, by
 * contrast, is just work in progress until it has been open a fortnight.
 */
export const CEO_LIMITS: Record<'openJob' | 'notInvoiced' | 'unposted', SeverityLimits> = {
  openJob: { critical: 60, high: 30, watch: 14 },
  notInvoiced: { critical: 14, high: 7, watch: 0 },
  unposted: { critical: 7, high: 2, watch: 0 },
};

/**
 * The grade for an elapsed number of days.
 *
 * A null age reads Watch, never OK: a record with no date to age from is still
 * on the list, and grading it OK would quietly drop it off the bottom.
 */
export function severityFor(days: number | null, limits: SeverityLimits): Severity {
  if (days == null) return 'Watch';
  if (days >= limits.critical) return 'Critical';
  if (days >= limits.high) return 'High';
  if (days >= limits.watch) return 'Watch';
  return 'OK';
}
