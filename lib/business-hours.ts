/**
 * Business-hours clock — the unit every elapsed-time KPI is measured in.
 *
 * Per the KPI appendix (effective 1 Nov 2026) the clock runs only during working
 * hours, so a car checked in at 17:00 is not failed by the night, and a Thursday
 * evening job is not failed by the weekend.
 *
 * All arithmetic shifts epoch ms by +4h and then reads UTC values, which is the
 * codebase's convention for "Gulf local time" (see lib/kpi.ts, lib/odoo.ts) and
 * keeps the result independent of the server's own timezone.
 */

/** Gulf business week: Saturday–Thursday, 09:00–18:00. Friday is the weekend. */
export const BUSINESS_START_HOUR = 9;
export const BUSINESS_END_HOUR = 18;
export const BUSINESS_MS_PER_DAY = (BUSINESS_END_HOUR - BUSINESS_START_HOUR) * 3600_000;

// ── Internals ──────────────────────────────────────────────────────
const GULF_OFFSET_MS = 4 * 3600_000;
const MS_PER_DAY = 86_400_000;
const FRIDAY = 5;                 // 0=Sun … 6=Sat, matching Date#getUTCDay
const OPEN_MS = BUSINESS_START_HOUR * 3600_000;
const CLOSE_MS = BUSINESS_END_HOUR * 3600_000;

/**
 * Interior whole days still walked one at a time. Below this a plain loop is
 * cheaper than scanning the holiday list; above it we count weeks arithmetically
 * so a stray timestamp can never turn one KPI row into a million iterations.
 */
const LOOP_DAY_LIMIT = 14;

/** Gulf day number (days since 1970-01-01 Gulf), the unit the whole file works in. */
function gulfDayOf(gulfMs: number): number {
  return Math.floor(gulfMs / MS_PER_DAY);
}

/** 1970-01-01 was a Thursday (getUTCDay 4), so the weekday follows from the day number. */
function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** Gulf day number → 'YYYY-MM-DD', the key holidays are listed under. */
function isoOfDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → Gulf day number, or null if the string is not a date. */
function dayOfIso(iso: string): number | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.round(t / MS_PER_DAY);
}

function isBusinessDay(day: number, holidays: Set<string>): boolean {
  if (weekdayOf(day) === FRIDAY) return false;
  // Skip the string work entirely when no holidays were supplied — the common case.
  return holidays.size === 0 || !holidays.has(isoOfDay(day));
}

/** Overlap of [start, end] with this day's 09:00–18:00 window, in ms. */
function dayOverlap(day: number, start: number, end: number, holidays: Set<string>): number {
  if (!isBusinessDay(day, holidays)) return 0;
  const base = day * MS_PER_DAY;
  const from = Math.max(start, base + OPEN_MS);
  const to = Math.min(end, base + CLOSE_MS);
  return to > from ? to - from : 0;
}

/** How many days in [a, b] fall on weekday `w`, without visiting them. */
function countWeekday(a: number, b: number, w: number): number {
  const r = (((w - 4) % 7) + 7) % 7;          // day numbers with this weekday are ≡ r (mod 7)
  return Math.floor((b - r) / 7) - Math.floor((a - 1 - r) / 7);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Business milliseconds elapsed between two instants.
 *
 * Only time inside 09:00–18:00 Gulf on a Saturday–Thursday that is not a listed
 * holiday counts. Nothing is clamped explicitly: summing each day's overlap
 * already makes an early arrival count from 09:00, and an instant after 18:00,
 * on a Friday or on a holiday count from 09:00 on the next business day.
 *
 * @param holidays Gulf calendar dates as 'YYYY-MM-DD'; any iterable, read once.
 */
export function businessMsBetween(startMs: number, endMs: number, holidays?: Iterable<string>): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  if (endMs <= startMs) return 0;

  const holidaySet = new Set(holidays ?? []);
  const start = startMs + GULF_OFFSET_MS;
  const end = endMs + GULF_OFFSET_MS;

  const firstDay = gulfDayOf(start);
  const lastDay = gulfDayOf(end);
  if (firstDay === lastDay) return dayOverlap(firstDay, start, end, holidaySet);

  // The end days are partial; everything between them is a whole window or nothing.
  let total = dayOverlap(firstDay, start, end, holidaySet)
            + dayOverlap(lastDay, start, end, holidaySet);

  const a = firstDay + 1;
  const b = lastDay - 1;
  if (b < a) return Math.max(0, total);

  const days = b - a + 1;
  if (days <= LOOP_DAY_LIMIT) {
    for (let d = a; d <= b; d++) {
      if (isBusinessDay(d, holidaySet)) total += BUSINESS_MS_PER_DAY;
    }
    return Math.max(0, total);
  }

  // Long span: every day except Friday is a business day, less the listed holidays.
  let businessDays = days - countWeekday(a, b, FRIDAY);
  for (const iso of holidaySet) {
    const d = dayOfIso(iso);
    if (d === null || d < a || d > b) continue;
    if (weekdayOf(d) === FRIDAY) continue;    // already excluded as the weekend
    businessDays--;
  }
  return Math.max(0, total + businessDays * BUSINESS_MS_PER_DAY);
}

/** Convert a count of business hours into the unit the KPI engine compares against. */
export function businessHours(n: number): number {
  return n * 3600_000;
}
