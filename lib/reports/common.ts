/**
 * Small helpers the EVHUB report modules share.
 *
 * Every report reads Odoo the same way — company ids per branch, many2one
 * pairs, UTC strings that must be read as Gulf days — so the conventions live
 * here once and the reports stay about their own question.
 */

import type { Branch } from '../types';
import { call, BRANCH_CLUSTERS, getCompanyIds, companyIdFor, OdooDomain } from '../odoo';
import { odooTime } from '../kpi';

export { odooTime };

export type Rec = Record<string, unknown>;

// ── Companies ──────────────────────────────────────────────────────

/**
 * Odoo company id → the branch it rolls up to, plus the configured company
 * name as the site label. Names that do not resolve are skipped rather than
 * thrown on: a renamed company should cost its own rows, not the report.
 * A company listed under two branches keeps the first — BRANCH_CLUSTERS order
 * is the tie-break the rest of the app already uses.
 */
export async function companyIndex(): Promise<Map<number, { branch: Branch; site: string }>> {
  const map = await getCompanyIds();
  const out = new Map<number, { branch: Branch; site: string }>();
  for (const [branch, names] of Object.entries(BRANCH_CLUSTERS) as [Branch, string[]][]) {
    for (const site of names) {
      const id = companyIdFor(map, site);
      if (id && !out.has(id)) out.set(id, { branch, site });
    }
  }
  return out;
}

/** Odoo company ids for a set of branches, for a `company_id in` clause. */
export async function companyIdsFor(branches: readonly Branch[]): Promise<number[]> {
  const index = await companyIndex();
  const want = new Set<Branch>(branches);
  return [...index.entries()].filter(([, v]) => want.has(v.branch)).map(([id]) => id);
}

/**
 * One note line for records dropped because their company is not one of ours.
 * Silently discarding them would make a total look complete when it is not, so
 * the reader is told how many went and where they came from, biggest first.
 * `what` is the plural noun, e.g. 'purchase orders'.
 */
export function unknownCompanyNote(counts: Map<string, number>, what: string): string | null {
  const entries = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return null;
  const total = entries.reduce((s, [, n]) => s + n, 0);
  return `Skipped ${total} ${what} on companies no branch tracks: ${entries.map(([name, n]) => `${name} (${n})`).join(', ')}.`;
}

// ── Field values ───────────────────────────────────────────────────

/** A many2one as Odoo returns it ([id, name]), or null for false/empty. */
export function m2o(v: unknown): [number, string] | null {
  if (!Array.isArray(v) || v.length < 2 || typeof v[0] !== 'number') return null;
  return [v[0], String(v[1] ?? '')];
}

/** The display name of a many2one, '' when unset — safe to drop into a cell. */
export function m2oName(v: unknown): string {
  return m2o(v)?.[1] ?? '';
}

/**
 * purchase.order dates are datetimes on some versions and plain dates on others.
 * A plain date has no time to convert, so it is read as midnight UTC rather
 * than shifted — the same reading the KPI engine uses, so the two never differ.
 */
export function poTime(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > 10) return odooTime(raw);
  const t = Date.parse(`${raw}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

// ── Time ───────────────────────────────────────────────────────────

/** Gulf time is UTC+4 all year — no DST — so a fixed offset is exact. */
const GULF_OFFSET_MS = 4 * 3600 * 1000;
const DAY_MS = 86400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Epoch ms → 'YYYY-MM-DD HH:MM:SS' UTC, the form Odoo domains compare against. */
export function toOdooUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** The Gulf calendar day of an instant — what a branch would call "that day". */
export function gulfDate(ms: number): string {
  return new Date(ms + GULF_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Gulf calendar month of an instant, 'YYYY-MM' — sorts as text. */
export function gulfMonthKey(ms: number): string {
  return gulfDate(ms).slice(0, 7);
}

/** 'YYYY-MM' → 'Nov 25'. Returns the key unchanged if it is not one. */
export function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${m[1].slice(2)}` : key;
}

/** Elapsed days, one decimal — the precision every days column displays. */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.round(((toMs - fromMs) / DAY_MS) * 10) / 10;
}

// ── Stats & formatting ─────────────────────────────────────────────

/** Median, not mean, for lead times: one PO stuck for months should not move the headline. */
export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** '3.2 days' / '1 day' / '—' when there is nothing to measure. */
export function fmtDays(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const r = Math.round(n * 10) / 10;
  return r === 1 ? '1 day' : `${r} days`;
}

/** Whole-number share, '—' when the base is empty so 0/0 never reads as 0%. */
export function fmtPct(part: number, whole: number): string {
  if (!whole || !Number.isFinite(part / whole)) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

// ── Odoo reads ─────────────────────────────────────────────────────

/** search_read with limit 0 (no cap): a report that silently stops at a page size would understate every total. */
export async function searchReadAll(model: string, domain: OdooDomain, fields: string[], order?: string): Promise<Rec[]> {
  const kwargs: Record<string, unknown> = { fields, limit: 0 };
  if (order) kwargs.order = order;
  return (await call(model, 'search_read', [domain], kwargs)) as Rec[];
}

/** Split ids so one request never carries thousands of ids in a single payload. */
export function idChunks(ids: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** `read` in chunks, concatenated in order. */
export async function readChunked(model: string, ids: number[], fields: string[], chunk = 2000): Promise<Rec[]> {
  const out: Rec[] = [];
  for (const part of idChunks(ids, chunk)) {
    out.push(...((await call(model, 'read', [part], { fields })) as Rec[]));
  }
  return out;
}
