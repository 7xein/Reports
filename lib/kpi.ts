/**
 * KPI engine — computes the Company → Branch → Service Advisor tree from live Odoo data.
 *
 * Approach: each KPI produces a flat list of Evaluations
 * ({ kpiId, branch, user, compliant, ref }). One aggregator then rolls that list
 * up at any level, so SA / branch / company numbers all come from the same source
 * and can never disagree.
 *
 * That holds because every level is a filter of the same list and each one is a
 * subset of the level above it: the company figure is every evaluation, a branch
 * is the evaluations booked to that company, and a person's card under that
 * branch is their share of exactly those — not their work elsewhere. Until the
 * attribution fix a person's cells were all of their work in any branch, so the
 * sentence above was false of the SA level and the two could differ by the
 * entire population of a KPI. Work booked to a branch the person is not
 * rostered in therefore reaches no card, which is disclosed in a note rather
 * than dropped in silence.
 *
 * ── Who a verdict belongs to ──
 *
 * Every evaluation names the person who PERFORMED the action its KPI measures,
 * not the person who happens to have opened the job card. The two are different
 * people for most of these KPIs — a late invoice is the invoicer's miss, not the
 * advisor's — and `push()` charging `rec.create_uid` is why the invoicing KPIs
 * never reached whoever invoices. Each KPI block now states its performer; where
 * it genuinely cannot know, it says so rather than letting the default stand.
 *
 * Whose CARD a KPI appears on is a separate question, answered by ownership
 * derived from Odoo activity (`config.kpiOwners`, populated by the refresh and
 * only read here). No role and no section label is involved: a label can
 * contradict what somebody actually does, and then somebody has to arbitrate it.
 *
 * One consequence for the reconciliation promised above: a verdict with NO
 * performer — the action never happened at all — is shared across that KPI's
 * owners in the branch, so each of them carries it. The person level is then no
 * longer a strict partition of the branch level: that one event is counted once
 * for the branch and once for each owner. It is the only case where several
 * people are marked down for one event, which is why every instance of it is
 * disclosed in a note.
 *
 * Weekly window: Saturday 00:00 → Friday 23:59 Gulf time (UTC+4).
 */

import {
  KPI_BRANCHES, Branch, KPI_DEFINITIONS, KpiConfig, StageSelector, SNAPSHOT_KPI_IDS, EXCLUDED_FROM_OVERALL, kpiDisplayName,
  KpiWeekSummary, KpiSection, KPI_SECTION_ORDER, KPI_IDS_FOR_EVERYONE, sectionOf, resolveAgeField, DEFAULT_KPI_CONFIG,
  rosterBranches, rosterRoles, rolesForKpi, KpiRole, KPI_ROLE_ORDER,
  ownersFor, ownsKpi, KPI_OWNER_FLOOR, KPI_OWNER_WINDOW_DAYS,
} from './types';
import { call, kpiCompanyIds, mainCompanyIdFor, OdooDomain, notHistorical, HISTORICAL_FIELD, isHistorical } from './odoo';
import { businessMsBetween, businessHours } from './business-hours';

// ── Week helpers ───────────────────────────────────────────────────
const GULF_OFFSET_MS = 4 * 3600 * 1000;

/** "Now" shifted into Gulf time so UTC getters read as local Gulf values. */
function gulfNow(): Date {
  return new Date(Date.now() + GULF_OFFSET_MS);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Saturday starting the week that contains `iso` (or the current week). */
export function weekStartFor(iso?: string, weekStartDay = 6): string {
  const base = iso ? new Date(`${iso}T00:00:00Z`) : gulfNow();
  const day = base.getUTCDay();                       // 0=Sun … 6=Sat
  const back = (day - weekStartDay + 7) % 7;          // days since the week start
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Gulf calendar date → Odoo UTC datetime string. */
function gulfToUtc(iso: string, endOfDay = false): string {
  const d = new Date(`${iso}T${endOfDay ? '23:59:59' : '00:00:00'}+04:00`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Parse an Odoo UTC datetime ('YYYY-MM-DD HH:MM:SS') to epoch ms. */
export function odooTime(raw: unknown): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const t = Date.parse(raw.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : t;
}

// ── Result shapes ──────────────────────────────────────────────────
export interface KpiCell {
  id: number;
  name: string;
  compliant: number;
  applicable: number;
  pct: number | null;        // null = N/A (nothing applicable)
  snapshot: boolean;         // true = point-in-time KPI (ignores the week window)
  section: KpiSection;       // resolved against the admin override, not the default
  note?: string;             // extra context shown in the ⓘ tooltip
  violations: string[];      // capped at 50
}

export interface SaNode {
  odooUserId: number;
  name: string;
  /**
   * Legacy, and no longer a grouping: the page lays rows and people out by role
   * now. Kept because it still feeds `sections` below, and through it the 14
   * weeks of stored history, whose per-week averages are filed under the two
   * section keys. Roster entries saved without a section still read as advisors.
   */
  section: KpiSection;
  /**
   * What this person is scored as — the roster entry's roles, or its legacy
   * section mapped through ROLES_FROM_SECTION. Shown beside the name, because a
   * flat people list is the only honest one once a person can hold several roles
   * and grouping by role would list them twice.
   */
  roles: KpiRole[];
  achievement: number | null;
  sections: Record<KpiSection, number | null>;
  roleAverages: Record<KpiRole, number | null>;
  roCount: number;
  kpis: KpiCell[];
}

export interface BranchNode {
  name: string;
  achievement: number | null;
  sections: Record<KpiSection, number | null>;
  roleAverages: Record<KpiRole, number | null>;
  applicableTotal: number;
  kpis: KpiCell[];
  serviceAdvisors: SaNode[];
}

export interface KpiTree {
  week: { start: string; end: string };
  generatedAt: string;
  company: {
    achievement: number | null;
    sections: Record<KpiSection, number | null>;
    roleAverages: Record<KpiRole, number | null>;
    kpis: KpiCell[];
  };
  branches: BranchNode[];
  notes: string[];
}

interface Evaluation {
  kpiId: number;
  branch: Branch;
  userId: number | null;
  userName: string;
  compliant: boolean;
  ref: string;
}

/** Who an evaluation names when the action it judges was never performed. */
const NO_PERFORMER = { id: null as number | null, name: 'No performer recorded' };

/**
 * KPIs that are branch readings and must reach no individual card at all.
 *
 * 7 (Awaiting labour) and 9 (Weekly closure rate) measure a state of the branch,
 * not an action anybody took: nobody "does" a closure rate. They therefore have
 * no performer AND no owner, so rule 3's sharing is switched off for them
 * explicitly rather than left to depend on the refresh happening to find them no
 * owners. If a future refresh ever did name one, these two would otherwise start
 * marking people down for the branch's backlog.
 */
const BRANCH_ONLY_KPI_IDS: readonly number[] = [7, 9];

// ── Aggregation ────────────────────────────────────────────────────
const VIOLATION_CAP = 50;

function aggregate(
  evals: Evaluation[],
  enabled: number[],
  snapshotNotes?: Record<number, string>,
  names?: Record<number, string>,
  sections?: Record<number, KpiSection>,
): KpiCell[] {
  return KPI_DEFINITIONS.filter((d) => enabled.includes(d.id)).map((d) => {
    const mine = evals.filter((e) => e.kpiId === d.id);
    const compliant = mine.filter((e) => e.compliant).length;
    const applicable = mine.length;
    const snapshot = SNAPSHOT_KPI_IDS.includes(d.id);
    return {
      id: d.id,
      name: names?.[d.id] ?? d.name,
      section: sections?.[d.id] ?? sectionOf(d.id),
      compliant,
      applicable,
      pct: applicable > 0 ? Math.min((compliant / applicable) * 100, 100) : null,
      snapshot,
      ...(snapshotNotes?.[d.id] ? { note: snapshotNotes[d.id] } : {}),
      violations: mine.filter((e) => !e.compliant).map((e) => e.ref).slice(0, VIOLATION_CAP),
    };
  });
}

/**
 * Which KPIs an achievement average counts. The overall and the per-section
 * figures must share this one rule — if they ever disagree about what counts,
 * the sections stop reconciling with the total they sit under.
 */
const countsTowardOverall = (c: KpiCell) => c.pct !== null && !EXCLUDED_FROM_OVERALL.includes(c.id);

const meanPct = (cells: KpiCell[]): number | null =>
  cells.length ? cells.reduce((s, c) => s + (c.pct as number), 0) / cells.length : null;

/** Overall achievement = mean of the KPI percentages that have applicable records. */
function overall(cells: KpiCell[]): number | null {
  // Every level — advisor, branch, company — averages here, and the weekly
  // history copies these values, so excluding a KPI once excludes it everywhere.
  return meanPct(cells.filter(countsTowardOverall));
}

/** Per-section achievement, using the same inclusion rule as the overall. */
function sectionTotals(cells: KpiCell[], config: KpiConfig): Record<KpiSection, number | null> {
  // KPI_IDS_FOR_EVERYONE is kept out of the section averages and stays in the
  // overall, where it belongs. 17 (Chatter response) is the only one, it sits in
  // the workshop section by default, and on a card whose other cells are all
  // advisor KPIs it was the whole workshop average — so one missed @mention
  // rendered a full "WORKSHOP 0%" header off a single KPI no section owns.
  // A KPI every role answers for is the card's, not a section's.
  const scored = cells.filter((c) => countsTowardOverall(c) && !KPI_IDS_FOR_EVERYONE.includes(c.id));
  // Deliberately NOT what `overall` averages: the overall is the mean of every
  // scored KPI, not the mean of these two — sections with unequal KPI counts
  // would otherwise reweight the headline figure.
  return Object.fromEntries(
    KPI_SECTION_ORDER.map((s) => [s, meanPct(scored.filter((c) => sectionOf(c.id, config) === s))]),
  ) as Record<KpiSection, number | null>;
}

/**
 * Per-role achievement — the figure each role heading on the page carries.
 *
 * Deliberately a mirror of sectionTotals: same inclusion rule, same exclusion of
 * KPI_IDS_FOR_EVERYONE, same per-level call sites. The two must agree about what
 * counts, because they are the same arithmetic over a different partition of the
 * same cells, and a reader comparing a role figure against the overall above it
 * is entitled to one rule rather than two.
 *
 * Computed live and never stored: a stored week files its averages under the two
 * section keys, and KpiWeekSummary is not being changed for this, so 14 weeks of
 * week-on-week comparisons keep working. The per-role figure therefore has no
 * history until new weeks accumulate, which is the trade the owner accepted.
 *
 * `config` is taken for symmetry with sectionTotals and is deliberately unused:
 * role ownership comes from ROLE_KPIS, which Admin does not override the way it
 * overrides a KPI's section. Taking it keeps every call site reading alike, so
 * the day a role override does exist there is one signature to change.
 */
function roleTotals(cells: KpiCell[], _config?: KpiConfig): Record<KpiRole, number | null> {
  // Same two filters as sectionTotals, for the same reasons: an unmeasured KPI
  // and KPI 9 are out of every average, and a KPI everybody answers for (17)
  // forms no group average of its own — it is the card's, not a role's.
  const scored = cells.filter((c) => countsTowardOverall(c) && !KPI_IDS_FOR_EVERYONE.includes(c.id));
  return Object.fromEntries(
    KPI_ROLE_ORDER.map((r) => [r, meanPct(scored.filter((c) => rolesForKpi(c.id).includes(r)))]),
  ) as Record<KpiRole, number | null>;
}

// ── Odoo domain from a configured selector ─────────────────────────
function selectorDomain(sel: StageSelector): OdooDomain {
  if (!sel || !sel.values?.length) return [['id', '=', 0]]; // unmapped → matches nothing
  if (sel.kind === 'state') return [['state', 'in', sel.values]];
  if (sel.kind === 'repairState') return [['repair_state', 'in', sel.values]];
  if (sel.kind === 'stage') return [['stage_id', 'in', sel.values]];
  if (sel.kind === 'tag')   return [['tag_ids', 'in', sel.values]];
  return [['priority_matrix_status', 'in', sel.values]];
}

/** Inverse of selectorDomain — e.g. "not closed" = every open RO. */
export function selectorDomainNot(sel: StageSelector): OdooDomain {
  if (!sel || !sel.values?.length) return []; // nothing marked closed → everything is open
  if (sel.kind === 'state') return [['state', 'not in', sel.values]];
  if (sel.kind === 'repairState') return [['repair_state', 'not in', sel.values]];
  if (sel.kind === 'stage') return [['stage_id', 'not in', sel.values]];
  if (sel.kind === 'tag')   return [['tag_ids', 'not in', sel.values]];
  return [['priority_matrix_status', 'not in', sel.values]];
}


/**
 * When each invoice was actually posted. Preferred source is the account.move
 * chatter (exact timestamp); falls back to invoice_date for moves whose posting
 * wasn't tracked. Unposted moves are omitted.
 *
 * `failed` separates "this move is not posted yet" from "we could not find out".
 * The caller reads a missing entry as still-uninvoiced and eventually overdue, so
 * without the flag one failed RPC would report every repaired vehicle as never
 * invoiced and fine the whole branch for it.
 *
 * `dayOnly` lists the moves whose only stamp was invoice_date — a date, not a
 * datetime. Parsed at midnight UTC that is 04:00 Gulf, five hours before the
 * working day opens, so an invoice genuinely posted days late but dated the
 * repair day landed BEFORE the Repaired stamp and passed unconditionally. A
 * date-only stamp cannot time a one-business-hour limit either way, so the
 * caller leaves those jobs unjudged instead of counting them compliant.
 */
async function invoicePostedTimes(moveIds: number[]): Promise<{ posted: Record<number, number>; dayOnly: Set<number>; failed: boolean }> {
  if (!moveIds.length) return { posted: {}, dayOnly: new Set(), failed: false };
  const out: Record<number, number> = {};
  const dayOnly = new Set<number>();
  try {
    const mm = (await call('account.move', 'fields_get', [], { attributes: ['selection'] })) as FieldsMeta;
    const postedLabel = (mm.state?.selection ?? []).find(([v]) => v === 'posted')?.[1];
    if (postedLabel) {
      // Only the timestamps are taken: who POSTED the invoice is deliberately not
      // read from here. KPIs 1 and 11 charge `account.move.create_uid` instead —
      // on this instance the creator and the poster are the same person on all
      // but 1–5% of invoices, and a second chatter read to close that gap would
      // cost more than it buys.
      Object.assign(out, (await trackedTransitions('account.move', [
        ['model', '=', 'account.move'],
        ['res_id', 'in', moveIds],
        ['tracking_value_ids', '!=', false],
      ], 'state', [postedLabel])).at);
    }
  } catch { /* chatter unavailable — the read below covers every move instead, so this alone is not a failure */ }

  const missing = moveIds.filter((id) => out[id] == null);
  let failed = false;
  if (missing.length) {
    try {
      const moves = (await call('account.move', 'read', [missing], {
        fields: ['invoice_date', 'create_date', 'state'],
      })) as Rec[];
      for (const m of moves) {
        if (m.state !== 'posted') continue;
        const d = typeof m.invoice_date === 'string' ? Date.parse(`${m.invoice_date}T00:00:00Z`) : NaN;
        const t = Number.isNaN(d) ? odooTime(m.create_date) : d;
        if (t == null) continue;
        out[m.id as number] = t;
        // Flagged, not discarded: a day is still enough to rule out an invoice
        // dated well before the repair as the quotation-time deposit it is. It
        // is only within the repair day itself that a date says nothing.
        if (!Number.isNaN(d)) dayOnly.add(m.id as number);
      }
    } catch {
      // This read is the only thing that can tell an unposted move from an
      // unreadable one, so losing it makes every move it covered unknowable.
      failed = true;
    }
  }
  return { posted: out, dayOnly, failed };
}

/**
 * RO id → when the invoice that bills the repair was posted.
 *
 * Two link shapes exist depending on the Odoo version: a direct invoice_id on the
 * repair order, and the sale order's invoice_ids. Both are followed.
 *
 * It used to be the EARLIEST posted invoice on the job, flat. Odoo posts a
 * down-payment invoice at quotation time, so on any job that took a deposit the
 * earliest invoice predates the Repaired stamp, the interval goes negative,
 * businessMsBetween clamps it to zero and the job reads compliant forever —
 * whenever the real closing invoice was actually posted.
 *
 * The rule now: among the job's posted invoices, the earliest posted at or after
 * `repairedAt − graceMs`. Earlier than that is a deposit, not the invoice that
 * bills the repair. The grace is wall-clock, not business time, and it is what
 * stops the fix creating its own injustice: an advisor who invoices at 15:00 and
 * marks the car Repaired at 15:05 did invoice it, and without a grace would read
 * as never having done so.
 *
 * `failed` means the lookup itself broke, not that nothing was invoiced — see
 * invoicePostedTimes. A failed lookup leaves KPIs 1 and 11 unjudged rather than
 * scoring every repaired RO as uninvoiced.
 *
 * `depositOnly` counts the jobs whose only posted invoices predate that cutoff:
 * they are not yet invoiced and go through the caller's tri-state. `dayOnly`
 * names the jobs whose billing invoice carries a date but no time, which cannot
 * be timed at all — the caller leaves those unjudged.
 *
 * `creators` is who raised that billing invoice — the person KPIs 1 and 11 are
 * about. Without it both KPIs charged the repair order's creator, i.e. the
 * advisor who opened the job card, which is why "the invoice was late" never
 * once reached the people who actually invoice. One bulk read of the chosen
 * invoices, not one per job.
 */
async function invoiceTimesForRos(
  ros: Rec[],
  repairedAt: Record<number, number>,
  graceMs: number,
): Promise<{
  times: Record<number, number>;
  failed: boolean;
  depositOnly: number;
  dayOnly: Set<number>;
  creators: Record<number, { id: number; name: string }>;
}> {
  const roMoves: Record<number, number[]> = {};
  for (const r of ros) {
    const direct = m2o(r.invoice_id)?.[0];
    if (direct != null) roMoves[r.id as number] = [direct];
  }

  const soIds = [...new Set(ros.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))];
  const soToMoves: Record<number, number[]> = {};
  let soFailed = false;
  if (soIds.length) {
    try {
      const sos = (await call('sale.order', 'read', [soIds], { fields: ['invoice_ids'] })) as { id: number; invoice_ids?: number[] }[];
      for (const so of sos) soToMoves[so.id] = so.invoice_ids ?? [];
    } catch {
      // On this instance the sale order carries the closing invoice, so losing
      // this read hides most invoices outright — "no invoice found" would then
      // mean nothing more than "we did not look".
      soFailed = true;
    }
  }
  for (const r of ros) {
    const soId = m2o(r.sale_order_id)?.[0];
    if (soId == null) continue;
    const ids = new Set([...(roMoves[r.id as number] ?? []), ...(soToMoves[soId] ?? [])]);
    if (ids.size) roMoves[r.id as number] = [...ids];
  }

  const { posted, dayOnly: dayOnlyMoves, failed } = await invoicePostedTimes([...new Set(Object.values(roMoves).flat())]);
  const out: Record<number, number> = {};
  const dayOnly = new Set<number>();
  /** RO id → the invoice chosen as the billing one, so its raiser can be read. */
  const billingMove: Record<number, number> = {};
  let depositOnly = 0;
  for (const [key, moves] of Object.entries(roMoves)) {
    const roId = Number(key);
    const stamps = moves
      .map((id) => ({ id, t: posted[id] }))
      .filter((s): s is { id: number; t: number } => s.t != null)
      .sort((a, b) => a.t - b.t);
    if (!stamps.length) continue;             // nothing posted on this job yet
    const rep = repairedAt[roId];
    if (rep == null) {
      // No Repaired moment, so there is no cutoff to apply and nothing to
      // measure from either — the caller skips this job. The earliest stamp
      // stands in so a deposit is never counted against a job nobody judges.
      out[roId] = stamps[0].t;
      continue;
    }
    const cutoff = rep - graceMs;
    const billing = stamps.find((s) => {
      // A date-only stamp names a day, not a moment, and a day is only enough to
      // rule an invoice out as a deposit when the WHOLE of that Gulf day is
      // already behind the cutoff. One dated the repair day itself could be
      // either the morning's deposit or the afternoon's closing invoice: it
      // qualifies here and is then refused as not measurable below. Ordering
      // matters — testing `t >= cutoff` on it instead would read every date-only
      // invoice dated the repair day as a deposit, which fines the job for an
      // invoice that may well have been posted on time.
      if (dayOnlyMoves.has(s.id)) return s.t + GULF_DAY_END_AFTER_UTC_MIDNIGHT > cutoff;
      return s.t >= cutoff;
    });
    if (!billing) { depositOnly++; continue; } // deposits only → not yet invoiced
    if (dayOnlyMoves.has(billing.id)) { dayOnly.add(roId); continue; }
    out[roId] = billing.t;
    billingMove[roId] = billing.id;
  }

  // Who raised each billing invoice. One read of the invoices actually chosen —
  // not of every invoice on every job — so the performer costs a single bulk call
  // however many repair orders are in the week. A failed read simply leaves the
  // performer unknown, which the caller handles; it never falls back to the job
  // card's creator, because that is the misattribution being removed.
  const creators: Record<number, { id: number; name: string }> = {};
  const moveIds = [...new Set(Object.values(billingMove))];
  if (moveIds.length) {
    try {
      const rows = (await call('account.move', 'read', [moveIds], { fields: ['create_uid'] })) as Rec[];
      const byMove = new Map<number, { id: number; name: string }>();
      for (const m of rows) {
        const u = m2o(m.create_uid);
        if (u) byMove.set(m.id as number, { id: u[0], name: u[1] });
      }
      for (const [key, mid] of Object.entries(billingMove)) {
        const who = byMove.get(mid);
        if (who) creators[Number(key)] = who;
      }
    } catch { /* performer unknown — never guessed at */ }
  }
  return { times: out, failed: soFailed || failed, depositOnly, dayOnly, creators };
}

// ── Engine ─────────────────────────────────────────────────────────
type Rec = Record<string, unknown>;
export type FieldsMeta = Record<string, { type?: string; relation?: string; selection?: [string, string][] }>;

/**
 * Partner ids in the order they actually appear in a chatter message.
 *
 * partner_ids is a many2many, so Odoo returns it in the comodel's sort order,
 * not the order they were typed. Who was mentioned FIRST decides who carries an
 * unanswered request, so that order is recovered from the message body, where
 * each mention is an anchor carrying the partner id.
 */
function mentionOrder(body: unknown, recipients: number[]): number[] {
  const ordered: number[] = [];
  if (typeof body === 'string' && recipients.length > 1) {
    const re = /data-oe-model="res\.partner"[^>]*?data-oe-id="(\d+)"|data-oe-id="(\d+)"[^>]*?data-oe-model="res\.partner"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const id = Number(m[1] ?? m[2]);
      if (Number.isFinite(id) && recipients.includes(id) && !ordered.includes(id)) ordered.push(id);
    }
  }
  // Anyone the body did not reveal keeps their original position, at the back.
  for (const r of recipients) if (!ordered.includes(r)) ordered.push(r);
  return ordered;
}

/** Matches tag names like "CAR-IN", "CAR IN", "CAR OUT", "car_out". */
const PRESENCE_TAG_RE = /car\s*[-_]?\s*(in|out)\b/i;

/** Matches tag names like "Insurance", "INSURANCE JOB", "insured". */
const INSURANCE_TAG_RE = /insur/i;

/** Every many2many tag field on repair.order, in the order we search them. */
export const TAG_FIELDS = ['tag_ids', 'x_studio_stages_tags'] as const;

/** One entry per tag field that exists, holding the ids matching in ITS comodel. */
type TagMatch = { field: string; ids: Set<number> };

/**
 * Locate the parts-lines relation on repair.order and the demand/done quantity
 * fields on its comodel. Field names vary by Odoo version and customisation, so
 * everything is discovered rather than assumed.
 */
export async function resolvePartsFields(
  meta: FieldsMeta,
): Promise<{ lineField: string; model: string; demand: string; done: string } | null> {
  const candidates = ['move_ids', 'operations', 'repair_line_ids', 'move_ids_without_package', 'part_ids']
    .filter((f) => meta[f]?.relation && (meta[f]?.type === 'one2many' || meta[f]?.type === 'many2many'));
  // Prefer the stock.move relation — that's where Demand/Done live.
  const lineField = candidates.find((f) => meta[f]?.relation === 'stock.move') ?? candidates[0];
  const model = lineField ? meta[lineField]?.relation : undefined;
  if (!lineField || !model) return null;
  try {
    const lm = (await call(model, 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
    const hasField = (f: string) => Object.prototype.hasOwnProperty.call(lm, f);
    // Confirmed on this instance: stock.move.product_uom_qty = Demand,
    // stock.move.quantity = Done. Older Odoo used quantity_done.
    const demand = ['product_uom_qty', 'product_qty', 'demand_qty'].find(hasField);
    const done = ['quantity', 'quantity_done', 'qty_done', 'done_qty'].find(hasField);
    if (!demand || !done) return null;
    return { lineField, model, demand, done };
  } catch {
    return null;
  }
}

/**
 * Read parts lines in chunks → { lineId: { short, since } } where `short` means
 * the Done quantity hasn't caught up with Demand, and `since` is when the part
 * was requested.
 */
export async function readPartsLines(
  parts: { model: string; demand: string; done: string },
  lineIds: number[],
): Promise<Record<number, { short: boolean; since: number | null }>> {
  const out: Record<number, { short: boolean; since: number | null }> = {};
  const CHUNK = 4000;
  for (let i = 0; i < lineIds.length; i += CHUNK) {
    try {
      const lines = (await call(parts.model, 'read', [lineIds.slice(i, i + CHUNK)], {
        fields: [parts.demand, parts.done, 'create_date'],
      })) as Rec[];
      for (const l of lines) {
        const demand = Number(l[parts.demand] ?? 0);
        const done = Number(l[parts.done] ?? 0);
        out[l.id as number] = { short: demand > 0 && done < demand, since: odooTime(l.create_date) };
      }
    } catch { /* skip unreadable chunk */ }
  }
  return out;
}

/**
 * Tag ids that mark a vehicle in/out. Uses the configured ids when set, otherwise
 * auto-detects tags named like CAR-IN / CAR-OUT so the KPI works out of the box.
 */
/**
 * Find the tags matching `re` across every tag field on repair.order.
 *
 * The two fields can point at different comodels, so an id from one means
 * nothing in the other — matches are resolved per comodel and kept per field.
 * Explicit ids picked in Admin come from the tag_ids list, so they apply to that
 * comodel and override name matching there; any other comodel still matches by
 * name, since the admin has no way to pick from it.
 */
export async function resolveTagMatches(
  configured: (string | number)[],
  meta: FieldsMeta,
  re: RegExp,
): Promise<TagMatch[]> {
  const fields = TAG_FIELDS.filter((f) => meta[f]?.relation);
  if (!fields.length) return [];
  const explicit = (configured ?? []).map(Number).filter((n) => Number.isFinite(n));
  const primaryRelation = meta.tag_ids?.relation;

  const byRelation = new Map<string, Set<number>>();
  for (const f of fields) {
    const relation = meta[f]!.relation!;
    if (byRelation.has(relation)) continue;

    // Explicit picks replace name matching, but only in the comodel they came from.
    if (explicit.length && relation === primaryRelation) {
      byRelation.set(relation, new Set(explicit));
      continue;
    }
    const ids = new Set<number>();
    try {
      const recs = (await call(relation, 'search_read', [[]], { fields: ['display_name'], limit: 500 })) as { id: number; display_name?: string }[];
      for (const t of recs) if (re.test(t.display_name || '')) ids.add(t.id);
    } catch { /* comodel unreadable — that field simply matches nothing */ }
    byRelation.set(relation, ids);
  }

  return fields.map((f) => ({ field: f, ids: byRelation.get(meta[f]!.relation!) ?? new Set<number>() }));
}

/** An Odoo domain matching a record that carries any of these tags, in any field. */
export function anyTagDomain(matches: TagMatch[]): OdooDomain {
  const live = matches.filter((m) => m.ids.size);
  if (!live.length) return [['id', '=', 0]];
  const clauses: OdooDomain = live.map((m) => [m.field, 'in', [...m.ids]] as [string, string, unknown]);
  // Odoo domains are prefix notation: n clauses need n-1 leading '|'.
  return [...Array(live.length - 1).fill('|'), ...clauses];
}

/** Does this record carry one of the matched tags in any of its tag fields? */
export function hasAnyTag(rec: Rec, matches: TagMatch[]): boolean {
  return matches.some((m) => ((rec[m.field] as number[] | undefined) ?? []).some((id) => m.ids.has(id)));
}
const m2o = (v: unknown): [number, string] | null => (Array.isArray(v) ? (v as [number, string]) : null);

/**
 * The tracked field + the human labels Odoo stores in its change log for a
 * configured selector. Only selection fields (state / priority matrix) are
 * resolvable this way; stage/tag mappings fall back to date proxies.
 */
/**
 * Turn a stage selector into the (field, labels) pair the chatter lookup needs.
 *
 * The chatter stores the human LABEL of whatever changed, so selection fields
 * map through their selection list and stage_id maps through stage names --
 * which is why stageNames has to be resolved before this is called.
 */
function trackedField(
  sel: StageSelector,
  meta: FieldsMeta,
  stageNames?: Record<number, string>,
): { field: string; labels: string[] } | null {
  if (sel.kind === 'stage') {
    if (!meta.stage_id || !stageNames) return null;
    const labels = sel.values
      .map((v) => stageNames[Number(v)])
      .filter((x): x is string => !!x);
    return labels.length ? { field: 'stage_id', labels } : null;
  }
  const field = sel.kind === 'state' ? 'state'
    : sel.kind === 'repairState' ? 'repair_state'
    : sel.kind === 'priority' ? 'priority_matrix_status'
    : null;
  if (!field) return null;
  const options = meta[field]?.selection ?? [];
  const labels = sel.values
    .map((v) => options.find(([code]) => code === String(v))?.[1])
    .filter((x): x is string => !!x);
  return labels.length ? { field, labels } : null;
}

/** Stage id → display name, read once per run and only when a selector needs it. */
async function resolveStageNames(config: KpiConfig, meta: FieldsMeta): Promise<Record<number, string>> {
  const usesStages = Object.values(config.stageMap).some((sel) => sel?.kind === 'stage' && sel.values.length);
  const relation = meta.stage_id?.relation;
  if (!usesStages || !relation) return {};
  const ids = [...new Set(
    Object.values(config.stageMap)
      .filter((sel) => sel?.kind === 'stage')
      .flatMap((sel) => sel.values.map(Number))
      .filter((n) => Number.isFinite(n)),
  )];
  if (!ids.length) return {};
  try {
    const recs = (await call(relation, 'read', [ids], { fields: ['display_name'] })) as { id: number; display_name?: string }[];
    const out: Record<number, string> = {};
    for (const r of recs) if (r.display_name) out[r.id] = r.display_name;
    return out;
  } catch {
    return {};
  }
}

/**
 * A set of tracked transitions: when each record arrived, and who moved it.
 *
 * Two parallel maps rather than one map of pairs, so that the callers which only
 * ever wanted the clock keep reading `at[id]` and nothing else. The author rides
 * along inside the query that was already being run for the timestamp — a KPI
 * whose performer is whoever made the transition therefore costs no extra Odoo
 * call, which is the whole reason it is captured here rather than looked up per
 * record afterwards.
 *
 * `by` holds a res.partner id (mail.message.author_id), not a user id. Resolving
 * it to a user is the caller's job, because only the caller knows whether an
 * unresolvable author means "unknown performer" or "not scored at all". It must
 * never be charged as a user id: partner ids and user ids are different
 * sequences, so doing that fines whichever unrelated person holds that number.
 */
type Transitions = {
  /** record id → epoch ms of the transition `pick` selected. */
  at: Record<number, number>;
  /** record id → res.partner that authored that same transition, null if unreadable. */
  by: Record<number, number | null>;
};

/** An empty result, built fresh each time so no caller can mutate a shared one. */
const noTransitions = (): Transitions => ({ at: {}, by: {} });

/**
 * When each RO actually entered the given state, read from Odoo's chatter/tracking
 * log (mail.message + mail.tracking.value). Returns roId → epoch ms of a
 * transition into one of `labels`, over all of history, plus the partner who
 * authored it. Returns empty maps if tracking isn't readable, so callers fall
 * back to a date proxy.
 *
 * `pick` is trackedTransitions'. It stays 'last' here because the callers that
 * do not state otherwise are the ones asking how long a car has been in the
 * state it is in now; anything measured FROM the arrival passes 'first'.
 */
async function stateEntryTimes(roIds: number[], field: string, labels: string[], pick: 'first' | 'last' = 'last'): Promise<Transitions> {
  if (!roIds.length || !labels.length) return noTransitions();
  return trackedTransitions('repair.order', [
    ['model', '=', 'repair.order'],
    ['res_id', 'in', roIds],
    ['tracking_value_ids', '!=', false],
  ], field, labels, pick);
}

/**
 * ROs that ENTERED one of `labels` at any point during [from, to) — regardless of
 * what state they're in now. This is what makes past weeks meaningful: an RO
 * repaired last week has since moved on, so filtering by current state finds
 * nothing.
 */
/**
 * Every tracked change of `field` per RO, ascending: [{ t, label, author }].
 *
 * trackedTransitions only answers "when did it arrive"; this answers "and when
 * did it leave", which is what a dwell-time KPI needs.
 *
 * `author` is the res.partner that posted the message carrying the change — the
 * person who moved the car — captured in the query that was already fetching the
 * date, so a KPI charged to whoever made the transition costs nothing extra.
 */
async function stateTimeline(roIds: number[], field: string): Promise<Record<number, { t: number; label: string; author: number | null }[]>> {
  if (!roIds.length) return {};
  try {
    const msgs = (await call('mail.message', 'search_read', [[
      ['model', '=', 'repair.order'],
      ['res_id', 'in', roIds],
      ['tracking_value_ids', '!=', false],
    ]], { fields: ['res_id', 'date', 'author_id', 'tracking_value_ids'], limit: 0 })) as Rec[];
    if (!msgs.length) return {};

    const tvIds = [...new Set(msgs.flatMap((m) => (m.tracking_value_ids as number[] | undefined) ?? []))];
    if (!tvIds.length) return {};

    // Same v17 / legacy split as trackedTransitions.
    const tvMeta = (await call('mail.tracking.value', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
    const useFieldId = Object.prototype.hasOwnProperty.call(tvMeta, 'field_id');
    let fieldId: number | null = null;
    if (useFieldId) {
      const fr = (await call('ir.model.fields', 'search_read', [[
        ['model', '=', 'repair.order'], ['name', '=', field],
      ]], { fields: ['id'], limit: 1 })) as { id: number }[];
      fieldId = fr[0]?.id ?? null;
    }
    const ref = useFieldId ? 'field_id' : 'field';
    const tvs = (await call('mail.tracking.value', 'read', [tvIds], { fields: [ref, 'new_value_char'] })) as Rec[];

    const labelOf = new Map<number, string>();
    for (const tv of tvs) {
      const val = tv.new_value_char;
      if (typeof val !== 'string') continue;
      if (useFieldId) { if (fieldId == null || m2o(tv[ref])?.[0] !== fieldId) continue; }
      else if (tv[ref] !== field) continue;
      labelOf.set(tv.id as number, val);
    }
    if (!labelOf.size) return {};

    const out: Record<number, { t: number; label: string; author: number | null }[]> = {};
    for (const m of msgs) {
      const t = odooTime(m.date);
      if (t == null) continue;
      const author = m2o(m.author_id)?.[0] ?? null;
      for (const id of (m.tracking_value_ids as number[] | undefined) ?? []) {
        const label = labelOf.get(id);
        if (!label) continue;
        (out[m.res_id as number] ??= []).push({ t, label, author });
      }
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.t - b.t);
    return out;
  } catch {
    return {};
  }
}

/**
 * The oldest change the chatter holds for a field — i.e. when tracking was
 * switched on.
 *
 * This matters because "no transition recorded" is ambiguous: it means the RO
 * never reached that stage, OR it reached it before anyone was writing the
 * history down. Judging the second case as a failure punishes work that was
 * done correctly, just unobserved.
 */
async function trackingStartedAt(model: string, field: string): Promise<number | null> {
  try {
    const tvMeta = (await call('mail.tracking.value', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
    const useFieldId = Object.prototype.hasOwnProperty.call(tvMeta, 'field_id');
    let domain: OdooDomain;
    if (useFieldId) {
      const fr = (await call('ir.model.fields', 'search_read', [[
        ['model', '=', model], ['name', '=', field],
      ]], { fields: ['id'], limit: 1 })) as { id: number }[];
      if (fr[0]?.id == null) return null;
      domain = [['field_id', '=', fr[0].id]];
    } else {
      domain = [['field', '=', field]];
    }
    const first = (await call('mail.tracking.value', 'search_read', [domain], {
      fields: ['create_date'], limit: 1, order: 'create_date asc',
    })) as Rec[];
    return odooTime(first[0]?.create_date);
  } catch {
    return null;
  }
}

async function roIdsEnteringStateInWindow(
  field: string, labels: string[], from: string, to: string,
): Promise<Transitions> {
  if (!labels.length) return noTransitions();
  // The EARLIEST qualifying arrival inside the window, not the latest. The
  // population here is "entered the state during the scoring week", so the week
  // it is being scored for is the week the clock has to start in: a car that
  // arrived on Saturday and again on Wednesday is measured from Saturday, which
  // is the arrival this week's figure is about. Transitions outside [from, to)
  // are not in the message domain at all, so no other week can reach in.
  return trackedTransitions('repair.order', [
    ['model', '=', 'repair.order'],
    ['date', '>=', from], ['date', '<', to],
    ['tracking_value_ids', '!=', false],
  ], field, labels, 'first');
}

/**
 * Shared chatter-log reader: message domain → { roId: epoch ms of transition }.
 *
 * `pick` decides which qualifying transition survives when a record entered the
 * same state more than once, and it is the difference between measuring a KPI
 * and laundering it:
 *
 *   • 'first' is for anything measured FROM entering a state. Keeping the most
 *     recent entry measured from the latest time a car arrived, so ordinary
 *     rework turned a real failure into a pass: a car bounced back to Inspection
 *     on Wednesday, with its quotation raised on Sunday, gave a negative
 *     interval, businessMsBetween clamps a negative interval to zero, and zero
 *     is inside every limit. A genuinely unquoted re-inspection could not fail.
 *   • 'last' is for "how long has it been sitting in the state it is in NOW" —
 *     KPIs 6 and 7. There the earliest arrival would age a car from a wait it
 *     has already finished and overstate every one of them.
 *
 * Nothing here defaults to 'first': the two readings are both correct for their
 * own question, so each caller states which question it is asking.
 *
 * The author of each message comes back alongside its date (see Transitions).
 * `author_id` is simply another field on a query that already runs, so every KPI
 * whose performer is "whoever moved it" is attributable for free; the previous
 * shape returned the clock and threw the person away, which is why those KPIs
 * had to fall back to the job card's creator.
 */
async function trackedTransitions(model: string, msgDomain: OdooDomain, field: string, labels: string[], pick: 'first' | 'last' = 'last'): Promise<Transitions> {
  try {
    const msgs = (await call('mail.message', 'search_read', [msgDomain], {
      fields: ['res_id', 'date', 'author_id', 'tracking_value_ids'], limit: 0,
    })) as Rec[];
    if (!msgs.length) return noTransitions();

    const tvIds = [...new Set(msgs.flatMap((m) => (m.tracking_value_ids as number[] | undefined) ?? []))];
    if (!tvIds.length) return noTransitions();

    // Odoo 17 links the changed field via field_id (m2o); older versions store the
    // technical name in `field`.
    const tvMeta = (await call('mail.tracking.value', 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
    const useFieldId = Object.prototype.hasOwnProperty.call(tvMeta, 'field_id');
    let fieldId: number | null = null;
    if (useFieldId) {
      const fr = (await call('ir.model.fields', 'search_read', [[
        ['model', '=', model], ['name', '=', field],
      ]], { fields: ['id'], limit: 1 })) as { id: number }[];
      fieldId = fr[0]?.id ?? null;
    }

    const ref = useFieldId ? 'field_id' : 'field';
    const tvs = (await call('mail.tracking.value', 'read', [tvIds], { fields: [ref, 'new_value_char'] })) as Rec[];

    // Tracking rows representing a transition INTO one of our target states.
    const hits = new Set<number>();
    for (const tv of tvs) {
      const val = tv.new_value_char;
      if (typeof val !== 'string' || !labels.includes(val)) continue;
      if (useFieldId) { if (fieldId == null || m2o(tv[ref])?.[0] !== fieldId) continue; }
      else if (tv[ref] !== field) continue;
      hits.add(tv.id as number);
    }
    if (!hits.size) return noTransitions();

    const at: Record<number, number> = {};
    const by: Record<number, number | null> = {};
    for (const m of msgs) {
      const ids = (m.tracking_value_ids as number[] | undefined) ?? [];
      if (!ids.some((id) => hits.has(id))) continue;
      const t = odooTime(m.date);
      const rid = m.res_id as number;
      if (t == null) continue;
      if (at[rid] == null || (pick === 'first' ? t < at[rid] : t > at[rid])) {
        at[rid] = t;
        // Taken from the message that carries the SURVIVING transition, so the
        // clock and the performer always describe the same event. Reading the
        // author off any other message would charge one person's verdict with
        // another person's timestamp.
        by[rid] = m2o(m.author_id)?.[0] ?? null;
      }
    }
    return { at, by };
  } catch {
    return noTransitions(); // tracking unavailable — caller falls back
  }
}

/**
 * fields_get for a model that may not exist on this instance — null when the
 * model is unreadable, so an uninstalled module costs its own KPIs and nothing
 * else.
 */
export async function readFieldsMeta(model: string): Promise<FieldsMeta | null> {
  try {
    return (await call(model, 'fields_get', [], { attributes: ['type', 'relation', 'selection'] })) as FieldsMeta;
  } catch {
    return null;
  }
}

/**
 * Grace after an RO is marked Repaired before Customer follow-up (KPI 13) judges
 * it. Calendar days, not business hours: it is a window on the customer being
 * called back, not a working-time limit, and it passes over a weekend too.
 *
 * Deliberately NOT in DEFAULT_KPI_CONFIG. withKpiDefaults() fills every key it
 * holds, so putting it there would make the stored value impossible to tell
 * apart from an unset one — and the page needs to be able to say "nobody has set
 * this yet, here is what is being used instead".
 */
const FOLLOW_UP_GRACE_DEFAULT_DAYS = 1;

/**
 * How long before the Repaired stamp an invoice may have been posted and still
 * count as the invoice that bills the repair (KPIs 1 & 11). Wall-clock minutes,
 * not business time: it exists to absorb the few minutes between invoicing a car
 * and marking it Repaired, which is clerical order, not working time.
 *
 * `invoiceGraceMinutes: 60` is already stored in the live config and has never
 * been read by anything — the same situation `followUpGraceDays` was in. It is
 * read through the threshold sanitiser below like every other limit, so a stored
 * `0` cannot defeat it: a zero grace is the naive version of this fix, and it
 * reads an advisor who invoiced five minutes early as never having invoiced.
 */
const INVOICE_GRACE_DEFAULT_MINUTES = 60;

/**
 * `${invoice_date}T00:00:00Z` lands at 04:00 Gulf, so the Gulf day that date
 * names still has 20 hours to run from there. That is the only question a
 * date-only stamp can answer: is this invoice's whole day already behind us.
 */
const GULF_DAY_END_AFTER_UTC_MIDNIGHT = 20 * 3600_000;

/**
 * Thresholds as the engine reads them.
 *
 * `invoiceGraceMinutes` is stored in Redis but is not in KpiConfig's own
 * threshold list yet, so it is declared here rather than being read with a cast
 * — the sanitiser and the KPI then handle it exactly like every other limit.
 */
type EngineThresholds = KpiConfig['thresholds'] & { invoiceGraceMinutes?: number };

export async function computeKpiTree(config: KpiConfig, weekStartIso?: string): Promise<KpiTree> {
  const notes: string[] = [];
  const start = weekStartFor(weekStartIso, config.weekStartDay ?? 6);
  const endExclusive = addDaysIso(start, 7);
  const end = addDaysIso(start, 6);
  const wStart = gulfToUtc(start);
  const wEnd = gulfToUtc(endExclusive);
  const now = Date.now();
  const holidays = config.publicHolidays ?? [];
  /** Elapsed time as the appendix counts it: working hours only. */
  const elapsed = (from: number, to: number) => businessMsBetween(from, to, holidays);
  /**
   * The same clock, but null when the two stamps cannot be an interval at all.
   *
   * businessMsBetween returns 0 for `endMs <= startMs`, and zero is inside every
   * limit, so an end event recorded before its start used to read as a clean
   * pass. That is not a fast job, it is evidence the two stamps do not belong
   * together — a quotation raised before the inspection it is being timed from,
   * a check-in logged before the job card existed. Not measurable, so the record
   * is left unjudged, counted, and disclosed in a note; never scored as a pass.
   *
   * Equal stamps stay measurable: same-second work is real, and zero elapsed is
   * then the honest answer rather than an artefact of the clamp.
   */
  const measured = (from: number, to: number): number | null => (to < from ? null : elapsed(from, to));

  // ── Thresholds, defended against a non-positive stored value ──────
  //
  // Admin saves `parseInt(e.target.value) || 0`, so clearing a threshold box
  // stores `0`. Every read below is `?? default`, and `0` is not nullish, so the
  // default never applies: the limit becomes zero, nothing can be inside it, and
  // one empty field fines everyone on roughly fourteen KPIs. Admin is being
  // stopped from saving it, but configs already in Redis may hold one today, so
  // the engine refuses to treat it as a limit.
  //
  // The replacement value comes from DEFAULT_KPI_CONFIG, not from the `?? N` at
  // each read. withKpiDefaults() builds thresholds as
  // `{ ...DEFAULT_KPI_CONFIG.thresholds, ...stored }`, so no key ever reaches the
  // engine absent and those `?? N` fallbacks are unreachable — DEFAULT_KPI_CONFIG
  // is the only default with any effect. Copying the numbers here by hand is how
  // awaitingPartsDays came to read 14 at the read and 21 in the shipped config;
  // sourcing them means the limit, the label and the config can no longer drift.
  // `def` is used only for a key DEFAULT_KPI_CONFIG does not carry.
  const limitLabel = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const THRESHOLD_RULES: { key: keyof EngineThresholds; def?: number; label: string; unit: string }[] = [
    { key: 'invoiceHours',          label: 'Invoice on delivery',       unit: 'business hr' },
    { key: 'deliveryHours',         label: 'Delivered after repair',    unit: 'business hr' },
    { key: 'quoteApprovalHours',    label: 'Quote approval',            unit: 'business hr' },
    { key: 'quoteSentHours',        label: 'Quote sent to customer',    unit: 'business hr' },
    { key: 'checkInHours',          label: 'Check-in after RO',         unit: 'business hr' },
    { key: 'inspectionHours',       label: 'Inspection duration',       unit: 'business hr' },
    { key: 'qaHours',               label: 'QA duration',               unit: 'business hr' },
    { key: 'mentionResponseHours',  label: 'Chatter response',          unit: 'business hr' },
    { key: 'tagMinutes',            label: 'Tag on creation',           unit: 'minute' },
    { key: 'awaitingPartsDays',     label: 'Awaiting parts',            unit: 'day' },
    { key: 'awaitingLabourDays',    label: 'Awaiting labour',           unit: 'day' },
    { key: 'rfqAfterApprovalDays',  label: 'RFQ after approval',        unit: 'day' },
    { key: 'rfqConfirmDays',        label: 'RFQ confirmed',             unit: 'day' },
    { key: 'partsPlacedDays',       label: 'Parts placed',              unit: 'day' },
    { key: 'snapshotBaselineDays',  label: 'Awaiting parts / labour baseline window', unit: 'day' },
    // The one key DEFAULT_KPI_CONFIG deliberately omits, so that "absent" can
    // still mean "nobody has set it" once Admin offers the field.
    { key: 'followUpGraceDays',     def: FOLLOW_UP_GRACE_DEFAULT_DAYS, label: 'Customer follow-up grace', unit: 'day' },
    // Stored in Redis, absent from DEFAULT_KPI_CONFIG, so it carries its own
    // default too — see INVOICE_GRACE_DEFAULT_MINUTES.
    { key: 'invoiceGraceMinutes',   def: INVOICE_GRACE_DEFAULT_MINUTES, label: 'Invoice grace before Repaired', unit: 'minute' },
  ];
  const thresholds: EngineThresholds = { ...config.thresholds };
  // Typed as the engine's view so the two keys Admin has no field for yet can be
  // looked up here; an object of the narrower stored type is assignable to it.
  const shippedDefaults: EngineThresholds = DEFAULT_KPI_CONFIG.thresholds;
  const replacedLimits: string[] = [];
  for (const { key, def, label, unit } of THRESHOLD_RULES) {
    const v = thresholds[key];
    // Absent is honest — it means "never configured", and the default applies as
    // it always did. Only a stored value that cannot be a limit is replaced.
    if (v == null) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) continue;
    // Guarded rather than trusted: a non-positive value shipped in
    // DEFAULT_KPI_CONFIG would otherwise be copied straight back in.
    const shipped = shippedDefaults[key];
    const fallback = typeof shipped === 'number' && Number.isFinite(shipped) && shipped > 0 ? shipped : def;
    if (fallback == null) continue;   // no default anywhere to fall back to
    thresholds[key] = fallback;
    replacedLimits.push(`${label} → ${limitLabel(fallback, unit)}`);
  }
  if (replacedLimits.length) {
    notes.push(`${replacedLimits.length} saved threshold${replacedLimits.length === 1 ? ' was' : 's were'} zero or not a positive number, which no record can be inside, so the standard limit was used instead: ${replacedLimits.join(', ')}. Set a positive limit under Admin → KPI Configuration if a different one is intended.`);
  }
  // From here on every limit comes from `thresholds`, never `config.thresholds`.

  // Every Odoo domain below filters on these, so the whole engine is narrowed to
  // the five UAE main branches here and nowhere else. Stations, Qatar and EV Hub
  // are not in it — KPI_BRANCHES says why the KPIs are narrower than the rest of
  // the dashboard.
  const kpiIds = await kpiCompanyIds();

  // company id → branch
  const idToBranch: Record<number, Branch> = {};
  // Only the five main companies are mapped, so a station's, Qatar's or EV Hub's
  // records never resolve to a branch and drop out of every KPI at the push()
  // guard. That guard is the only scope check on the paths that read records by
  // id rather than by domain (KPI 17's chatter), so it is not mere redundancy.
  for (const b of KPI_BRANCHES) {
    const id = await mainCompanyIdFor(b);
    if (id != null) idToBranch[id] = b;
  }

  // Which optional fields exist on this instance?
  const meta = (await call('repair.order', 'fields_get', [], { attributes: ['type', 'relation', 'selection'] })) as FieldsMeta;
  const stageNames = await resolveStageNames(config, meta);
  const has = (f: string) => Object.prototype.hasOwnProperty.call(meta, f);
  // Orders moved to Odoo's "Historical Orders" tab are out of the working set, so
  // no KPI may be computed from one. Resolved once — the probe hits Odoo, and
  // almost every query below needs the clause.
  const notHist = await notHistorical();
  // `read` takes ids, not a domain, so the chatter-driven paths have to bring the
  // flag back with the rows and drop them here. Empty where the field is absent:
  // asking for a field Odoo doesn't have fails the whole call.
  const histField = has(HISTORICAL_FIELD) ? [HISTORICAL_FIELD] : [];
  // Which date KPIs 6 & 7 age from. The preference order and the reasoning behind
  // it live in resolveAgeField (lib/types.ts), shared with the admin field report
  // so the dashboard and its own diagnostics cannot describe different fields.
  // An explicitly chosen basis wins; one Odoo doesn't have falls back to create_date.
  const basis = config.ageBasis ?? 'auto';
  const ageField = resolveAgeField(has, basis);
  const AGE_LABEL: Record<string, string> = {
    status_since: 'time in the current status',
    date_last_stage_update: 'time since the last stage change',
    create_date: 'age of the repair order',
    write_date: 'time since last modification — any edit resets this clock',
  };
  const baselineDaysNote = thresholds.snapshotBaselineDays ?? 90;
  let snapshotNote = `Counts only the vehicles actually waiting, among open ROs created in the last ${baselineDaysNote} days (closed work is excluded): compliant means still inside the limit, non-compliant means waiting beyond it, and a vehicle that is not waiting is not in the count at all. One with no usable stamp to age from is left out rather than counted either way. Ageing measured by ${AGE_LABEL[ageField] ?? ageField}.`;
  let usedTrackingForAging = false;
  let awaitingPartsMethod = 'outstanding parts lines (Done qty below Demand)';
  // Resolved here, not inside KPI 13's block, so the limit the KPI applies and
  // the limit its ⓘ tooltip states are the same number by construction.
  const followUpGraceDays = thresholds.followUpGraceDays ?? FOLLOW_UP_GRACE_DEFAULT_DAYS;
  // Same reason: KPIs 1 and 11 state this grace in their ⓘ tooltips, and the
  // tooltip is what a fined person is shown, so it must be the number the KPI
  // actually applied rather than a second copy of it.
  const invoiceGraceMinutes = thresholds.invoiceGraceMinutes ?? INVOICE_GRACE_DEFAULT_MINUTES;
  // KPI 6 only. KPI 7 no longer ages from the configured basis at all: the owner
  // fixed its anchor at status_since, so `ageBasis` cannot move its clock and a
  // note naming it here would be false for the one KPI whose figure it does not
  // touch. `ageField` reaches KPI 6 through overdueByState, which is now only
  // the parts fallback path.
  if (ageField === 'write_date') {
    notes.push('KPI 6 is measured from write_date — any edit resets the clock, so violations may be undercounted.');
  }
  if (!has('sale_order_id')) {
    notes.push('repair.order has no sale_order_id — KPIs 1, 3 and 4 cannot be evaluated.');
  }

  const evals: Evaluation[] = [];
  const roCountByUser: Record<number, number> = {};

  /** The subject of a verdict: an Odoo user, or nobody. */
  type Performer = { id: number | null; name: string };

  /**
   * Chatter author (res.partner) → the Odoo user who is that person.
   *
   * Half the KPIs here are performed by whoever moved a car between stages, and
   * the chatter records that person as a PARTNER. A partner id is not a user id,
   * so it can never be charged as one — do that and the verdict lands on
   * whichever unrelated user happens to hold the same number.
   *
   * Resolved the way KPI 17 already resolves its mention recipients, including
   * `active_test: false`: a departed employee is still a user and still performed
   * the work they performed while employed. Without it Odoo's implicit
   * `active = True` would drop ex-staff, and their verdicts would silently become
   * unattributable — i.e. shared across everyone else.
   *
   * Cached for the whole run and filled in bulk, so a second KPI asking about the
   * same people costs no call at all. Unresolved partners are cached as `null`
   * too: a customer, a mail gateway or an Odoo automation is never a performer,
   * and re-asking about them every block would multiply reads for a known answer.
   */
  const userByPartner = new Map<number, Performer | null>();
  const loadAuthors = async (partners: (number | null | undefined)[]) => {
    const want = [...new Set(partners.filter((p): p is number => p != null && !userByPartner.has(p)))];
    if (!want.length) return;
    // Recorded as unresolved up front, so a failed read is not retried by every
    // later caller — and so a failure reads as "unknown performer", never as the
    // record creator.
    for (const p of want) userByPartner.set(p, null);
    try {
      const users = (await call('res.users', 'search_read', [[['partner_id', 'in', want]]], {
        fields: ['partner_id', 'name'], limit: 0, context: { active_test: false },
      })) as Rec[];
      for (const u of users) {
        const pid = m2o(u.partner_id)?.[0];
        if (pid != null) userByPartner.set(pid, { id: u.id as number, name: (u.name as string) || `User ${u.id}` });
      }
    } catch { /* every partner in this batch stays unresolved */ }
  };
  /**
   * The performer behind a chatter author, or null when there is none to charge.
   *
   * Null covers both "nobody made this transition" and "the author is not an
   * internal user", and both must behave the same: the verdict names nobody and
   * falls to rule 3. The one thing it must never do is return the partner id.
   */
  const authorPerformer = (partner: number | null | undefined): Performer | null =>
    (partner != null ? userByPartner.get(partner) ?? null : null);

  /**
   * Who confirmed each quotation — the person KPIs 2, 3 and 4 are about.
   *
   * All three judge the approval of a quotation, and approval is a click
   * somebody made: `sale.order.state` moving to Confirmed, recorded in the
   * chatter with its author. The quotation's own creator wrote it, which is a
   * different act by frequently a different person, and the repair order's
   * creator — what these KPIs charged until now — did neither.
   *
   * This is the one performer in the engine that costs an Odoo read of its own:
   * nothing else here reads sale.order's chatter. It is bounded on purpose —
   * filled in bulk for whole populations and cached across the three KPIs, so
   * the second and third blocks pay nothing for quotations the first already
   * asked about, and nothing is ever looked up one record at a time.
   *
   * A quotation whose confirmation cannot be read falls back to its creator at
   * the call site, per the owner's rule. A quotation that was never confirmed has
   * no confirmer to find, which is correct: there was no approval to attribute.
   */
  const confirmerBySo = new Map<number, Performer | null>();
  let soConfirmLabels: string[] | null = null;
  const loadQuotationConfirmers = async (soIds: (number | null | undefined)[]) => {
    const want = [...new Set(soIds.filter((id): id is number => id != null && !confirmerBySo.has(id)))];
    if (!want.length) return;
    for (const id of want) confirmerBySo.set(id, null);   // unresolved until proven otherwise
    if (soConfirmLabels == null) {
      // The chatter stores the human LABEL of the new value, so the codes have to
      // be translated through the selection list exactly as trackedField() does
      // for repair.order. Resolved once per run.
      try {
        const soMeta = (await call('sale.order', 'fields_get', [], { attributes: ['selection'] })) as FieldsMeta;
        soConfirmLabels = (soMeta.state?.selection ?? [])
          .filter(([code]) => code === 'sale' || code === 'done')
          .map(([, label]) => label);
      } catch { soConfirmLabels = []; }
    }
    if (!soConfirmLabels.length) return;
    // 'last', not 'first': KPI 2 times the approval Odoo recorded in date_order,
    // and Odoo overwrites that stamp when a quotation is confirmed again. The
    // performer has to come from the same confirmation the clock does.
    const tx = await trackedTransitions('sale.order', [
      ['model', '=', 'sale.order'],
      ['res_id', 'in', want],
      ['tracking_value_ids', '!=', false],
    ], 'state', soConfirmLabels, 'last');
    await loadAuthors(Object.values(tx.by));
    for (const [key, partner] of Object.entries(tx.by)) confirmerBySo.set(Number(key), authorPerformer(partner));
  };

  /**
   * Record an evaluation against a named person rather than the record's creator.
   * Most KPIs judge whoever raised the RO; this one judges whoever was asked.
   */
  const pushFor = (
    kpiId: number,
    branch: Branch | undefined,
    user: { id: number | null; name: string },
    compliant: boolean,
    ref: string,
  ) => {
    if (!branch) return;
    evals.push({ kpiId, branch, userId: user.id, userName: user.name, compliant, ref });
  };

  /**
   * `performedBy` is who did the thing this KPI measures, and it has three
   * distinct values — the distinction is the whole fix, so it is spelled out:
   *
   *   • OMITTED  → the record's own creator performed it. True where the record
   *     IS the action: KPI 5 and 8 judge a job card and its creator opened it,
   *     KPI 12 and 21 judge a quotation and its creator wrote it, KPI 19 and 20
   *     judge a purchase order and its creator raised it.
   *   • a person → somebody other than the record's creator performed it. Most
   *     KPIs are this case, because most of them judge a repair order for
   *     something that was done on a quotation, an invoice or a purchase order,
   *     or for a stage move somebody else made. Charging `create_uid` there sent
   *     every verdict to whoever opened the job card, whatever the KPI measured.
   *   • NULL     → the action was never performed, or its performer cannot be
   *     read. The verdict then names nobody and is shared across the KPI's
   *     owners in that branch at roll-up (rule 3). Passing the record's creator
   *     instead would charge the one person we know did NOT do it.
   *
   * `undefined` and `null` therefore mean opposite things and are kept apart on
   * purpose: a block that cannot identify the performer must say `null`, never
   * leave the argument off.
   *
   * The branch always comes from the record, so a Dubai order stays Dubai's
   * however far away the performer sits.
   */
  const push = (kpiId: number, rec: Rec, compliant: boolean, ref: string,
                performedBy?: { id: number | null; name: string } | null) => {
    const cid = m2o(rec.company_id)?.[0];
    const branch = cid != null ? idToBranch[cid] : undefined;
    if (!branch) return; // untracked company (CarDIP, …)
    const u = m2o(rec.create_uid);
    const who = performedBy === undefined
      ? { id: u?.[0] ?? null, name: u?.[1] ?? 'Unknown' }
      : (performedBy ?? NO_PERFORMER);
    evals.push({ kpiId, branch, userId: who.id, userName: who.name, compliant, ref });
  };

  /**
   * Quotations that belong to no job card in the Orders tab — i.e. that have no
   * live (non-historical) repair order behind them at all.
   *
   * The owner's rule for this section: "ignore orders in the historical orders
   * tab. We are starting fresh, so only read orders and their quotations and
   * invoices which are in the orders tab." So a quotation is in scope only while
   * some live repair order points at it. That covers two populations at once —
   * quotations whose job cards have all been moved to Historical, and sale orders
   * that are not workshop work in the first place (counter parts sales, retail),
   * which were inflating the approval rate with jobs no advisor was scored for.
   *
   * This REPLACES the earlier rule, which deliberately kept a quotation with no
   * repair order at all as "a quotation in its own right". The owner has decided
   * otherwise, so the historical rows no longer need to be read back and told
   * apart: `notHist` goes into the query and anything it returns is proof of a
   * live job card.
   *
   * A failed chunk must never quietly shrink a scored population, so its
   * quotations stay scored and are counted back for the caller to disclose.
   */
  const quotationsOutOfScope = async (soIds: number[]): Promise<{ out: Set<number>; unchecked: number }> => {
    const out = new Set<number>();
    if (!soIds.length) return { out, unchecked: 0 };
    // With no link from repair.order to sale.order the question cannot be asked
    // at all. Excluding every quotation on the strength of a field this instance
    // does not have would empty both KPIs, so nothing is excluded and the caller
    // says how many went unchecked.
    if (!has('sale_order_id')) return { out, unchecked: soIds.length };
    let unchecked = 0;
    for (let i = 0; i < soIds.length; i += 2000) {
      const chunk = soIds.slice(i, i + 2000);
      try {
        const ros = (await call('repair.order', 'search_read', [[
          ['sale_order_id', 'in', chunk],
          ...notHist,
        ]], { fields: ['sale_order_id'], limit: 0 })) as Rec[];
        const live = new Set<number>();
        for (const r of ros) {
          const id = m2o(r.sale_order_id)?.[0];
          if (id != null) live.add(id);
        }
        for (const id of chunk) if (!live.has(id)) out.add(id);
      } catch { unchecked += chunk.length; }
    }
    return { out, unchecked };
  };

  // Shared by every weekly repair.order query, so the historical clause lands on
  // all of them from here.
  const weekDomain: OdooDomain = [
    ['create_date', '>=', wStart],
    ['create_date', '<', wEnd],
    ['company_id', 'in', kpiIds],
    ...notHist,
  ];
  const enabled = config.enabledKpis ?? [];
  const on = (id: number) => enabled.includes(id);

  // The QA stage, as the chatter records it. Resolved here rather than beside
  // tfInspection further down because two KPIs now need it: KPI 16 times the
  // dwell in QA, and KPI 13's population is the repair orders that actually
  // entered QA. One definition, so the two can never disagree about what QA is.
  const tfQa = trackedField(config.stageMap.qa, meta, stageNames);

  // ── KPIs 1 & 11 — time from "Repaired" to the invoice being posted ──
  // Same measurement, two thresholds: KPI 1 is the prompt-invoicing rule, KPI 11
  // stands in for delivery (a car isn't handed over before it's invoiced).
  if ((on(1) || on(11) || on(13) || on(22)) && has('sale_order_id')) {
    const roFields = ['name', 'create_uid', 'company_id', 'sale_order_id'];
    if (has('invoice_id')) roFields.push('invoice_id');   // some versions link the invoice directly
    // KPI 22 judges the same repaired population against the date promised to the
    // customer, so it rides along here rather than re-reading the chatter.
    const scheduleField = on(22) && has('schedule_date') ? 'schedule_date' : undefined;
    if (scheduleField) roFields.push(scheduleField);
    // Follow-up is a binary field — bin_size returns its size instead of the
    // whole attachment, so we can tell "uploaded or not" without the payload.
    const followUpField = on(13)
      ? ['follow_up_screenshot', 'x_follow_up_screenshot'].find(has)
      : undefined;
    if (followUpField) roFields.push(followUpField);
    if (on(13) && !followUpField) {
      notes.push('Customer follow-up is inactive — no follow-up screenshot field found on repair.order.');
    }
    // The population needs a QA stage it can recognise. Without one there is no
    // record-based way to tell which jobs went through QA, and the whole point of
    // the new population is that it is a fact about the job card rather than
    // about whoever happens to be reading it — so the KPI is skipped, not widened.
    if (on(13) && followUpField && !tfQa) {
      notes.push('Customer follow-up was skipped: QA is not mapped to a tracked state under Admin → KPI Configuration, so the repair orders that actually went through QA cannot be identified. Judging every repaired vehicle instead would score jobs that never reached QA at all.');
    }
    roFields.push(...histField);   // the chatter branch below reads by id, past any domain
    const roCtx = { bin_size: true };
    const tfRepaired = trackedField(config.stageMap.repaired, meta, stageNames);

    // Preferred: ROs that reached the repaired/delivered state during this week,
    // whatever state they're in now. Falls back to current-state matching.
    let deliveredAt = tfRepaired
      ? await roIdsEnteringStateInWindow(tfRepaired.field, tfRepaired.labels, wStart, wEnd)
      : noTransitions();
    const enteredIds = Object.keys(deliveredAt.at).map(Number);

    let repaired: Rec[];
    if (enteredIds.length) {
      // Dropped before invoices are looked up, so a historical order is never timed.
      repaired = ((await call('repair.order', 'read', [enteredIds], { fields: roFields, context: roCtx })) as Rec[])
        .filter((r) => !isHistorical(r));
    } else {
      repaired = (await call('repair.order', 'search_read', [[
        ...selectorDomain(config.stageMap.repaired), ...weekDomain,
      ]], { fields: roFields, limit: 0, context: roCtx })) as Rec[];
      if (tfRepaired) {
        // 'first', like the windowed lookup above: everything here is measured
        // FROM the car becoming Repaired, and Repaired is mapped to three codes
        // (Labour Complete / QC Complete / Vehicle Ready). Taking the last of
        // them failed a car finished at 16:00 on its promised day because
        // somebody ticked Vehicle Ready the next morning. These ROs were created
        // this week, so their first Repaired stamp is inside the week anyway.
        deliveredAt = await stateEntryTimes(repaired.map((r) => r.id as number), tfRepaired.field, tfRepaired.labels, 'first');
      }
    }

    // Wall-clock minutes, deliberately: the grace absorbs the clerical gap
    // between posting an invoice and ticking the car Repaired, not working time.
    const invoices = (on(1) || on(11))
      ? await invoiceTimesForRos(repaired, deliveredAt.at, invoiceGraceMinutes * 60_000)
      : {
        times: {} as Record<number, number>, failed: false, depositOnly: 0, dayOnly: new Set<number>(),
        creators: {} as Record<number, { id: number; name: string }>,
      };
    const invoicedAt = invoices.times;

    /**
     * Judge repaired → invoice-posted against a time limit.
     *
     * Charged to whoever raised the billing invoice, which is what both KPIs
     * measure. Until now they were charged to the repair order's creator, so the
     * one KPI the invoicing staff answer for landed on the advisor who opened the
     * job card — the defect this whole change exists to remove. A repaired car
     * with no invoice at all has no invoicer to name, and then the verdict names
     * nobody and is shared across the KPI's owners at roll-up.
     */
    const judgeInvoiceTiming = (kpiId: number, limitMs: number) => {
      for (const r of repaired) {
        const rep = deliveredAt.at[r.id as number];
        if (rep == null) continue;                 // no repaired timestamp → not measurable
        // Billing invoice found, but it carries a date and no time. An hour
        // cannot be timed from a date, and the old parse put it at 04:00 Gulf,
        // before the working day — which passed every late invoice dated the
        // repair day. Unjudged, counted, and disclosed in the note below.
        if (invoices.dayOnly.has(r.id as number)) continue;
        const inv = invoicedAt[r.id as number];
        const ref = (r.name as string) || '';
        // No `measured` guard here, and that is the point of the grace: an
        // invoice posted inside the grace is EARLIER than the Repaired stamp on
        // purpose, clamps to zero elapsed and is compliant — the advisor did
        // invoice the car. Anything earlier than the grace is a deposit and was
        // never selected as the billing invoice, so it cannot reach this line.
        if (inv != null) push(kpiId, r, elapsed(rep, inv) <= limitMs, ref, invoices.creators[r.id as number] ?? null);
        // The running clock is business time too, or a Thursday repair would be
        // failed by the weekend before anyone could invoice it.
        // No performer: there is no invoice, so there is nobody who invoiced it.
        else if (elapsed(rep, now) > limitMs) push(kpiId, r, false, ref, null);  // overdue, still uninvoiced
        // still inside the window and uninvoiced → not judged yet
      }
    };

    // A lookup that failed is not an invoice that was never posted. With an empty
    // map every repaired RO looks uninvoiced and the clause above fails each one
    // past the limit — at a one-business-hour limit, effectively all of them. So
    // neither KPI is judged at all until the invoices can be read.
    if (invoices.failed) {
      notes.push('Invoice on delivery and Delivered after repair were not scored this week: the linked invoices could not be read from Odoo, so an unposted invoice cannot be told apart from one we failed to fetch. Both KPIs are left out rather than counting every repaired vehicle as never invoiced.');
    } else {
      if (on(1)) judgeInvoiceTiming(1, businessHours(thresholds.invoiceHours ?? 1));
      if (on(11)) judgeInvoiceTiming(11, businessHours(thresholds.deliveryHours ?? 48));
      // An invoice was found but its raiser was not. Stated, because the verdict
      // is then shared across the KPI's owners instead of naming one person, and
      // a reader comparing a card against the branch is owed the reason.
      const noRaiser = Object.keys(invoicedAt).filter((k) => !invoices.creators[Number(k)]).length;
      if (noRaiser) {
        notes.push(`Invoice on delivery and Delivered after repair could not read who raised the billing invoice on ${noRaiser} repaired RO${noRaiser === 1 ? '' : 's'}. ${noRaiser === 1 ? 'That verdict names' : 'Those verdicts name'} nobody and ${noRaiser === 1 ? 'is' : 'are'} shared across each KPI's owners in the branch; neither is charged to whoever opened the job card, who does not raise the invoice.`);
      }
      if (on(1) || on(11)) {
        notes.push(`Invoice on delivery and Delivered after repair are timed to the invoice that bills the repair: the earliest invoice posted no more than ${limitLabel(invoiceGraceMinutes, 'minute')} before the car was marked Repaired, or at any time after it. Anything posted earlier than that is a down-payment invoice — Odoo posts those at quotation time, and taking the earliest invoice on the job meant a deposit timed the repair, gave a negative interval, and marked the job compliant forever whenever the real closing invoice was posted. The grace is wall-clock time, so invoicing a car a few minutes before ticking it Repaired still counts as invoicing it.`);
      }
      if (invoices.depositOnly) {
        notes.push(`Invoice on delivery and Delivered after repair found only pre-Repaired invoices on ${invoices.depositOnly} repaired RO${invoices.depositOnly === 1 ? '' : 's'} — a deposit, with no invoice yet billing the repair. ${invoices.depositOnly === 1 ? 'It is' : 'They are'} treated as not yet invoiced: still unjudged while inside the limit, non-compliant once past it. ${invoices.depositOnly === 1 ? 'It was' : 'They were'} reading as compliant until now.`);
      }
      if (invoices.dayOnly.size) {
        const n = invoices.dayOnly.size;
        notes.push(`Invoice on delivery and Delivered after repair left ${n} repaired RO${n === 1 ? '' : 's'} unjudged whose billing invoice carries an invoice date but no posting time — Odoo tracked no posting for ${n === 1 ? 'it' : 'them'}, and a date alone cannot time a limit measured in business hours. ${n === 1 ? 'It is' : 'They are'} left out rather than counted compliant: the date used to be read as 04:00 Gulf, before the working day, so an invoice posted days late but dated the repair day passed unconditionally.`);
      }
    }

    // Follow-up is the one KPI here that is not a stopwatch: a vehicle either has
    // the screenshot or it does not.
    //
    // Scope matters more than timing here, and the population is the owner's
    // decision: the follow-up belongs to the jobs that actually went through QA,
    // charged to the service advisor who opened the job card.
    //
    // It used to filter on repair_is_qa. That field is labelled "QA Access" and
    // is computed, non-stored and readonly — button visibility, which Odoo
    // recomputes for whoever reads the record. So the population was a statement
    // about our integration user's permissions, not about the job, and it would
    // pass either everything or nothing. The record-based fact is the QA stage
    // transition in the chatter, which is the same signal KPI 16 times its QA
    // dwell from — so the two KPIs now agree on which jobs reached QA.
    //
    // A job whose QA entry cannot be found is skipped rather than judged: the
    // chatter may simply not reach back that far, and an unobserved QA is not a
    // missed follow-up.
    //
    // It is not instantaneous either. The advisor is owed a grace period in which
    // to call the customer back and upload the proof; without one, a car repaired
    // ten minutes before the page loads was already a named violation with its RO
    // number against it.
    if (on(13) && followUpField && tfQa) {
      // Calendar days, not business hours: the grace is a window on the customer
      // being called back, and it runs over a weekend too.
      const graceMs = followUpGraceDays * 86400_000;
      // Same by-id chatter lookup the stage KPIs use; unwindowed on purpose, since
      // a job repaired this week may well have passed QA in an earlier one.
      // Only existence is read from this, never the moment, so which arrival it
      // keeps cannot change a verdict — the grace runs from the Repaired stamp.
      const qaEntry = await stateEntryTimes(repaired.map((r) => r.id as number), tfQa.field, tfQa.labels);
      let insideGrace = 0, noRepairedAt = 0, noQaEntry = 0, eligible = 0;
      for (const r of repaired) {
        // Judged only if this job card is KNOWN to have entered QA.
        if (qaEntry.at[r.id as number] == null) { noQaEntry++; continue; }
        eligible++;
        const rep = deliveredAt.at[r.id as number];
        // Without the Repaired moment there is no way to know the grace has run
        // out. The job card's own create_date would say it always has — the same
        // ambiguity-resolved-as-a-fine this engine no longer accepts anywhere.
        if (rep == null) { noRepairedAt++; continue; }
        if (now - rep < graceMs) { insideGrace++; continue; }
        // No performer passed, which here means "the record's creator did it":
        // the owner's rule for this KPI is explicit — "always the service advisor
        // that created the repair order" — and push()'s default subject is the
        // repair order's create_uid, i.e. whoever opened the job card. The upload
        // itself is a binary field and carries no author of its own, so the job
        // card's owner is also the only attributable signal that exists.
        push(13, r, !!r[followUpField], (r.name as string) || '');
      }
      if (thresholds.followUpGraceDays == null) {
        notes.push(`Customer follow-up has no grace period configured, so ${limitLabel(FOLLOW_UP_GRACE_DEFAULT_DAYS, 'day')} is being used: a repaired RO is only judged once that long has passed since it was marked Repaired. Set the follow-up grace under Admin → KPI Configuration to change it.`);
      }
      if (insideGrace) {
        notes.push(`Customer follow-up left ${insideGrace} repaired RO${insideGrace === 1 ? '' : 's'} unjudged, still inside the ${limitLabel(followUpGraceDays, 'day')} grace period — the follow-up is not due on them yet.`);
      }
      if (noRepairedAt) {
        notes.push(`Customer follow-up left ${noRepairedAt} QA'd RO${noRepairedAt === 1 ? '' : 's'} unjudged with no Repaired timestamp in the chatter — without it the grace period cannot be measured, and nothing here will stand in for it.`);
      }
      if (noQaEntry) {
        notes.push(`Customer follow-up is scored on the jobs that actually went through QA, which it reads from the QA stage changes in the chatter. ${noQaEntry} of this week's ${repaired.length} repaired RO${repaired.length === 1 ? '' : 's'} ${noQaEntry === 1 ? 'was' : 'were'} left unjudged because no QA entry could be found for ${noQaEntry === 1 ? 'it' : 'them'} — either the job never reached QA, or it did so before that stage was being tracked. Neither is a missed follow-up, so neither is counted. The figure covers fewer vehicles than before for that reason, not because the branches got worse.`);
      }
      if (repaired.length && !eligible) {
        notes.push(`None of this week's ${repaired.length} repaired ROs could be shown to have entered QA, so Customer follow-up has nobody to score this week. It no longer uses the "QA Access" flag, which described our Odoo login's permissions rather than the job.`);
      }
    }

    // ── KPI 22 — did the vehicle reach Repaired by the promised date? ──
    //
    // A deadline, not a duration: the promise is a wall-clock moment the customer
    // was given, so it is compared raw. Running it through the business clock
    // would move the promise itself.
    if (on(22) && scheduleField) {
      // A date-only promise means "that day", so it falls due as the day closes.
      //
      // The 23:59:59 treatment used to depend on the FIELD's type being `date`.
      // On this instance schedule_date is a datetime, so the branch never fired:
      // a promise entered as a day stores midnight, and every car ready at any
      // hour of its promised day was scored late. The test is therefore on the
      // VALUE, not on the field — and on the Gulf-converted value, because the
      // stamp is stored UTC and Gulf is UTC+4: a promise for "15 Nov" is stored
      // as 2026-11-14 20:00:00Z, whose UTC clock is 20:00 and whose Gulf clock
      // is the midnight that reveals it as a day, not a time.
      const fieldIsDate = meta[scheduleField]?.type === 'date';
      // Performed by whoever marked the car Repaired — the moment this KPI
      // judges. That person is the chatter author of the Repaired transition the
      // clock above already read, so the only cost is resolving their partner to
      // a user. The repair order's creator, which this KPI charged before, does
      // not decide when a car is finished.
      await loadAuthors(Object.values(deliveredAt.by));
      let unpromised = 0, dayPromises = 0, noMarker = 0;
      for (const r of repaired) {
        const rep = deliveredAt.at[r.id as number];
        if (rep == null) continue;                 // no repaired timestamp → not measurable
        const raw = r[scheduleField];
        let due: number | null;
        if (fieldIsDate && typeof raw === 'string') {
          // A real Date field: 'YYYY-MM-DD', with no clock to inspect.
          due = Date.parse(`${raw}T23:59:59+04:00`);
          if (Number.isFinite(due)) dayPromises++;
        } else {
          due = odooTime(raw);
          if (due != null) {
            // Gulf clock reads exactly 00:00:00 → a day was promised, not a
            // moment, so it falls due at 23:59:59 Gulf the same day. Adding one
            // day less one second gets there without re-formatting the date.
            const gulf = new Date(due + GULF_OFFSET_MS);
            if (gulf.getUTCHours() === 0 && gulf.getUTCMinutes() === 0 && gulf.getUTCSeconds() === 0) {
              due += 86_400_000 - 1000;
              dayPromises++;
            }
          }
        }
        // Nothing promised, so nothing can be late.
        if (due == null || !Number.isFinite(due)) { unpromised++; continue; }
        const markedBy = authorPerformer(deliveredAt.by[r.id as number]);
        if (!markedBy) noMarker++;
        push(22, r, rep <= due, (r.name as string) || '', markedBy);
      }
      if (noMarker) {
        notes.push(`Ready by promised time could not identify who marked ${noMarker} repaired RO${noMarker === 1 ? '' : 's'} Repaired — the chatter author behind the transition is not an internal Odoo user, or could not be read. ${noMarker === 1 ? 'That verdict names' : 'Those verdicts name'} nobody and ${noMarker === 1 ? 'is' : 'are'} shared across this KPI's owners in the branch instead of being charged to whoever opened the job card, who did not decide when the car was finished.`);
      }
      if (unpromised) {
        notes.push(`Ready by promised time skipped ${unpromised} repaired RO${unpromised === 1 ? '' : 's'} with no scheduled delivery date — nothing was promised, so nothing can be late.`);
      }
      if (dayPromises) {
        notes.push(`Ready by promised time read ${dayPromises} promise${dayPromises === 1 ? '' : 's'} as a whole day rather than an exact time, falling due at 23:59 Gulf on the promised day: ${dayPromises === 1 ? 'its scheduled delivery date carries' : 'their scheduled delivery dates carry'} no time of day. Until now those were timed to midnight at the START of the day, which failed every car made ready at any hour of the day it was promised for. If this is most of the week's promises, the branch is promising by day and not by hour, and the KPI should be read that way.`);
      }
    }
    if (on(22) && !scheduleField) {
      notes.push('Ready by promised time is inactive — repair.order carries no schedule_date to judge the promise against.');
    }

    if (!Object.keys(deliveredAt.at).length) {
      notes.push(tfRepaired
        ? `No "${tfRepaired.labels.join('/')}" transitions found on ${tfRepaired.field} in the chatter this week. If that field is not tracked in Odoo, map Repaired to one that is — delivery, invoicing and follow-up all need the moment it happened.`
        : 'Repaired is not mapped to a state or status, so nothing can be timed from it.');
    }
  }

  // ── KPIs 3 & 4 — the quotation must come BEFORE repair starts ──
  // Uses the chatter log for the moment the RO entered "under repair", so both check
  // a real sequence: KPI 4 wants the quote *created* first, KPI 3 wants it *approved*.
  if ((on(3) || on(4)) && has('sale_order_id')) {
    const roFields = ['name', 'create_uid', 'company_id', 'sale_order_id', ...histField];
    const tf = trackedField(config.stageMap.underRepair, meta, stageNames);

    // ROs that STARTED repair during this week, whatever state they're in now.
    let entered = tf ? await roIdsEnteringStateInWindow(tf.field, tf.labels, wStart, wEnd) : noTransitions();
    const startedIds = Object.keys(entered.at).map(Number);

    let inRepair: Rec[];
    if (startedIds.length) {
      // Read by id, so the domain cannot help — drop them before any quote is judged.
      inRepair = ((await call('repair.order', 'read', [startedIds], { fields: roFields })) as Rec[])
        .filter((r) => !isHistorical(r));
    } else {
      inRepair = (await call('repair.order', 'search_read', [[
        ...selectorDomain(config.stageMap.underRepair), ...weekDomain,
      ]], { fields: roFields, limit: 0 })) as Rec[];
      // 'first': both KPIs ask whether the quotation came BEFORE repair started,
      // so the start is the first time this job went under repair. Measuring
      // from the latest entry let a rework pass — the quote predated the second
      // start, so a job repaired once with no approved quote still read clean.
      if (tf) entered = await stateEntryTimes(inRepair.map((r) => r.id as number), tf.field, tf.labels, 'first');
    }

    // Quotation creation and approval times. date_order is when Odoo confirms a
    // quotation into a sale order — i.e. the moment the customer approved it.
    const soIds = [...new Set(inRepair.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))];
    const soCreated: Record<number, number> = {};
    const soApproved: Record<number, number> = {};
    /** Quotation → who wrote it, the fallback performer when its confirmer is unreadable. */
    const soAuthor: Record<number, Performer> = {};
    // "We could not read the quotations" is a different fact from "the quotation
    // was never approved", and the two used to be indistinguishable here: an empty
    // soApproved failed every quoted RO on KPI 3, while an empty soCreated passed
    // every one of them on KPI 4. One lost RPC, a branch fined on one KPI and paid
    // an undeserved incentive on the other.
    let quotationsUnreadable = false;
    if (soIds.length) {
      try {
        // create_uid rides along in a read that already runs: both KPIs are about
        // somebody's handling of the QUOTATION, so when the confirmation itself
        // cannot be read the quotation's author is the owner's stated fallback —
        // never the repair order's creator, who neither wrote nor confirmed it.
        const sos = (await call('sale.order', 'read', [soIds], { fields: ['create_date', 'create_uid', 'date_order', 'state'] })) as Rec[];
        for (const so of sos) {
          const c = odooTime(so.create_date);
          if (c != null) soCreated[so.id as number] = c;
          const u = m2o(so.create_uid);
          if (u) soAuthor[so.id as number] = { id: u[0], name: u[1] };
          if (so.state === 'sale' || so.state === 'done') {
            const a = odooTime(so.date_order);
            if (a != null) soApproved[so.id as number] = a;
          }
        }
      } catch { quotationsUnreadable = true; }
    }
    // Who clicked Confirm on each of these quotations. One bulk chatter read,
    // shared with KPI 2 through the run-wide cache.
    if (soIds.length && !quotationsUnreadable) await loadQuotationConfirmers(soIds);
    /**
     * The performer for both KPIs: whoever confirmed the quotation, falling back
     * to whoever wrote it, and nobody at all when there is no quotation.
     *
     * A repair order with no quotation is the pure rule-3 case — the action these
     * KPIs measure never happened, so there is no performer to find and the
     * verdict is shared across the KPI's owners rather than landed on the person
     * who opened the job card.
     */
    const quotePerformer = (soId: number | null): Performer | null =>
      (soId == null ? null : confirmerBySo.get(soId) ?? soAuthor[soId] ?? null);

    let sequenceChecked = 0;
    for (const r of inRepair) {
      const ref = (r.name as string) || '';
      const soId = m2o(r.sale_order_id)?.[0] ?? null;
      const startedAt = entered.at[r.id as number];
      // An RO with no quotation linked at all is still judged: that verdict comes
      // from the repair order, which was read fine. Only the ones whose quotation
      // we failed to read go unjudged, counted for the note below.
      const unreadable = soId != null && quotationsUnreadable;
      // Null exactly when soId is null, so "no quotation" is a verdict with no
      // performer rather than one charged to the job card's owner.
      const who = quotePerformer(soId);

      if (on(4)) {
        if (soId == null) push(4, r, false, ref, null);         // no quote at all, nobody to charge
        else if (!unreadable) {
          const quotedAt = soCreated[soId];
          if (startedAt != null && quotedAt != null) {
            sequenceChecked++;
            push(4, r, quotedAt <= startedAt, ref, who);        // quote must pre-date repair start
          } else {
            push(4, r, true, ref, who);                         // exists, sequence unverifiable
          }
        }
      }

      if (on(3)) {
        // The quotation must have been APPROVED (confirmed into a sale order)
        // before the RO moved into Under Repair.
        if (soId == null) push(3, r, false, ref, null);         // no quote at all, nobody to charge
        else if (!unreadable) {
          const approvedAt = soApproved[soId];
          // Never approved: the quotation exists, so its author is still the
          // person answerable for getting it approved. Only a job with no
          // quotation at all has nobody.
          if (approvedAt == null) push(3, r, false, ref, who);   // never approved
          else if (startedAt != null) push(3, r, approvedAt <= startedAt, ref, who);
          else push(3, r, true, ref, who);                       // approved, sequence unverifiable
        }
      }
    }
    if (quotationsUnreadable) {
      const skipped = inRepair.filter((r) => m2o(r.sale_order_id)?.[0] != null).length;
      notes.push(`SO before repaired and Quote before starting repair left ${skipped} repair order${skipped === 1 ? '' : 's'} unjudged — their quotations could not be read from Odoo, so an unapproved quotation cannot be told apart from one we failed to fetch. Repair orders with no quotation linked at all are still counted.`);
    }
    // Guarded on the read having worked: with the quotations unreadable nothing
    // could be sequence-checked for that reason alone, and blaming the chatter
    // for it would send the admin to fix the wrong thing.
    if (inRepair.length && sequenceChecked === 0 && !quotationsUnreadable) {
      // The two KPIs fail in opposite directions without a start timestamp, and
      // saying they "only check that a quotation exists" was true of KPI 4 and
      // false of KPI 3, which still hard-fails anything unapproved.
      notes.push(tf
        ? `No "${tf.labels.join('/')}" transitions found on ${tf.field} in the chatter, so neither quotation KPI could check the sequence. Quote before starting repair then passes any RO that has a quotation at all, which is more generous than its rule; SO before repaired still fails any RO whose quotation was never approved, which is stricter than its rule.`
        : 'Under repair is not mapped, so neither quotation KPI could check the sequence. Quote before starting repair passes any RO that has a quotation at all, which is more generous than its rule; SO before repaired still fails any RO whose quotation was never approved, which is stricter than its rule.');
    }
  }

  // ── KPIs 5 & 8 — tagging on ROs created this week ──
  if (on(5) || on(8)) {
    // Both tag fields count. Stages Tags is where a lot of the tagging actually
    // happens, so reading only tag_ids marked compliant work as untagged.
    const tagFields = TAG_FIELDS.filter((f) => has(f));
    const weekROs = (await call('repair.order', 'search_read', [weekDomain], {
      fields: ['name', 'create_uid', 'company_id', 'create_date', ...tagFields], limit: 0,
    })) as Rec[];
    const graceMs = (thresholds.tagMinutes ?? 60) * 60_000;

    // Tags that mark the vehicle in/out (KPI 8), resolved per field.
    const presence = on(8)
      ? await resolveTagMatches(config.stageMap.presenceTags?.values ?? [], meta, PRESENCE_TAG_RE)
      : [];
    const presenceLive = presence.some((m) => m.ids.size);

    for (const r of weekROs) {
      const created = odooTime(r.create_date);
      // Only judge ROs that have had their full grace period.
      if (created == null || now - created < graceMs) continue;
      const tagged = tagFields.some((f) => ((r[f] as number[] | undefined) ?? []).length > 0);
      const ref = (r.name as string) || '';
      // No performer passed, meaning the record's own creator: both KPIs judge
      // the job card itself, and whoever opened it is who should have tagged it.
      // Odoo keeps no author for a tag, so there is no other signal and none is
      // invented.
      if (on(5)) push(5, r, tagged, ref);
      if (on(8) && presenceLive) push(8, r, hasAnyTag(r, presence), ref);
    }

    if (on(8) && !presenceLive) {
      notes.push('Car in / out tag is inactive — no CAR-IN / CAR-OUT tags were found in either tag field. Pick them under "Car in / out tags" in Admin → KPI Configuration.');
    }

    // RO volume per SA (used for the "N ROs this week" badge).
    for (const r of weekROs) {
      const uid = m2o(r.create_uid)?.[0];
      const cid = m2o(r.company_id)?.[0];
      if (uid != null && cid != null && idToBranch[cid]) roCountByUser[uid] = (roCountByUser[uid] ?? 0) + 1;
    }
  }

  // ── KPI 2 — quotation approval within the configured business hours ──
  if (on(2)) {
    const limitMs = businessHours(thresholds.quoteApprovalHours ?? 48);
    // The open population needs a time bound. This query filtered on state and
    // company only — no date window at all — so every draft quotation ever
    // written was re-scored every week, forever: a two-year-old abandoned quote
    // from a departed advisor failed this week, next week and every week until
    // somebody confirmed it. And because the open clock runs to `now`, selecting
    // a PAST week still judged today's drafts against today's clock, so last
    // month's report changed every time the backlog grew.
    //
    // The bound is snapshotBaselineDays, the window KPIs 6 and 7 already use for
    // exactly this job, rather than a new knob nobody would know to set. A draft
    // older than that is treated as dead, not as pending.
    //
    // Read from the same resolved number KPI 2's ⓘ tooltip prints, so the bound
    // the page describes and the bound the query applies cannot drift apart.
    const openBaselineDays = baselineDaysNote;
    const openSinceIso = new Date(now - openBaselineDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    // (a) Still-open quotations: compliant while they're inside the window.
    const open = (await call('sale.order', 'search_read', [[
      ['state', 'in', ['draft', 'sent']],
      ['create_date', '>=', openSinceIso],
      ['company_id', 'in', kpiIds],
    ]], { fields: ['name', 'create_uid', 'company_id', 'create_date'], limit: 0 })) as Rec[];
    // Counted, not scored — the page has to be able to say how big the dead
    // backlog is. Null if the count itself failed, so the note can say so rather
    // than print a zero it did not establish.
    let staleOpen: number | null = null;
    try {
      staleOpen = (await call('sale.order', 'search_count', [[
        ['state', 'in', ['draft', 'sent']],
        ['create_date', '<', openSinceIso],
        ['company_id', 'in', kpiIds],
      ]])) as number;
    } catch { staleOpen = null; }
    // (b) Quotations confirmed during the week: was approval inside the window?
    // Deliberately NOT bounded the same way: approval is an event that happened
    // inside the scored week, so however old the quotation was, the measurement
    // is of something that really did take that long.
    const confirmed = (await call('sale.order', 'search_read', [[
      ['state', 'in', ['sale', 'done']],
      ['date_order', '>=', wStart], ['date_order', '<', wEnd],
      ['company_id', 'in', kpiIds],
    ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', 'date_order'], limit: 0 })) as Rec[];

    // Both repair.order lookups below ask about the same quotations, so the id
    // list is built once and shared.
    const soIds = [...new Set([...open, ...confirmed].map((q) => q.id as number))];

    // Insurance jobs are exempt: approval is the insurer's to give, so holding an
    // advisor to the approval clock measures the insurer, not them. Resolved from the
    // repair order behind each quotation, across both tag fields.
    //
    // This lookup deliberately does NOT exclude historical orders. It asks a
    // question of fact — was this an insurance job — and that stays true after
    // the order is moved to Historical. Filtering here would quietly revoke the
    // exemption and start charging advisors for the insurer's delay.
    const insuranceExempt = new Set<number>();
    const insuranceTags = await resolveTagMatches(config.stageMap.insuranceTags?.values ?? [], meta, INSURANCE_TAG_RE);
    if (insuranceTags.some((m) => m.ids.size) && has('sale_order_id')) {
      for (let i = 0; i < soIds.length; i += 2000) {
        try {
          const insured = (await call('repair.order', 'search_read', [[
            ['sale_order_id', 'in', soIds.slice(i, i + 2000)],
            ...anyTagDomain(insuranceTags),   // keep the OR-block last; it is prefix notation
          ]], { fields: ['sale_order_id'], limit: 0 })) as Rec[];
          for (const r of insured) {
            const id = m2o(r.sale_order_id)?.[0];
            if (id != null) insuranceExempt.add(id);
          }
        } catch { /* leave this chunk unexempted rather than dropping the KPI */ }
      }
    }

    // Only quotations attached to a job card in the Orders tab are scored.
    const { out: outOfScope, unchecked } = await quotationsOutOfScope(soIds);

    // Who confirmed each quotation that was confirmed this week. The open ones
    // have no confirmation yet by definition, so they are not asked about — and
    // asking would cost a read for an answer that cannot exist.
    await loadQuotationConfirmers(confirmed.map((q) => q.id as number));
    /**
     * The performer: whoever confirmed the quotation, or whoever wrote it.
     *
     * `undefined` is returned for the fallback rather than the creator being
     * looked up again, because push()'s default subject is this record's
     * create_uid and this record IS the quotation — the two are the same person
     * by construction, and naming them twice invites the two copies to drift.
     */
    const approverOf = (q: Rec): Performer | undefined =>
      confirmerBySo.get(q.id as number) ?? undefined;

    let historicalSkipped = 0;
    for (const q of open) {
      if (insuranceExempt.has(q.id as number)) continue;
      if (outOfScope.has(q.id as number)) { historicalSkipped++; continue; }
      const created = odooTime(q.create_date);
      if (created == null) continue;
      // Still open, so the clock is still running — on business time, or a
      // quotation raised on Thursday would fail over a weekend nobody worked.
      // Nothing has been confirmed, so the quotation's author carries it: the
      // thing being measured is their quotation sitting unapproved.
      push(2, q, elapsed(created, now) <= limitMs, (q.name as string) || '');
    }
    let outOfOrder = 0;
    for (const q of confirmed) {
      if (insuranceExempt.has(q.id as number)) continue;
      if (outOfScope.has(q.id as number)) { historicalSkipped++; continue; }
      const created = odooTime(q.create_date);
      const approved = odooTime(q.date_order);
      if (created == null || approved == null) continue;
      // date_order is editable in Odoo, so it can be set earlier than the
      // quotation was created. A negative interval clamps to zero elapsed and
      // would read as instant approval.
      const took = measured(created, approved);
      if (took == null) { outOfOrder++; continue; }
      push(2, q, took <= limitMs, (q.name as string) || '', approverOf(q));
    }
    notes.push(staleOpen == null
      ? `Quote approval now scores only quotations created in the last ${openBaselineDays} days. Older ones that are still open are excluded — a draft nobody has confirmed after that long is treated as dead rather than as still pending, instead of failing this KPI every week forever. How many were excluded could not be counted this time. The window is the "Awaiting parts / labour baseline window" under Admin → KPI Configuration, shared with KPIs 6 and 7.`
      : `Quote approval now scores only quotations created in the last ${openBaselineDays} days, and excluded ${staleOpen} older open quotation${staleOpen === 1 ? '' : 's'} — a draft nobody has confirmed after that long is treated as dead rather than as still pending, instead of failing this KPI every week forever and making a past week's report change as the backlog grew. Quotations APPROVED this week are still counted however old they were, because that approval really did take that long. The window is the "Awaiting parts / labour baseline window" under Admin → KPI Configuration, shared with KPIs 6 and 7.`);
    if (outOfOrder) {
      notes.push(`Quote approval left ${outOfOrder} quotation${outOfOrder === 1 ? '' : 's'} unjudged whose approval is dated before the quotation was created — the order date is editable in Odoo, so the two stamps cannot both be right and the time taken is not measurable. ${outOfOrder === 1 ? 'It was' : 'They were'} reading as approved instantly.`);
    }
    if (insuranceExempt.size) {
      notes.push(`Quote approval excluded ${insuranceExempt.size} insurance quotation${insuranceExempt.size === 1 ? '' : 's'} — approval there is the insurer's to give.`);
    }
    if (historicalSkipped) {
      notes.push(`Quote approval now counts only quotations attached to a job card in the Orders tab, and excluded ${historicalSkipped} quotation${historicalSkipped === 1 ? '' : 's'} that ${historicalSkipped === 1 ? 'is' : 'are'} not: either every repair order behind ${historicalSkipped === 1 ? 'it' : 'them'} has been moved to Historical, or ${historicalSkipped === 1 ? 'it is' : 'they are'} not workshop work at all — a counter parts sale or a retail order carries no job card. The figure moves because the scope narrowed, not because approval got slower.`);
    }
    if (unchecked) {
      notes.push(`Quote approval could not check ${unchecked} quotation${unchecked === 1 ? '' : 's'} against ${unchecked === 1 ? 'its' : 'their'} repair orders — the check could not be run, so ${unchecked === 1 ? 'it is' : 'they are'} still scored rather than dropped from the figure on the strength of a check that did not happen.`);
    }
  }

  // ── KPI 21 — quotation approval rate ──
  //
  // A rate, not a stopwatch: there is no limit and no tri-state, so every
  // quotation raised this week is counted, approved or not.
  if (on(21)) {
    const quotes = (await call('sale.order', 'search_read', [[
      ['create_date', '>=', wStart], ['create_date', '<', wEnd],
      ['company_id', 'in', kpiIds],
    ]], { fields: ['name', 'create_uid', 'company_id', 'state'], limit: 0 })) as Rec[];

    // Same scope rule as Quote approval — only quotations attached to a job card
    // in the Orders tab are scored. This is also what keeps counter parts sales
    // and retail orders out of the rate: they carry no repair order, and they
    // were approved on the spot, so they read as a near-perfect approval rate
    // for work no advisor was ever being judged on.
    const { out: outOfScope, unchecked } = await quotationsOutOfScope(quotes.map((q) => q.id as number));
    let historicalSkipped = 0;
    const byState: Record<string, number> = {};
    for (const q of quotes) {
      if (outOfScope.has(q.id as number)) { historicalSkipped++; continue; }
      const st = String(q.state ?? 'unknown');
      byState[st] = (byState[st] ?? 0) + 1;
      // Confirmed into a sale order is what "the customer approved it" looks like.
      // No performer passed, meaning this record's creator: the rate is about the
      // quotations a person raised and how many of them the customer took, so the
      // quotation's author is the subject — not whoever confirmed it, and not
      // whoever opened the job card behind it.
      push(21, q, st === 'sale' || st === 'done', (q.name as string) || '');
    }
    notes.push('Quotation approval rate (KPI 21) counts the quotations CREATED this week: Odoo records no reliable moment a quotation was sent, so creation stands in for sending and the denominator is quotations created, not quotations sent.');
    // Drafts stay in the denominator on purpose. The appendix says "approved over
    // sent", but this instance never uses Send by Email, so an unapproved
    // quotation sits in draft for good and dropping drafts would leave only the
    // approved ones — a silent 100%. The breakdown below is printed so the shape
    // of the week is visible: in a week still running, its newest quotations are
    // simply undecided and the rate reads low for that reason alone, which is why
    // the figure settles upward as the week closes.
    if (Object.keys(byState).length) {
      const order = ['draft', 'sent', 'sale', 'done', 'cancel'];
      const parts = Object.entries(byState)
        .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
        .map(([st, n]) => `${st} ${n}`);
      notes.push(`Quotation approval rate — this week's quotations by state: ${parts.join(' \u00b7 ')}.`);
    }
    if (historicalSkipped) {
      notes.push(`Quotation approval rate now counts only quotations attached to a job card in the Orders tab, and excluded ${historicalSkipped} quotation${historicalSkipped === 1 ? '' : 's'} that ${historicalSkipped === 1 ? 'is' : 'are'} not: either every repair order behind ${historicalSkipped === 1 ? 'it' : 'them'} has been moved to Historical, or ${historicalSkipped === 1 ? 'it is' : 'they are'} not workshop work at all — counter parts sales and retail orders carry no job card and were approved on the spot, which lifted this rate for work nobody here is scored on. Expect the figure to move for that reason rather than because the week changed.`);
    }
    if (unchecked) {
      notes.push(`Quotation approval rate could not check ${unchecked} quotation${unchecked === 1 ? '' : 's'} against ${unchecked === 1 ? 'its' : 'their'} repair orders — the check could not be run, so ${unchecked === 1 ? 'it is' : 'they are'} still counted rather than dropped from the rate on the strength of a check that did not happen.`);
    }
  }

  // ── KPI 9 — weekly closure rate (closed ÷ received) ──
  if (on(9)) {
    const received = (await call('repair.order', 'search_read', [weekDomain], {
      fields: ['name', 'create_uid', 'company_id'], limit: 0,
    })) as Rec[];

    const tfClosed = trackedField(config.stageMap.closed, meta, stageNames);
    const closedThisWeek = tfClosed
      ? await roIdsEnteringStateInWindow(tfClosed.field, tfClosed.labels, wStart, wEnd)
      : noTransitions();
    let closedSet = new Set(Object.keys(closedThisWeek.at).map(Number));

    if (!closedSet.size) {
      // No chatter history — fall back to "created this week and closed now".
      const nowClosed = (await call('repair.order', 'search_read', [[
        ...selectorDomain(config.stageMap.closed), ...weekDomain,
      ]], { fields: ['id'], limit: 0 })) as Rec[];
      closedSet = new Set(nowClosed.map((r) => r.id as number));
    }

    // No performer, deliberately: a closure rate is a property of the week's
    // intake, not an act anybody performs. Charging it to whoever opened each job
    // card made a branch's throughput into one advisor's score. It carries no
    // owner either (BRANCH_ONLY_KPI_IDS), so it is never shared out at roll-up
    // and reaches no individual card at all — it stays a branch reading.
    for (const r of received) push(9, r, closedSet.has(r.id as number), (r.name as string) || '', null);
  }

  // ── KPIs 12, 14, 15 & 16 — the workshop stage clock ──
  //
  // All four hang off chatter transitions into Inspection / QA, so an RO that has
  // long since moved on is still measured for the week it passed through.
  //
  // Each is tri-state, which is what keeps them honest: judged once the next
  // milestone lands, failed once the window elapses without it, and left
  // unjudged while the clock is still legitimately running.
  const tfInspection = trackedField(config.stageMap.inspection, meta, stageNames);
  // tfQa is resolved before the first KPI block: KPI 13's population is now the
  // same QA transition KPI 16 times its dwell from, so both read one definition.

  if ((on(12) || on(14) || on(15)) && !tfInspection) {
    notes.push('Check-in, inspection and quote-after-inspection need the Inspection state mapped in Admin → KPI Configuration.');
  }
  if (on(16) && !tfQa) {
    notes.push('QA duration needs the QA state mapped in Admin → KPI Configuration.');
  }

  // How much history the stage KPIs actually have to work with.
  const stageField = tfInspection?.field ?? tfQa?.field;
  const trackedFrom = stageField ? await trackingStartedAt('repair.order', stageField) : null;
  if (trackedFrom != null && now - trackedFrom < 30 * 86400_000) {
    const days = (now - trackedFrom) / 86400_000;
    notes.push(`Stage tracking has only ${days < 1 ? `${Math.round(days * 24)} hours` : `${days.toFixed(1)} days`} of history (since ${new Date(trackedFrom).toISOString().slice(0, 10)}). A stage cannot yet show an overrun longer than that, so Inspection and QA will read high until the history outgrows their limits.`);
  }

  // KPI 14 — check-in is complete when the RO reaches Inspection.
  if (on(14) && tfInspection) {
    const limitMs = businessHours(thresholds.checkInHours ?? 3);
    const weekROs = (await call('repair.order', 'search_read', [weekDomain], {
      fields: ['name', 'create_uid', 'company_id', 'create_date'], limit: 0,
    })) as Rec[];
    // Full stage history, not just the Inspection hits, so a silent RO can be told
    // apart from one that genuinely skipped check-in.
    const timeline = await stateTimeline(weekROs.map((r) => r.id as number), tfInspection.field);
    // Performed by whoever moved the car into Inspection — check-in is that
    // transition, and the chatter names its author. Captured by the timeline read
    // that was already running, so the only cost is one bulk partner→user lookup,
    // itself shared with the other stage KPIs.
    await loadAuthors(Object.values(timeline).flatMap((events) => events.map((e) => e.author)));

    let unobserved = 0, judged = 0, outOfOrder = 0, noMover = 0;
    for (const r of weekROs) {
      const roAt = odooTime(r.create_date);
      if (roAt == null) continue;
      const ref = (r.name as string) || '';
      const events = timeline[r.id as number] ?? [];
      const hits = events.filter((e) => tfInspection.labels.includes(e.label));

      if (hits.length) {
        // FIRST arrival is the check-in. A chatter entry dated before the job
        // card itself cannot time it, so that pair is not measurable.
        const took = measured(roAt, hits[0].t);
        if (took == null) { outOfOrder++; continue; }
        judged++;
        const movedBy = authorPerformer(hits[0].author);
        if (!movedBy) noMover++;
        push(14, r, took <= limitMs, ref, movedBy);
        continue;
      }
      // No Inspection on record. Only a failure if we have some other stage change
      // for this RO — that proves tracking was live and it really did skip check-in.
      if (!events.length) { unobserved++; continue; }
      // Business time while the clock runs, so an RO raised at closing is not
      // failed by the night it sat through.
      // Nobody checked this car in, so there is nobody who performed it: the
      // verdict names no one rather than falling to whoever opened the job card.
      if (elapsed(roAt, now) > limitMs) { judged++; push(14, r, false, ref, null); }
    }
    if (noMover) {
      notes.push(`Check-in after RO could not identify who moved ${noMover} repair order${noMover === 1 ? '' : 's'} into Inspection — the chatter author is not an internal Odoo user, or could not be read. ${noMover === 1 ? 'That verdict names' : 'Those verdicts name'} nobody and ${noMover === 1 ? 'is' : 'are'} shared across this KPI's owners in the branch.`);
    }
    if (unobserved) {
      notes.push(`Check-in ignored ${unobserved} of ${weekROs.length} ROs with no stage history at all — they moved before tracking was switched on, so their check-in was never recorded. Judged ${judged}.`);
    }
    if (outOfOrder) {
      notes.push(`Check-in after RO left ${outOfOrder} RO${outOfOrder === 1 ? '' : 's'} unjudged whose first Inspection entry is dated before the repair order was created — the two stamps cannot both be right, so the time taken is not measurable and is not read as a pass.`);
    }
  }

  // KPIs 15 & 12 — inspection start → quotation created. Same measurement, two
  // business-hour windows: 15 is how long inspection itself may run, 12 is the
  // tighter promise on getting the quote out.
  if ((on(12) || on(15)) && tfInspection && has('sale_order_id')) {
    const entered = await roIdsEnteringStateInWindow(tfInspection.field, tfInspection.labels, wStart, wEnd);
    const ids = Object.keys(entered.at).map(Number);
    if (!ids.length) {
      notes.push(`No repair order entered "${tfInspection.labels.join('/')}" during this week according to the chatter — inspection and quote-after-inspection have nothing to measure.`);
    }

    if (ids.length) {
      // Ids come from the chatter, so the historical ones have to be dropped here.
      const ros = ((await call('repair.order', 'read', [ids], {
        fields: ['name', 'create_uid', 'company_id', 'sale_order_id', ...histField],
      })) as Rec[]).filter((r) => !isHistorical(r));

      const soIds = [...new Set(ros.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))];
      const soCreated: Record<number, number> = {};
      /** Quotation → who wrote it. KPI 12 is that person's promise, nobody else's. */
      const soAuthor: Record<number, Performer> = {};
      let quotesUnreadable = false;
      if (soIds.length) {
        try {
          // create_uid costs nothing extra on a read that already runs.
          const sos = (await call('sale.order', 'read', [soIds], { fields: ['create_date', 'create_uid'] })) as Rec[];
          for (const so of sos) {
            const t = odooTime(so.create_date);
            if (t != null) soCreated[so.id as number] = t;
            const u = m2o(so.create_uid);
            if (u) soAuthor[so.id as number] = { id: u[0], name: u[1] };
          }
        } catch {
          // The tri-state below does NOT catch this — it reads a missing entry as
          // "still unquoted" and fails everything past the limit. An unreadable
          // read has to be tracked separately or one lost RPC fails both KPIs.
          quotesUnreadable = true;
        }
      }

      // One measurement, two different performers — which is why the resolver is
      // a parameter rather than something judgeQuoteTiming decides for itself.
      //
      // KPI 15 asks how long the inspection ran, and that is the inspector's: the
      // person who moved the car into Inspection, read from the chatter author of
      // the very transition the clock starts at. KPI 12 asks whether a quotation
      // reached the customer in time, and that is whoever wrote the quotation.
      // Both used to be charged to the repair order's creator, who in general did
      // neither.
      await loadAuthors(Object.values(entered.by));
      let noInspector = 0;
      const inspectedBy = (r: Rec): Performer | null => {
        const who = authorPerformer(entered.by[r.id as number]);
        if (!who) noInspector++;        // counted only for KPI 15, its only caller
        return who;
      };
      // Null when there is no quotation yet: nobody has performed the act KPI 12
      // measures, so the verdict names nobody rather than the job card's owner.
      const quotedBy = (_r: Rec, soId: number | null): Performer | null =>
        (soId != null ? soAuthor[soId] ?? null : null);

      const judgeQuoteTiming = (
        kpiId: number,
        limitMs: number,
        label: string,
        performedBy: (r: Rec, soId: number | null) => Performer | null,
      ) => {
        let outOfOrder = 0;
        for (const r of ros) {
          const from = entered.at[r.id as number];
          if (from == null) continue;
          const ref = (r.name as string) || '';
          const soId = m2o(r.sale_order_id)?.[0] ?? null;
          // A quotation we could not read is not a quotation that was never
          // raised. An RO with no quotation linked at all is still judged — that
          // fact came from the repair order, which read fine.
          if (soId != null && quotesUnreadable) continue;
          const quotedAt = soId != null ? soCreated[soId] : undefined;
          if (quotedAt != null) {
            // `from` is now the first Inspection entry inside this week, so a
            // quotation dated before it was not raised for this inspection —
            // typically the re-inspection case, where the quote belongs to the
            // first pass. A negative interval clamped to zero used to pass every
            // one of them, which is how an unquoted re-inspection became
            // impossible to fail.
            const took = measured(from, quotedAt);
            if (took == null) { outOfOrder++; continue; }
            push(kpiId, r, took <= limitMs, ref, performedBy(r, soId));
          }
          // The unquoted clock runs on business time as well — otherwise the
          // weekend, not the workshop, decides the overrun.
          else if (elapsed(from, now) > limitMs) push(kpiId, r, false, ref, performedBy(r, null));  // still unquoted, window gone
        }
        if (outOfOrder) {
          notes.push(`${label} left ${outOfOrder} repair order${outOfOrder === 1 ? '' : 's'} unjudged whose quotation was created before the inspection it is timed from — the quotation belongs to an earlier pass through Inspection, so there is no interval to measure here. ${outOfOrder === 1 ? 'It used' : 'They used'} to read as quoted instantly, which is how a re-inspection that was never re-quoted could not fail.`);
        }
      };

      if (on(15)) judgeQuoteTiming(15, businessHours(thresholds.inspectionHours ?? 27), 'Inspection duration', inspectedBy);
      if (on(15) && noInspector) {
        notes.push(`Inspection duration could not identify who moved ${noInspector} repair order${noInspector === 1 ? '' : 's'} into Inspection — the chatter author is not an internal Odoo user, or could not be read. ${noInspector === 1 ? 'That verdict names' : 'Those verdicts name'} nobody and ${noInspector === 1 ? 'is' : 'are'} shared across this KPI's owners in the branch rather than charged to whoever opened the job card.`);
      }
      if (on(12)) judgeQuoteTiming(12, businessHours(thresholds.quoteSentHours ?? 4), 'Quote sent to customer', quotedBy);
      if (quotesUnreadable) {
        const skipped = ros.filter((r) => m2o(r.sale_order_id)?.[0] != null).length;
        notes.push(`Inspection duration and Quote sent to customer left ${skipped} repair order${skipped === 1 ? '' : 's'} unjudged — their quotations could not be read from Odoo, so an RO still waiting for a quote cannot be told apart from one whose quote we failed to fetch. Repair orders with no quotation linked at all are still counted.`);
      }
    }
  }

  // KPI 16 — how long the RO actually sat in QA.
  if (on(16) && tfQa) {
    const limitMs = businessHours(thresholds.qaHours ?? 9);
    const entered = await roIdsEnteringStateInWindow(tfQa.field, tfQa.labels, wStart, wEnd);
    const ids = Object.keys(entered.at).map(Number);
    if (!ids.length) {
      notes.push(`No repair order entered "${tfQa.labels.join('/')}" during this week according to the chatter — QA duration has nothing to measure.`);
    }

    if (ids.length) {
      // Ids come from the chatter, so the historical ones have to be dropped here.
      const ros = ((await call('repair.order', 'read', [ids], {
        fields: ['name', 'create_uid', 'company_id', ...histField],
      })) as Rec[]).filter((r) => !isHistorical(r));
      const timeline = await stateTimeline(ids, tfQa.field);
      // The population is window-scoped — these ROs entered QA during the week
      // on screen — but the timeline scan was not, so it took the last QA
      // arrival in ALL of history. A week-45 overrun was unreachable while a
      // week-47 dwell was scored into week 45. The scan is bounded to the same
      // week the population came from.
      const weekFromMs = odooTime(wStart) ?? -Infinity;
      const weekToMs = odooTime(wEnd) ?? Infinity;
      // Performed by whoever moved the car through QA: the chatter author of the
      // QA entry this dwell is timed from. Both the timeline and the windowed
      // lookup already carry that author, so nothing extra is read from Odoo.
      await loadAuthors([
        ...Object.values(entered.by),
        ...Object.values(timeline).flatMap((events) => events.map((e) => e.author)),
      ]);

      let outOfOrder = 0, noMover = 0;
      for (const r of ros) {
        const ref = (r.name as string) || '';
        const events = timeline[r.id as number] ?? [];
        // The FIRST arrival in QA inside the scored week, and whatever state
        // change followed it.
        let enterIdx = -1;
        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          if (!tfQa.labels.includes(e.label)) continue;
          if (e.t < weekFromMs || e.t >= weekToMs) continue;
          enterIdx = i;
          break;
        }
        // Falls back to the windowed chatter lookup, which is already the
        // earliest QA arrival inside the week, when the full timeline is
        // unreadable. Then there is no "left" to pair with it and the record
        // runs on the open-ended clock below.
        const from = enterIdx >= 0 ? events[enterIdx].t : entered.at[r.id as number];
        if (from == null) continue;
        const left = enterIdx >= 0 && enterIdx + 1 < events.length ? events[enterIdx + 1].t : null;
        // Read off the same QA entry `from` came from, whichever source supplied
        // it, so the dwell and the person always describe one event.
        const movedBy = authorPerformer(enterIdx >= 0 ? events[enterIdx].author : entered.by[r.id as number]);
        if (!movedBy) noMover++;

        if (left != null) {
          // Both stamps come from one ascending timeline, with `left` the very
          // next entry, so this cannot go negative. Routed through the guard all
          // the same: the invariant is the check, not the assumption.
          const took = measured(from, left);
          if (took == null) { outOfOrder++; continue; }
          push(16, r, took <= limitMs, ref, movedBy);
        }
        // Still in QA: business time only, so an overnight wait is not an overrun.
        else if (elapsed(from, now) > limitMs) push(16, r, false, ref, movedBy);  // still in QA, over the limit
      }
      if (outOfOrder) {
        notes.push(`QA duration left ${outOfOrder} repair order${outOfOrder === 1 ? '' : 's'} unjudged whose QA exit is recorded before its QA entry — the two stamps cannot both be right, so the dwell is not measurable and is not read as a pass.`);
      }
      if (noMover) {
        notes.push(`QA duration could not identify who moved ${noMover} repair order${noMover === 1 ? '' : 's'} through QA — the chatter author is not an internal Odoo user, or could not be read. ${noMover === 1 ? 'That verdict names' : 'Those verdicts name'} nobody and ${noMover === 1 ? 'is' : 'are'} shared across this KPI's owners in the branch rather than charged to whoever opened the job card.`);
      }
    }
  }

  // ── KPIs 18, 19 & 20 — the parts-purchasing chain ──
  //
  // RFQ raised → RFQ confirmed → parts on the shelf. All three read
  // purchase.order, so one fields_get decides what this instance can answer and
  // an uninstalled purchasing module degrades to a note instead of throwing the
  // whole tree away.
  if (on(18) || on(19) || on(20)) {
    const poMeta = await readFieldsMeta('purchase.order');
    if (!poMeta) {
      notes.push('purchase.order could not be read on this instance, so the RFQ and parts-placement KPIs (18, 19 & 20) were skipped.');
    } else {
      const poHas = (f: string) => Object.prototype.hasOwnProperty.call(poMeta, f);
      // Not yet committed to: an RFQ anybody could still walk away from. Note the
      // space in 'to approve' — that is the stored value, not a label.
      const RFQ_STATES = ['draft', 'sent', 'to approve'];
      const CONFIRMED_STATES = ['purchase', 'done'];
      /** purchase.order dates are datetimes on some versions and plain dates on others. */
      const poTime = (raw: unknown): number | null => {
        if (typeof raw !== 'string' || !raw) return null;
        if (raw.length > 10) return odooTime(raw);
        const t = Date.parse(`${raw}T00:00:00Z`);
        return Number.isNaN(t) ? null : t;
      };

      // ── The job card a purchase belongs to — shared by KPIs 19 and 20 ──
      //
      // The owner's rule for this whole section: "ignore orders in the historical
      // orders tab. We are starting fresh, so only read orders and their
      // quotations and invoices which are in the orders tab." A purchase order
      // carries no link back to a repair order, so the vehicle is the only route
      // to the job card it was bought for — and both KPIs must take that route
      // the same way, or the chain is back to measuring two populations under one
      // heading. One lookup, two moments: creation for 19, confirmation for 20.
      type Job = {
        id: number; created: number; lines: number[];
        closedNow: boolean; closedAt: number | null; statusSince: number | null;
      };
      const tfClosed = trackedField(config.stageMap.closed, meta, stageNames);
      // status_since is a stored datetime holding when the vehicle entered its
      // CURRENT status, so for a job whose current status is closed it is the
      // closure moment — no chatter required. Guarded because asking Odoo for a
      // field it does not have fails the whole read.
      const statusSinceField = has('status_since') ? 'status_since' : undefined;

      /**
       * Was this job card still open at `at`? 'unknown' means closed now with no
       * datable closure, which is a different fact from "closed before `at`" and
       * is counted and disclosed separately by the callers.
       *
       * "Closed now" says nothing about last week on its own, so the closure has
       * to be dated. status_since answers it from a stored field; the chatter is
       * only the fallback, because on this instance Closed is mapped to
       * priority_matrix_status, which carries no tracked changes at all — so
       * relying on the chatter alone dated no closure whatsoever and dropped
       * every purchase whose job has since closed. That is not a neutral loss: a
       * job that got its parts is exactly the job that closes, and a job still
       * waiting is exactly the one that stays open, so it would have judged both
       * KPIs almost entirely on the slow work and read materially worse than
       * reality. A bias toward failure is the one direction a KPI the CEO fines
       * on must not have.
       */
      const openAt = (job: Job, at: number): 'open' | 'closed' | 'unknown' =>
        !job.closedNow ? 'open'
          : job.closedAt == null ? 'unknown'
          : job.closedAt > at ? 'open' : 'closed';

      /**
       * Every non-historical job card for these vehicles, oldest first, with
       * enough state to answer openAt. `lineField` is only asked for by KPI 20,
       * which judges a purchase against the whole job card's parts.
       */
      const jobsForFleets = async (fleetIds: number[], lineField?: string): Promise<Record<number, Job[]>> => {
        const jobsByFleet: Record<number, Job[]> = {};
        const byId = new Map<number, Job>();
        for (let i = 0; i < fleetIds.length; i += 2000) {
          try {
            const ros = (await call('repair.order', 'search_read', [[
              ['fleet_id', 'in', fleetIds.slice(i, i + 2000)],
              ['create_date', '<', wEnd],
              ...notHist,
            ]], {
              // status_since rides along on the query that was already running,
              // so dating the closures costs no extra call to Odoo.
              fields: [
                'fleet_id', 'create_date',
                ...(statusSinceField ? [statusSinceField] : []),
                ...(lineField ? [lineField] : []),
              ],
              limit: 0,
            })) as Rec[];
            for (const r of ros) {
              const fleet = m2o(r.fleet_id)?.[0];
              const created = odooTime(r.create_date);
              if (fleet == null || created == null) continue;
              const job: Job = {
                id: r.id as number,
                created,
                lines: lineField ? ((r[lineField] as number[] | undefined) ?? []) : [],
                closedNow: false,
                closedAt: null,
                statusSince: statusSinceField ? odooTime(r[statusSinceField]) : null,
              };
              (jobsByFleet[fleet] ??= []).push(job);
              byId.set(job.id, job);
            }
          } catch { /* this chunk's vehicles stay unlinked rather than dropping the KPI */ }
        }

        // Which of them are closed today. Asked as its own query so the Closed
        // mapping stays the single definition of closed, whichever field it names.
        const ids = [...byId.keys()];
        for (let i = 0; i < ids.length; i += 2000) {
          try {
            const closed = (await call('repair.order', 'search_read', [[
              ['id', 'in', ids.slice(i, i + 2000)],
              ...selectorDomain(config.stageMap.closed),
            ]], { fields: ['id'], limit: 0 })) as Rec[];
            for (const r of closed) {
              const job = byId.get(r.id as number);
              if (job) job.closedNow = true;
            }
          } catch { /* a failed chunk leaves its job cards reading as open, which is the looser behaviour this read replaced — a lost RPC must not narrow a scored population */ }
        }

        // When the closed ones closed. status_since is the primary source: it is
        // stored on the record, so it answers for every closed job card without
        // depending on a field anyone remembered to track.
        //
        // It holds the LATEST status change, so a job that moved status again
        // after closing carries a stamp later than its true closure. That errs
        // toward reading the job as still open at the purchase moment, which is
        // the fair direction here — the purchase keeps its job card and stays
        // judged — so it is accepted rather than corrected for.
        const closed = [...byId.values()].filter((j) => j.closedNow);
        for (const job of closed) job.closedAt = job.statusSince;

        // Chatter only for the leftovers: closed, but status_since was empty.
        // Where the field answered, this read is not made at all.
        const undatedIds = closed.filter((j) => j.closedAt == null).map((j) => j.id);
        if (undatedIds.length && tfClosed) {
          // Only the clock is wanted here — this answers "was the job still open
          // when the parts were ordered", which nobody is scored for.
          const closedAt = await stateEntryTimes(undatedIds, tfClosed.field, tfClosed.labels);
          for (const [id, t] of Object.entries(closedAt.at)) {
            const job = byId.get(Number(id));
            // Guarded: status_since already won wherever it had a value.
            if (job && job.closedAt == null) job.closedAt = t;
          }
        }

        for (const list of Object.values(jobsByFleet)) list.sort((a, b) => a.created - b.created);
        return jobsByFleet;
      };

      /**
       * The job this purchase order was bought for: the newest live repair order
       * already open at `at`. Matching on the vehicle alone would just as happily
       * pick a visit from two years ago.
       *
       * `closedOut` and `undated` separate the three ways of finding nothing —
       * this vehicle has no job card in the Orders tab at all; it has some, but
       * every one of them had already closed by `at`; or it has some that are
       * closed with no closure moment on record either way. The third is the one
       * to watch: it is the only case where a purchase is dropped for want of
       * data rather than for being out of scope, so the callers count and
       * disclose it on its own.
       */
      const jobFor = (
        jobsByFleet: Record<number, Job[]>, fleet: number | null, at: number,
      ): { job: Job | null; closedOut: boolean; undated: boolean } => {
        if (fleet == null) return { job: null, closedOut: false, undated: false };
        let best: Job | null = null;
        let closedOut = false;
        let undated = false;
        for (const job of jobsByFleet[fleet] ?? []) {
          if (job.created > at) break;   // ascending, so nothing later can qualify
          const verdict = openAt(job, at);
          if (verdict === 'open') { best = job; continue; }
          if (verdict === 'closed') closedOut = true; else undated = true;
        }
        // A job was found, so neither reason cost this purchase anything.
        return { job: best, closedOut: best == null && closedOut, undated: best == null && undated };
      };

      // ── KPI 18 — RFQ raised within N days of the quotation being approved ──
      if (on(18)) {
        const limitMs = (thresholds.rfqAfterApprovalDays ?? 1) * 86400_000;
        if (!has('is_parts_available')) {
          // Without the flag every approved quotation looks like it needed parts,
          // so the KPI would charge branches for RFQs they never had to raise.
          notes.push('repair.order has no "All Parts are available" field, so RFQ after approval (KPI 18) was skipped — judging every approved quotation would charge for RFQs that were never needed.');
        } else if (!has('sale_order_id') || !has('fleet_id') || !poHas('fleet_id')) {
          notes.push('RFQ after approval (KPI 18) needs sale_order_id and fleet_id on repair.order and fleet_id on purchase.order — one of them is missing on this instance.');
        } else {
          // Approval is the same signal KPI 3 uses: date_order is the moment Odoo
          // confirms a quotation into a sale order.
          let approvedSos: Rec[] = [];
          try {
            approvedSos = (await call('sale.order', 'search_read', [[
              ['state', 'in', ['sale', 'done']],
              ['date_order', '>=', wStart], ['date_order', '<', wEnd],
              ['company_id', 'in', kpiIds],
            ]], { fields: ['date_order'], limit: 0 })) as Rec[];
          } catch {
            notes.push('RFQ after approval (KPI 18) could not read the approved quotations for this week.');
          }
          const approvedAt: Record<number, number> = {};
          for (const so of approvedSos) {
            const t = odooTime(so.date_order);
            if (t != null) approvedAt[so.id as number] = t;
          }
          const soIds = Object.keys(approvedAt).map(Number);

          // Only orders still short of parts are in scope — the rest never needed
          // an RFQ, so holding them to one measures nothing.
          const ros: Rec[] = [];
          for (let i = 0; i < soIds.length; i += 2000) {
            try {
              ros.push(...(await call('repair.order', 'search_read', [[
                ['sale_order_id', 'in', soIds.slice(i, i + 2000)],
                ['is_parts_available', '=', false],
                ['company_id', 'in', kpiIds],
                ...notHist,
              ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', 'sale_order_id', 'fleet_id'], limit: 0 })) as Rec[]);
            } catch { /* a failed chunk leaves its orders unjudged rather than failing the KPI */ }
          }

          // When each vehicle had a purchase order raised against it. Every state
          // counts: a draft — or even a later cancelled — RFQ was still raised.
          const fleetIds = [...new Set(ros.map((r) => m2o(r.fleet_id)?.[0]).filter((x): x is number => x != null))];
          // When, and by whom. The raiser is read off the same purchase order
          // rows as the timestamp, so this KPI's performer costs no extra call.
          const rfqTimes: Record<number, { t: number; by: Performer | null }[]> = {};
          // This query carried no company filter at all while 19 and 20 were
          // both scoped, so an RFQ raised through an uncounted company still
          // satisfied KPI 18 — 18 read high on purchasing the other two could not
          // see. The scope is now the same five companies, applied here in JS
          // rather than in the domain purely so the rows it removes can be
          // counted and disclosed below.
          let offScopeRfqs = 0;
          for (let i = 0; i < fleetIds.length; i += 2000) {
            try {
              const pos = (await call('purchase.order', 'search_read', [[
                ['fleet_id', 'in', fleetIds.slice(i, i + 2000)],
              ]], { fields: ['fleet_id', 'create_date', 'create_uid', 'company_id'], limit: 0 })) as Rec[];
              for (const po of pos) {
                const cid = m2o(po.company_id)?.[0];
                if (cid == null || !kpiIds.includes(cid)) { offScopeRfqs++; continue; }
                const fleet = m2o(po.fleet_id)?.[0];
                const t = poTime(po.create_date);
                const u = m2o(po.create_uid);
                if (fleet != null && t != null) {
                  (rfqTimes[fleet] ??= []).push({ t, by: u ? { id: u[0], name: u[1] } : null });
                }
              }
            } catch { /* this chunk's vehicles simply have no RFQ times */ }
          }
          if (offScopeRfqs) {
            notes.push(`RFQ after approval no longer counts purchase orders raised outside the five scored companies, and ignored ${offScopeRfqs} of them this week. This query had no company filter while RFQ confirmed and Parts placed both had one, so all three now agree on which companies count. Where those purchases were the real RFQ for the job, this KPI will read lower than before — the scope narrowed, the purchasing did not change.`);
          }

          // Performed by whoever raised the RFQ — the purchase order's creator,
          // read from Odoo rather than nominated.
          //
          // This KPI used to be charged to a branch's single configured RFQ
          // coordinator (`config.rfqCoordinators`), falling back to the job
          // card's owner. That is no longer read at all: a nomination holds one
          // name per branch, so a second and third raiser could not be scored,
          // and the live data had the nominated Dubai name raising no RFQs
          // whatsoever while taking every Dubai verdict. The derived raiser
          // supersedes it, with no label and nobody to arbitrate.
          //
          // When the RFQ is the thing MISSING there is no purchase order and so
          // no raiser: that verdict names nobody and is shared across this KPI's
          // owners in the branch, which is exactly who should have raised it.
          let noVehicle = 0, unraised = 0;
          for (const r of ros) {
            const soId = m2o(r.sale_order_id)?.[0];
            const approved = soId != null ? approvedAt[soId] : undefined;
            if (approved == null) continue;
            const fleet = m2o(r.fleet_id)?.[0];
            // The vehicle is the only link back to a purchase order, so without
            // one an RFQ is unobservable rather than missing — judging it would
            // score a data gap.
            if (fleet == null) { noVehicle++; continue; }
            const roCreated = odooTime(r.create_date);
            // A vehicle collects purchase orders over the years, so an RFQ counts
            // for THIS job only if it came after the job card existed — and one
            // raised before approval is early, not late.
            // The EARLIEST qualifying RFQ, because that is the one that satisfied
            // the rule and so the one whose raiser performed it.
            const qualifying = (rfqTimes[fleet] ?? [])
              .filter((x) => x.t <= approved + limitMs && (roCreated == null || x.t >= roCreated))
              .sort((a, b) => a.t - b.t);
            const ref = (r.name as string) || '';
            if (qualifying.length) push(18, r, true, ref, qualifying[0].by);
            else if (now - approved > limitMs) { unraised++; push(18, r, false, ref, null); }
            // still inside the window with no RFQ yet → not judged
          }
          if (unraised) {
            notes.push(`RFQ after approval found no RFQ at all on ${unraised} approved job${unraised === 1 ? '' : 's'} past the limit, so ${unraised === 1 ? 'that verdict names' : 'those verdicts name'} nobody: there is no purchase order and therefore no raiser. ${unraised === 1 ? 'It is' : 'They are'} shared across this KPI's owners in the branch — whoever does raise its RFQs — instead of being charged to whoever opened the job card. This KPI no longer reads the nominated RFQ coordinator at all; the raiser is derived from Odoo.`);
          }
          if (noVehicle) {
            notes.push(`RFQ after approval ignored ${noVehicle} repair order${noVehicle === 1 ? '' : 's'} with no vehicle set — the purchase order link runs through the vehicle, so an RFQ could not be seen either way.`);
          }
        }
      }

      // ── KPI 19 — the RFQ must be confirmed within N days of being raised ──
      if (on(19)) {
        if (!poHas('date_approve')) {
          notes.push('purchase.order has no Confirmation Date (date_approve), so RFQ confirmed (KPI 19) was skipped.');
        } else if (!poHas('fleet_id') || !has('fleet_id')) {
          // Without the vehicle on both sides there is no way to tell a workshop
          // purchase from a consumables order, and scoring every purchase in the
          // week is exactly the defect being fixed here. The KPI goes, not the
          // scope.
          notes.push('RFQ confirmed (KPI 19) needs fleet_id on purchase.order and on repair.order to tell a purchase raised for a job card from shop consumables, and one of them is missing on this instance — so the KPI was skipped rather than scoring every purchase order raised this week.');
        } else {
          const limitMs = (thresholds.rfqConfirmDays ?? 1) * 86400_000;
          let raised: Rec[] = [];
          try {
            // Cancelled RFQs are out of the population: a withdrawn request was
            // never waiting on a confirmation, so counting it would read as a
            // failure to confirm something nobody wanted any more.
            raised = (await call('purchase.order', 'search_read', [[
              ['create_date', '>=', wStart], ['create_date', '<', wEnd],
              ['state', '!=', 'cancel'],
              ['company_id', 'in', kpiIds],
            ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', 'state', 'date_approve', 'fleet_id'], limit: 0 })) as Rec[];
          } catch {
            notes.push('RFQ confirmed (KPI 19) could not read the purchase orders raised this week.');
          }

          // The same job-card test KPI 20 applies, evaluated at the moment the
          // purchase order was CREATED — which is the moment this KPI starts its
          // clock from. Without it the population was every purchase order raised
          // in the week: parts for job cards from before the clean slate, parts
          // for vehicles with no open job, and shop consumables and stationery
          // raised by central procurement, who are not parts staff at all.
          const fleetIds = [...new Set(raised.map((po) => m2o(po.fleet_id)?.[0]).filter((x): x is number => x != null))];
          const jobsByFleet = await jobsForFleets(fleetIds);

          let undated = 0, noVehicle = 0, noJob = 0, closedJob = 0, undatedJob = 0, scoped = 0, outOfOrder = 0;
          for (const po of raised) {
            const created = poTime(po.create_date);
            if (created == null) continue;
            const fleet = m2o(po.fleet_id)?.[0] ?? null;
            // No vehicle at all: consumables, tooling, stationery. There is no job
            // card behind it and no parts clock it belongs to.
            if (fleet == null) { noVehicle++; continue; }
            const { job, closedOut, undated: undatedClosure } = jobFor(jobsByFleet, fleet, created);
            if (!job) {
              if (closedOut) closedJob++;
              else if (undatedClosure) undatedJob++;   // dropped for want of data, not for being out of scope
              else noJob++;
              continue;
            }
            scoped++;
            const ref = (po.name as string) || '';
            const confirmed = poTime(po.date_approve);
            // A confirmation dated before the order was created cannot time
            // anything: raw subtraction would go negative, land inside any
            // limit and read as compliant. The business-clock KPIs route this
            // through measured(); this chain is calendar-timed, so it says so
            // here rather than handing out a free pass.
            // No performer passed, meaning this record's creator — and the record
            // here IS the purchase order, so that is the person who raised the
            // RFQ this KPI is about. One of the two KPIs that already charged the
            // right person before this change.
            if (confirmed != null && confirmed < created) outOfOrder++;
            else if (confirmed != null) push(19, po, confirmed - created <= limitMs, ref);
            else if (RFQ_STATES.includes(String(po.state))) {
              if (now - created > limitMs) push(19, po, false, ref);   // still an RFQ, window gone
            } else {
              // Confirmed but undated: there is no moment to measure to, and
              // guessing one would invent either a pass or a fail.
              undated++;
            }
          }
          if (undated) {
            notes.push(`RFQ confirmed left ${undated} confirmed purchase order${undated === 1 ? '' : 's'} unjudged — they carry no confirmation date, so there is nothing to time.`);
          }
          if (outOfOrder) {
            notes.push(`RFQ confirmed left ${outOfOrder} purchase order${outOfOrder === 1 ? '' : 's'} unjudged whose confirmation is dated before the order was created. Those two stamps cannot both be right, so neither a pass nor a failure can be read from them — and the subtraction would otherwise go negative, land inside any limit and score as on time.`);
          }
          const dropped = noVehicle + noJob + closedJob;
          if (dropped) {
            const why: string[] = [];
            if (noVehicle) why.push(`${noVehicle} with no vehicle on the order — shop consumables, tooling and stationery look like this`);
            if (noJob) why.push(`${noJob} whose vehicle has no job card in the Orders tab that was open when the purchase was raised — a job card moved to Historical looks like this`);
            if (closedJob) why.push(`${closedJob} whose job cards for that vehicle had already closed before the purchase was raised, so the parts belong to a later visit, not to that job`);
            notes.push(`RFQ confirmed now counts only purchases that belong to a job card in the Orders tab: ${scoped} of this week's ${raised.length} purchase order${raised.length === 1 ? '' : 's'} qualified, and ${dropped} ${dropped === 1 ? 'was' : 'were'} left out — ${why.join('; ')}. All of those were being scored against the branches until now, so this figure will move sharply. It moves because the scope narrowed to the work the rule is about, not because the parts desk got worse.`);
          }
          if (undatedJob) {
            notes.push(`RFQ confirmed left ${undatedJob} purchase order${undatedJob === 1 ? '' : 's'} unjudged whose job cards are closed and carry no record of WHEN they closed — neither a status timestamp nor a tracked stage change — so whether the job was still open when the parts were ordered cannot be established either way. This is the one exclusion here that is a gap in the data rather than a rule: because a job that got its parts is also the job that closes, a large number on this line would quietly push the KPI toward the slower work that stays open, and the figure would read worse than reality. If this count is not small, say so rather than reading the percentage.`);
          }
        }
      }

      // ── KPI 20 — the parts must land within N days of confirmation ──
      if (on(20)) {
        const parts = await resolvePartsFields(meta);
        if (!poHas('date_approve') || !poHas('fleet_id') || !has('fleet_id')) {
          notes.push('Parts placed (KPI 20) needs the Confirmation Date and fleet_id on purchase.order and fleet_id on repair.order — one of them is missing on this instance.');
        } else if (!parts) {
          notes.push('Parts placed (KPI 20) could not read the parts lines (Demand/Done), so receipt could not be judged.');
        } else {
          const limitMs = (thresholds.partsPlacedDays ?? 21) * 86400_000;
          const poFields = ['name', 'create_uid', 'company_id', 'fleet_id', 'date_approve'];
          if (poHas('effective_date')) poFields.push('effective_date');
          let confirmedPos: Rec[] = [];
          try {
            confirmedPos = (await call('purchase.order', 'search_read', [[
              ['date_approve', '>=', wStart], ['date_approve', '<', wEnd],
              ['state', 'in', CONFIRMED_STATES],
              ['company_id', 'in', kpiIds],
            ]], { fields: poFields, limit: 0 })) as Rec[];
          } catch {
            notes.push('Parts placed (KPI 20) could not read the purchase orders confirmed this week.');
          }

          // Every live repair order for the vehicles involved, oldest first. The
          // job is chosen per purchase order below, not per vehicle — the shared
          // lookup KPI 19 uses, asked at confirmation time instead of creation.
          const fleetIds = [...new Set(confirmedPos.map((po) => m2o(po.fleet_id)?.[0]).filter((x): x is number => x != null))];
          const jobsByFleet = await jobsForFleets(fleetIds, parts.lineField);

          const placements: { po: Rec; at: number; lines: number[] }[] = [];
          let unlinked = 0, closedJob = 0, undatedJob = 0;
          for (const po of confirmedPos) {
            const at = poTime(po.date_approve);
            if (at == null) continue;
            // The lookup used to require only "non-historical", so a purchase
            // order confirmed last week could be judged against a job card that
            // closed in March. Its own docstring already promised the newest LIVE
            // job card; it now has to have been open at this moment to qualify.
            const { job, closedOut, undated } = jobFor(jobsByFleet, m2o(po.fleet_id)?.[0] ?? null, at);
            if (!job) {
              // No job card to receive against — for one of three reasons, kept
              // apart because only the third is a data gap.
              if (closedOut) closedJob++;
              else if (undated) undatedJob++;
              else unlinked++;
              continue;
            }
            placements.push({ po, at, lines: job.lines });
          }

          const lineInfo = await readPartsLines(parts, [...new Set(placements.flatMap((p) => p.lines))]);

          let noArrival = 0, outOfOrderArrival = 0;
          // Every push below omits the performer, meaning the record's creator,
          // and the record is the purchase order — whoever raised it. Correct as
          // it stands: this KPI is about chasing the parts that order was for.
          for (const p of placements) {
            const ref = (p.po.name as string) || '';
            // Judged on the whole job card, not this order's own lines: one job's
            // parts routinely arrive across several purchase orders, and the
            // vehicle is only unblocked when the last of them is in.
            const complete = p.lines.every((id) => !lineInfo[id]?.short);
            if (complete) {
              const landed = poTime(p.po.effective_date);
              // An arrival dated before the confirmation cannot time the
              // receipt: the raw subtraction goes negative, falls inside any
              // limit and reads as compliant. Calendar-timed, so measured()
              // does not cover it — refuse it here instead.
              if (landed != null && landed < p.at) outOfOrderArrival++;
              else if (landed != null) push(20, p.po, landed - p.at <= limitMs, ref);
              else { noArrival++; push(20, p.po, true, ref); }   // generous, and counted below
            } else if (now - p.at > limitMs) {
              push(20, p.po, false, ref);   // still short, window gone
            }
            // still short but inside the window → not judged
          }
          if (noArrival) {
            notes.push(`Parts placed accepted ${noArrival} purchase order${noArrival === 1 ? '' : 's'} as on time whose parts are complete but which carry no Arrival date, so the receipt itself could not be timed.`);
          }
          if (outOfOrderArrival) {
            notes.push(`Parts placed left ${outOfOrderArrival} purchase order${outOfOrderArrival === 1 ? '' : 's'} unjudged whose Arrival is dated before the confirmation. Those two stamps cannot both be right, so the receipt cannot be timed either way — and the subtraction would otherwise go negative and score as on time.`);
          }
          if (unlinked) {
            notes.push(`Parts placed skipped ${unlinked} confirmed purchase order${unlinked === 1 ? '' : 's'} with no job card in the Orders tab for that vehicle at the moment of confirmation — nothing to receive the parts against.`);
          }
          if (closedJob) {
            notes.push(`Parts placed skipped ${closedJob} confirmed purchase order${closedJob === 1 ? '' : 's'} whose job cards for that vehicle had already closed before the order was confirmed — until now these were timed against the closed job card, which is a different visit's parts.`);
          }
          if (undatedJob) {
            notes.push(`Parts placed left ${undatedJob} confirmed purchase order${undatedJob === 1 ? '' : 's'} unjudged whose job cards are closed and carry no record of WHEN they closed — neither a status timestamp nor a tracked stage change — so whether the job was still open at confirmation cannot be established either way. This is the one exclusion here that is a gap in the data rather than a rule: because a job whose parts arrived is also the job that closes, a large number on this line would quietly push the KPI toward the slower work that stays open, and the figure would read worse than reality. If this count is not small, say so rather than reading the percentage.`);
          }
        }
      }
    }
  }

  // ── KPI 17 — answering an @mention in the chatter ──
  //
  // Modelled as a conversation, not as isolated messages. Each RO's comments are
  // walked in order while tracking who currently owes whom a reply:
  //
  //   • One message is ONE request, however many people it mentions — tagging
  //     three people asks for an answer, not three answers. Whichever of them
  //     comments first settles it and is judged on how long it took; the others
  //     are not judged at all. If nobody answers, it falls to the person
  //     mentioned FIRST, who is the one actually being asked.
  //   • A mention only creates a request for people the author was not just
  //     answering. So "@ahmed where is the part?" asks Ahmed, but Ahmed's
  //     "@hussein on the way" answers it without asking Hussein back.
  //
  // Without that second rule the thread never closes: every courteous reply
  // starts a new clock and whoever speaks last always fails.
  if (on(17)) {
    const limitMs = businessHours(thresholds.mentionResponseHours ?? 1);
    const weekFrom = Date.parse(wStart.replace(' ', 'T') + 'Z');
    const weekTo = Date.parse(wEnd.replace(' ', 'T') + 'Z');

    try {
      const mm = (await call('mail.message', 'fields_get', [], { attributes: ['type', 'relation'] })) as FieldsMeta;
      const recipientField = ['partner_ids', 'notified_partner_ids']
        .find((f) => mm[f]?.relation === 'res.partner');

      if (!recipientField) {
        notes.push('Chatter response is inactive — mail.message has no recipient field, so mentions cannot be read.');
      } else {
        const mentions = (await call('mail.message', 'search_read', [[
          ['model', '=', 'repair.order'],
          ['date', '>=', wStart], ['date', '<', wEnd],
          ['message_type', '=', 'comment'],
          [recipientField, '!=', false],
        ]], { fields: ['res_id'], limit: 0 })) as Rec[];

        if (!mentions.length) {
          notes.push('No chatter mentions were posted on repair orders this week.');
        } else {
          const roIds = [...new Set(mentions.map((m) => m.res_id as number))];
          const ros = (await call('repair.order', 'read', [roIds], { fields: ['name', 'company_id', ...histField] })) as Rec[];
          const roInfo: Record<number, { name: string; branch: Branch | undefined }> = {};
          for (const r of ros) {
            // Left out of roInfo altogether, which drops the whole conversation at the
            // branch guard below — nobody may be owed a reply over a historical order.
            if (isHistorical(r)) continue;
            const cid = m2o(r.company_id)?.[0];
            roInfo[r.id as number] = {
              name: (r.name as string) || '',
              branch: cid != null ? idToBranch[cid] : undefined,
            };
          }

          // The whole conversation on those ROs, from the start of the week on.
          // Replies posted after the week still close a debt raised inside it.
          const thread = (await call('mail.message', 'search_read', [[
            ['model', '=', 'repair.order'],
            ['res_id', 'in', roIds],
            ['date', '>=', wStart],
            ['message_type', '=', 'comment'],
          ]], { fields: ['res_id', 'date', 'author_id', 'body', recipientField], limit: 0 })) as Rec[];

          const byRo = new Map<number, Rec[]>();
          for (const m of thread) {
            const rid = m.res_id as number;
            const list = byRo.get(rid);
            if (list) list.push(m); else byRo.set(rid, [m]);
          }

          // Partner → user, resolved BEFORE anyone is judged.
          //
          // partner_ids is just "who was notified", and Odoo's Send message puts
          // the CUSTOMER's partner on it. A customer never comments in the
          // chatter, so after one business hour they handed the branch a
          // non-compliance — and because a customer has no user record the fine
          // landed on no advisor at all and could not be audited from the page.
          // Only partners with a user record can be asked to answer, so the
          // mapping has to exist before the candidate lists are built, not
          // afterwards for the display name.
          const touched = new Set<number>();
          for (const m of thread) {
            const a = m2o(m.author_id)?.[0];
            if (a != null) touched.add(a);
            for (const pid of (m[recipientField] as number[] | undefined) ?? []) touched.add(pid);
          }
          const partnerIds = [...touched];
          const names: Record<number, string> = {};
          const userIds: Record<number, number> = {};
          let usersUnreadable = false;
          if (partnerIds.length) {
            try {
              const partners = (await call('res.partner', 'read', [partnerIds], { fields: ['display_name'] })) as Rec[];
              for (const pt of partners) names[pt.id as number] = (pt.display_name as string) || `Partner ${pt.id}`;
            } catch { /* fall back to the id below */ }
            try {
              // active_test: false keeps ARCHIVED users in the lookup. A departed
              // employee is still a user and still owes the replies they missed
              // while employed; a customer never was one. Without it Odoo's
              // implicit active = True clause would drop ex-staff and the filter
              // would remove the wrong people.
              const users = (await call('res.users', 'search_read', [[['partner_id', 'in', partnerIds]]], {
                fields: ['partner_id'], limit: 0, context: { active_test: false },
              })) as Rec[];
              for (const usr of users) {
                const pid = m2o(usr.partner_id)?.[0];
                if (pid != null) userIds[pid] = usr.id as number;
              }
            } catch { usersUnreadable = true; }
          }

          type Judgement = { partner: number; compliant: boolean; ref: string; branch: Branch };
          const judgements: Judgement[] = [];
          /** Mentioned partners with no user record — customers, not staff. */
          const external = new Set<number>();
          let pending = 0;

          // Without the user map every recipient would look external, so the
          // conversation walk is dropped outright rather than quietly judging
          // nobody and reading as a clean 100%.
          if (usersUnreadable) {
            notes.push('Chatter response was not scored this week: res.users could not be read, so the customers Odoo notifies on a Send message could not be told apart from the staff who owe a reply. Nobody is charged with a mention rather than charging a customer for one.');
            byRo.clear();
          }

          for (const [rid, msgs] of byRo) {
            const info = roInfo[rid];
            if (!info?.branch) continue;
            msgs.sort((a, b) => (odooTime(a.date) ?? 0) - (odooTime(b.date) ?? 0));

            // Open requests on this RO. Each one names its asker, when it was
            // made, and everyone who could answer it — in the order tagged.
            let open: { by: number; at: number; candidates: number[] }[] = [];

            for (const m of msgs) {
              const at = odooTime(m.date);
              const author = m2o(m.author_id)?.[0];
              if (at == null || author == null) continue;

              // 1. Any request this author could answer is settled by commenting.
              const answered = new Set<number>();
              const settled = open.filter((o) => o.candidates.includes(author));
              for (const o of settled) {
                answered.add(o.by);
                if (o.at >= weekFrom && o.at < weekTo) {
                  judgements.push({ partner: author, compliant: elapsed(o.at, at) <= limitMs, ref: info.name, branch: info.branch });
                }
              }
              if (settled.length) open = open.filter((o) => !settled.includes(o));

              // 2. A new request — but not back at whoever was just answered,
              //    and only ever to someone who could answer: a partner with no
              //    user record is the customer, who owes the workshop nothing.
              const recipients = (m[recipientField] as number[] | undefined) ?? [];
              const candidates = mentionOrder(m.body, recipients)
                .filter((pid) => pid !== author && !answered.has(pid))
                .filter((pid) => {
                  if (userIds[pid] != null) return true;
                  external.add(pid);
                  return false;
                });
              if (!candidates.length) continue;
              // A nudge does not restart the clock — it keeps running from the
              // first ask, so an existing request from the same person stands.
              if (open.some((o) => o.by === author && o.candidates.some((c) => candidates.includes(c)))) continue;
              open.push({ by: author, at, candidates });
            }

            // Requests nobody answered fall to whoever was mentioned first.
            for (const o of open) {
              if (o.at < weekFrom || o.at >= weekTo) continue;
              // Unanswered, but the reply window only burns during working hours.
              if (elapsed(o.at, now) > limitMs) {
                judgements.push({ partner: o.candidates[0], compliant: false, ref: info.name, branch: info.branch });
              } else {
                pending++;   // still inside the window, not yet answerable
              }
            }
          }

          // Every judged partner was a candidate, and a candidate always has a
          // user record now, so the id is never null here.
          for (const j of judgements) {
            pushFor(17, j.branch, { id: userIds[j.partner] ?? null, name: names[j.partner] ?? `Partner ${j.partner}` }, j.compliant, j.ref);
          }
          if (external.size) {
            notes.push(`Chatter response ignored ${external.size} mentioned ${external.size === 1 ? 'partner who is' : 'partners who are'} not an internal user — Odoo's Send message notifies the customer, and a customer who never comments is not a missed reply by the workshop.`);
          }
          if (!judgements.length && pending) {
            notes.push(`All ${pending} open chatter mention${pending === 1 ? '' : 's'} this week are still inside the reply window.`);
          }
        }
      }
    } catch (e) {
      notes.push(`Chatter response could not be computed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── KPIs 6 & 7 — time spent awaiting parts / labour (point-in-time) ──
  if (on(6) || on(7)) {
    // The outer bound, not the population: OPEN ROs created in the last N days.
    // Closed work is excluded deliberately — a car that has already left cannot
    // be waiting on anything. Narrowing to open work was the first half of this;
    // the denominator itself is now the vehicles actually waiting, below, because
    // the open ones waiting on nothing were still carrying the figure.
    const baselineDays = thresholds.snapshotBaselineDays ?? 90;
    const sinceIso = new Date(now - baselineDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const baseROs = (await call('repair.order', 'search_read', [[
      ['create_date', '>=', sinceIso],
      ...selectorDomainNot(config.stageMap.closed),
      ['company_id', 'in', kpiIds],
      ...notHist,
    ]], { fields: ['name', 'create_uid', 'company_id'], limit: 0 })) as Rec[];
    // The baseline is now only the outer bound on the window, not the
    // denominator: it says which job cards are recent enough to be scored at all.
    const inWindow = new Set(baseROs.map((r) => r.id as number));

    /**
     * Score only the vehicles actually waiting — the owner's decision.
     *
     * The denominator used to be every open repair order in the window, each one
     * compliant unless it appeared in the overdue set. With 500 open jobs of
     * which 60 are short of parts and 20 of those overdue, that reads 96% where
     * the rule — an open RO with parts still outstanding may not wait beyond the
     * limit — means 67%. The 440 vehicles waiting on nothing were carrying the
     * figure.
     *
     * So `waiting` is the denominator: compliant means waiting but inside the
     * limit, non-compliant means waiting beyond it, and a vehicle not waiting at
     * all is not in the KPI. Timing is untouched — these stay snapshot KPIs,
     * `snapshotBaselineDays` is still the outer bound, and a vehicle stuck past
     * the limit from before the window still counts against us exactly as before.
     */
    const scoreWaiting = (kpiId: number, waiting: Map<number, Rec>, overdue: Map<number, Rec>) => {
      const seen = new Set<number>();
      let judged = 0;
      // Both KPIs pass NO performer. A vehicle waiting is a state, not an act:
      // nobody performs "awaiting parts", and the one person these verdicts used
      // to be charged to — whoever opened the job card — is the person with least
      // influence over whether the parts have arrived or the labour was clocked
      // on. KPI 6's verdicts are shared across its owners in the branch; KPI 7 is
      // in BRANCH_ONLY_KPI_IDS and reaches no card at all.
      for (const [id, r] of waiting) {
        if (!inWindow.has(id)) continue;   // older than the baseline window, unless it is overdue below
        seen.add(id);
        judged++;
        push(kpiId, r, !overdue.has(id), (r.name as string) || '', null);
      }
      // Stuck vehicles older than the window still count against us.
      for (const [id, r] of overdue) {
        if (seen.has(id)) continue;
        judged++;
        push(kpiId, r, false, (r.name as string) || '', null);
      }
      return { judged, overdue: overdue.size };
    };

    /**
     * The ROs currently sitting in a mapped state, split into the ones that are
     * waiting (the denominator) and the ones held past `days` (the violations).
     *
     * An RO in the state with no usable stamp is in neither: we know it is
     * waiting but not for how long, and under the new denominator that cannot be
     * answered as compliant any more — before, it was simply one of the open ROs
     * nothing was wrong with. Unknown is left unjudged, as everywhere else here.
     */
    const overdueByState = async (sel: StageSelector, days: number, kpiLabel: string) => {
      const recs = (await call('repair.order', 'search_read', [[
        ...selectorDomain(sel),
        ['company_id', 'in', kpiIds],
        ...notHist,
      ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', ageField], limit: 0 })) as Rec[];
      const tf = trackedField(sel, meta, stageNames);
      // The LATEST arrival, on purpose, and the one place in the engine where
      // that is the right reading: this asks how long a car has been sitting in
      // the state it is in NOW. Taking the first arrival would age a vehicle
      // from a wait it has already finished and overstate every one of them.
      // The author is not read here: KPIs 6 and 7 have no performer at all, so
      // only the arrival time is used.
      const entered = tf ? await stateEntryTimes(recs.map((r) => r.id as number), tf.field, tf.labels, 'last') : noTransitions();
      if (Object.keys(entered.at).length) usedTrackingForAging = true;
      const limitMs = days * 86400_000;
      const waiting = new Map<number, Rec>();
      const overdue = new Map<number, Rec>();
      let noStamp = 0;
      for (const r of recs) {
        // No fallback to create_date. Both steps that remain measure time in the
        // CURRENT state; the job card's own creation date measures the whole
        // visit, so a job opened 100 days ago that started waiting yesterday
        // would be aged at 100 days against a 2-day limit — a guaranteed fine
        // from a missing stamp. Every step of that chain moved toward more
        // elapsed time, so every ambiguity resolved against the branch. An RO
        // with no stamp is now unknown, not overdue.
        const since = entered.at[r.id as number] ?? odooTime(r[ageField]);
        if (since == null) { noStamp++; continue; }
        waiting.set(r.id as number, r);
        if (now - since > limitMs) overdue.set(r.id as number, r);
      }
      if (noStamp) {
        notes.push(`${kpiLabel} could not age ${noStamp} open repair order${noStamp === 1 ? '' : 's'} in that state — no chatter transition and no ${ageField} on the record. ${noStamp === 1 ? 'It is' : 'They are'} left out of the count entirely rather than being aged from the job card's creation date, which is the whole visit's age and overstates every wait: ${noStamp === 1 ? 'that vehicle is' : 'those vehicles are'} waiting, but for how long is unknown, and now that only the waiting vehicles are counted an unknown wait cannot be read as a compliant one.`);
      }
      return { waiting, overdue };
    };

    // ── KPI 6 — open ROs held up waiting for parts ──
    // "Awaiting parts" is derived from the parts lines themselves: an OPEN repair
    // order with any line whose Done quantity is short of Demand is still waiting
    // on parts. Ages from when that part was requested.
    if (on(6)) {
      const days = thresholds.awaitingPartsDays ?? 14;
      const useParts = (config.awaitingPartsSource ?? 'parts') === 'parts';
      const parts = useParts ? await resolvePartsFields(meta) : null;
      // The vehicles actually waiting on parts, and the subset of them past the
      // limit. Both paths below fill both maps, so which one reached a vehicle
      // cannot change what the denominator means.
      let waiting: Map<number, Rec>;
      let overdue: Map<number, Rec>;

      if (parts) {
        const openROs = (await call('repair.order', 'search_read', [[
          ...selectorDomainNot(config.stageMap.closed),
          ['company_id', 'in', kpiIds],
          ...notHist,
        ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', parts.lineField], limit: 0 })) as Rec[];

        const lineIds = [...new Set(openROs.flatMap((r) => (r[parts.lineField] as number[] | undefined) ?? []))];
        const lineInfo = await readPartsLines(parts, lineIds);

        const limitMs = days * 86400_000;
        waiting = new Map<number, Rec>();
        overdue = new Map<number, Rec>();
        let noRequestDate = 0;
        for (const r of openROs) {
          // Oldest outstanding part decides how long this RO has been held up.
          // No fallback to the RO's create_date, for the same reason the state
          // path above drops it: the job card predates every line on it, so a
          // line with no request date would be aged from the whole visit and
          // overstate the wait. Which path reached a vehicle must not decide
          // whether its wait is overstated.
          let waitingSince: number | null = null;
          let anyShort = false;
          for (const id of (r[parts.lineField] as number[] | undefined) ?? []) {
            const li = lineInfo[id];
            if (!li?.short) continue;
            anyShort = true;
            const t = li.since;
            if (t != null && (waitingSince == null || t < waitingSince)) waitingSince = t;
          }
          if (!anyShort) continue;            // nothing outstanding — not waiting on parts
          // Outstanding, but nothing says since when: unknown, so it is left out
          // of the count rather than read either way.
          if (waitingSince == null) { noRequestDate++; continue; }
          waiting.set(r.id as number, r);
          if (now - waitingSince > limitMs) overdue.set(r.id as number, r);
        }
        if (noRequestDate) {
          notes.push(`Awaiting parts could not age ${noRequestDate} open repair order${noRequestDate === 1 ? '' : 's'} with parts still outstanding — none of their short lines carries a request date. ${noRequestDate === 1 ? 'It is' : 'They are'} left out of the count entirely rather than being aged from the job card's creation date, which is the whole visit's age and overstates every wait: the parts are outstanding, but since when is unknown, and now that only the waiting vehicles are counted an unknown wait cannot be read as a compliant one.`);
        }
      } else {
        if (useParts) {
          notes.push('Could not read the parts lines (Demand/Done), so "Awaiting parts" fell back to the mapped state.');
        }
        awaitingPartsMethod = 'the mapped state';
        ({ waiting, overdue } = await overdueByState(config.stageMap.awaitingParts, days, 'Awaiting parts'));
      }
      const { judged } = scoreWaiting(6, waiting, overdue);
      // The denominator changed, and the figure drops by roughly thirty points
      // because of it. Said in full, because a drop nobody can account for reads
      // as the branches collapsing.
      notes.push(`Awaiting parts is scored against the vehicles actually waiting on parts — ${judged} open job card${judged === 1 ? '' : 's'} with parts still outstanding, detected from ${awaitingPartsMethod} — and no longer against all ${inWindow.size} open repair order${inWindow.size === 1 ? '' : 's'} of the last ${baselineDays} days. The vehicles waiting on nothing used to sit in the count as compliant and carried the figure up by roughly thirty points; the rule has always been about the ones that are waiting. A lower number here means the denominator narrowed to the rule, not that the branches got worse.`);
    }

    // ── KPI 7 — awaiting labour (clocked on, not the matrix flag) ──
    if (on(7)) {
      /**
       * The owner's redefinition: "Awaiting labour should be judged by clocking
       * on and off. If a repair order's parts are delivered or does not need
       * parts, the KPI system should check if the labour lines are started or
       * not. This is measured with timestamps in Odoo."
       *
       * So the population is no longer `priority_matrix_status = I`
       * ("Awaiting Labour - I"). That is a flag somebody sets by hand, the owner
       * has told us it is unreliable, and §4 of the audit notes the KPI reads a
       * clean 100% if the code ever stops matching anything in Odoo. The two
       * objective signals replace it:
       *
       *  - `is_parts_available` ("All Parts are available"), a stored boolean,
       *    true both when the parts have arrived AND when the job needs none —
       *    exactly the owner's "delivered or does not need parts".
       *  - `start_time` on the labour lines (`repair.order.service_ids` →
       *    `repair.service.line`), the clock-on Odoo stamps itself.
       *
       * The clock is anchored on `status_since`, the owner's choice, and not on
       * the moment the car became ready for labour: `is_parts_available` has
       * tracking = 0 on this instance, so it leaves no chatter entry and that
       * moment simply cannot be read back from history.
       */
      notes.push('Awaiting labour is now judged by whether labour has been clocked on — an open job card whose parts are ready, or which needs none, with no labour line carrying a start time — and no longer by the manual "Awaiting Labour - I" priority-matrix flag. The figure moves because the rule changed, not because the branches did: the clock-on is a timestamp Odoo writes itself, the flag was set by hand, and the two populations only partly overlap.');

      // Both halves of the rule have to exist on this instance before the KPI
      // can mean anything. `service_ids` is read through fields_get rather than
      // hard-coded to repair.service.line, the same way resolvePartsFields
      // discovers the parts relation — the comodel is customisable.
      const labourModel = has('service_ids') ? meta.service_ids?.relation : undefined;
      let startField: string | undefined;
      if (labourModel && has('is_parts_available')) {
        try {
          const lm = (await call(labourModel, 'fields_get', [], { attributes: ['type'] })) as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(lm, 'start_time')) startField = 'start_time';
        } catch { /* comodel unreadable — treated as a missing structure below */ }
      }
      // Which half is absent, named precisely, because the note has to tell the
      // reader what to go and look at.
      const missingStructure = !labourModel ? 'repair.order.service_ids, the labour lines'
        : !has('is_parts_available') ? 'repair.order.is_parts_available, "All Parts are available"'
        : !startField ? `${labourModel}.start_time, the clock-on`
        : undefined;

      if (missingStructure || !startField || !labourModel) {
        /**
         * Degrade loudly, never quietly. Falling back to the old
         * priority_matrix_status rule would put a number on the page that looks
         * like the new definition and was produced by the old one, and nothing
         * on the page — not the figure, not the tooltip — would let a reader
         * tell which rule fined them. An absent figure with a reason is the
         * honest failure; a plausible wrong figure is not.
         */
        notes.push(`Awaiting labour was not computed: ${missingStructure ?? 'the labour-line structure'} is missing from this Odoo instance, and the KPI is now defined entirely by it. The manual "Awaiting Labour - I" priority-matrix flag is no longer used for this KPI and was deliberately NOT used as a fallback — a figure from the old rule would be indistinguishable on the page from a figure from the new one.`);
      } else {
        const days = thresholds.awaitingLabourDays ?? 2;
        const limitMs = days * 86400_000;
        // status_since is the anchor the owner chose. Requested only when the
        // field exists: asking Odoo for a field it does not have fails the whole
        // call, taking the KPI down with it.
        const anchorField = has('status_since') ? 'status_since' : undefined;

        // Open, non-historical, in the five scored companies, and the job card
        // says its parts are ready. The parts test goes into the domain rather
        // than being filtered in memory so that only the few dozen candidates
        // come back — which is what keeps the labour-line read below small.
        const candidates = (await call('repair.order', 'search_read', [[
          ['is_parts_available', '=', true],
          ...selectorDomainNot(config.stageMap.closed),
          ['company_id', 'in', kpiIds],
          ...notHist,
        ]], {
          fields: ['name', 'create_uid', 'company_id', 'service_ids', ...(anchorField ? [anchorField] : [])],
          limit: 0,
        })) as Rec[];

        /**
         * One chunked read for every labour line of every candidate, the shape
         * readPartsLines established. Chunking by line id is what keeps the call
         * count flat: whether there are 70 candidates or 700, this is one read
         * per 4000 lines, not one read per job card.
         */
        const clockedOn: Record<number, boolean> = {};
        const CHUNK = 4000;
        const lineIds = [...new Set(candidates.flatMap((r) => (r.service_ids as number[] | undefined) ?? []))];
        for (let i = 0; i < lineIds.length; i += CHUNK) {
          try {
            const lines = (await call(labourModel, 'read', [lineIds.slice(i, i + CHUNK)], { fields: [startField] })) as Rec[];
            // Truthiness, not odooTime(): the owner's test is whether start_time
            // is SET. Odoo returns false for an empty datetime, so a set value
            // that this code cannot parse is still a clock-on — parsing it and
            // reading null as "not started" would turn an unreadable stamp into
            // a vehicle waiting, which is the wrong direction for a fine.
            for (const l of lines) clockedOn[l.id as number] = Boolean(l[startField]);
          } catch { /* unreadable chunk — its job cards go unjudged below */ }
        }

        const waiting = new Map<number, Rec>();
        const overdue = new Map<number, Rec>();
        let noLines = 0, unreadable = 0, started = 0, noAnchor = 0;
        for (const r of candidates) {
          const ids = (r.service_ids as number[] | undefined) ?? [];
          /**
           * No labour lines at all: unjudged, counted and noted. The owner's
           * rule is to check whether the labour lines are started; where there
           * are none there is nothing to check, and a parts-only job card is
           * not a labour failure. Live data puts this at about 6 records.
           */
          if (!ids.length) { noLines++; continue; }
          /**
           * A line whose chunk failed to read cannot be read as "not started".
           * That is precisely the KPI 20 bug §4 of the audit describes — a
           * single timed-out chunk declaring whole jobs complete — pointed the
           * other way: here it would invent a vehicle waiting on labour. Unknown
           * is unjudged, as everywhere else in this engine.
           */
          if (ids.some((id) => clockedOn[id] === undefined)) { unreadable++; continue; }
          /**
           * Clocked on, so not waiting. A job clocked on and then PAUSED counts
           * as started: start_time being set is the whole test. A long pause is
           * arguably a fresh wait on labour — nobody is working the car — and
           * `is_paused` / `pause_start_time` / `pause_duration` are all on the
           * line to measure it with. That is deliberately out of scope for now:
           * it is a second rule the owner has not given us, and guessing a pause
           * threshold here would fine people against a limit nobody agreed.
           */
          if (ids.some((id) => clockedOn[id])) { started++; continue; }
          /**
           * Waiting, but nothing says since when: unjudged, counted and noted.
           * No fallback to create_date, here or anywhere else in this engine —
           * the job card predates the wait, so a missing anchor would age the
           * whole visit against a 2-day limit and guarantee a fine.
           */
          const since = anchorField ? odooTime(r[anchorField]) : null;
          if (since == null) { noAnchor++; continue; }
          waiting.set(r.id as number, r);
          // Calendar days, unchanged: this is a backlog age, not a promise timed
          // against working hours, and moving it onto the business clock would
          // quietly triple every limit.
          if (now - since > limitMs) overdue.set(r.id as number, r);
        }

        if (noLines) {
          notes.push(`Awaiting labour left ${noLines} open job card${noLines === 1 ? '' : 's'} unjudged because ${noLines === 1 ? 'it carries' : 'they carry'} no labour lines at all. The rule is whether the labour lines have been clocked on; with none there is nothing to clock on, and a job card that is only parts is not a labour failure.`);
        }
        if (unreadable) {
          notes.push(`Awaiting labour could not read the labour lines of ${unreadable} open job card${unreadable === 1 ? '' : 's'}, so ${unreadable === 1 ? 'it is' : 'they are'} left out of the count entirely. An unreadable line is not read as "not started": that would turn a failed read into a vehicle waiting on labour.`);
        }
        if (noAnchor) {
          notes.push(`Awaiting labour could not age ${noAnchor} open job card${noAnchor === 1 ? '' : 's'} with no labour clocked on — ${noAnchor === 1 ? 'it has' : 'they have'} no readable ${anchorField ?? 'status_since'} to measure the wait from. ${noAnchor === 1 ? 'It is' : 'They are'} left out of the count entirely rather than being aged from the job card's creation date, which is the whole visit's age and overstates every wait: ${noAnchor === 1 ? 'that vehicle is' : 'those vehicles are'} waiting, but for how long is unknown, and now that only the waiting vehicles are counted an unknown wait cannot be read as a compliant one.`);
        }
        if (!anchorField) {
          notes.push('Awaiting labour has no status_since field on this Odoo instance, so no wait can be dated and nothing is judged. The owner fixed the clock on status_since; the job card\'s creation date is not used in its place.');
        }

        const { judged } = scoreWaiting(7, waiting, overdue);
        notes.push(`Awaiting labour is scored against the vehicles actually waiting on labour — ${judged} open job card${judged === 1 ? '' : 's'} whose parts are ready, or which need none, with no labour line clocked on, out of ${candidates.length} with parts ready — and not against all ${inWindow.size} open repair order${inWindow.size === 1 ? '' : 's'} of the last ${baselineDays} days. ${started} ${started === 1 ? 'has' : 'have'} labour already started and ${started === 1 ? 'is' : 'are'} therefore not waiting. The wait is counted in calendar days from when the vehicle entered its current status.`);
      }
    }

  }

  if (usedTrackingForAging) {
    snapshotNote = `Counts only the vehicles actually waiting, among open ROs created in the last ${baselineDaysNote} days (closed work is excluded): compliant means still inside the limit, non-compliant means waiting beyond it, and a vehicle that is not waiting is not in the count at all. One with no usable stamp to age from is left out rather than counted either way. Ageing measured from when it actually entered the state (Odoo chatter log).`;
  }
  // Labels carry the configured thresholds, e.g. "Delivered within 48 business hrs".
  // Resolved once here so every level agrees, and so the client never has to
  // know about the override map to place a KPI in the right section.
  const sectionById: Record<number, KpiSection> = Object.fromEntries(
    KPI_DEFINITIONS.map((d) => [d.id, sectionOf(d.id, config)]),
  );
  const displayNames: Record<number, string> = Object.fromEntries(
    KPI_DEFINITIONS.map((d) => [d.id, kpiDisplayName(d.id, d.name, thresholds)]),
  );

  // Every retimed KPI repeats this, so no limit on the page can be read as wall-clock.
  // The holiday half is stated only when holidays are actually configured: with
  // none entered the clock treats Eid as an ordinary working day, and promising
  // otherwise on every timed KPI is the one place this page could mislead a
  // fined person about why their limit ran out.
  const CLOCK = holidays.length
    ? 'Timed on the business clock: only Sat–Thu 09:00–18:00 Gulf counts, with Friday and the configured public holidays excluded.'
    : 'Timed on the business clock: only Sat–Thu 09:00–18:00 Gulf counts, with Friday excluded. No public holidays are configured, so a holiday counts as an ordinary working day.';

  // KPI 6 states which method decided a vehicle is waiting on parts.
  const snapshotNotes: Record<number, string> = {
    1: `Measured from the first moment the RO became Repaired this week to the moment the invoice that bills the repair was posted. That invoice is the earliest one posted no more than ${limitLabel(invoiceGraceMinutes, 'minute')} before the car was marked Repaired, or at any time after it — an invoice posted earlier is a down-payment invoice, which Odoo posts at quotation time, and it does not count as billing the repair. A job with nothing but deposits is treated as not yet invoiced. One whose billing invoice carries a date but no posting time is not judged at all: a date cannot time an hour. ${CLOCK}`,
    2: `Measured from the quotation being created to its approval; one still awaiting approval past the limit counts against you. Only quotations created in the last ${baselineDaysNote} days are counted while they are still open — a draft nobody has confirmed after that long is treated as dead rather than as still pending, so it stops failing this KPI every week. A quotation APPROVED during the week shown is counted however old it was. Only quotations attached to a job card in the Orders tab are counted — a quotation whose repair orders have all been moved to Historical, or which has no repair order at all (a counter parts sale, a retail order), is out of scope. Insurance jobs are exempt. ${CLOCK}`,
    3: 'Checks the quotation was approved (confirmed into a sale order) before the RO FIRST moved into Under Repair this week. The first entry, not the latest: a job that bounced back into Under Repair used to be measured from the later entry, which the original quotation always predated, so a second pass with no fresh approval could not fail.',
    12: `Measured from the RO first entering Inspection during the week shown to its quotation being created — the promise on getting a quote out, tighter than the inspection limit itself. The first entry of that week, not the latest in all history: measuring from the latest one meant a quotation raised for an earlier pass through Inspection satisfied a re-inspection nobody re-quoted. A quotation dated before that entry is not judged at all, since it belongs to the earlier pass. ${CLOCK}`,
    13: `A straight yes/no: was the follow-up screenshot uploaded. The population is the jobs that actually went through QA, read from the QA stage changes recorded on the job card — not the "QA Access" flag, which describes the permissions of whoever reads the record rather than the job itself. The person scored is the service advisor who opened the job card. A job whose QA entry cannot be found is not judged at all, and neither is one with no Repaired timestamp, since the grace cannot be measured without it. An RO is judged only once ${limitLabel(followUpGraceDays, 'day')} has passed since it was marked Repaired, so a car just handed over is not already a violation.`,
    14: `Check-in counts as complete the moment the RO reaches Inspection. ${CLOCK}`,
    15: `Measured from the RO first entering Inspection during the week shown to its quotation being created. The first entry of that week, not the latest in all history, so a re-inspection is timed from the re-inspection; a quotation dated before it belongs to the earlier pass and is not judged here. ${CLOCK}`,
    17: `Time from being @mentioned to your next comment on that RO. Tagging several people is one request — whoever answers first settles it, and if nobody does it falls to the person tagged first. Answering someone does not oblige them to answer you back, so a thread closes instead of looping. ${CLOCK}`,
    16: `Measured from the RO first entering QA during the week shown to the next state change after it; an RO still in QA past the limit counts against you. Both ends are read inside that week: the scan used to take the last QA arrival in all of history, so a later week's dwell could be scored into an earlier week and that earlier week's overrun was unreachable. ${CLOCK}`,
    11: `Delivery is inferred from invoicing — measured from the first moment the RO became Repaired this week to the invoice that bills the repair being posted, on a longer timeline than Invoice on delivery. It reads the invoice the same way: the earliest one posted no more than ${limitLabel(invoiceGraceMinutes, 'minute')} before Repaired or at any time after it, so a quotation-time deposit does not stand in for the closing invoice. ${CLOCK}`,
    4: 'Checks that a quotation exists for the job and was created before repair work FIRST started this week. The first entry into Under Repair, not the latest: measuring from the latest one let any earlier quotation satisfy a job that went back under repair. If the quotation\'s own dates cannot be read, the check falls back to existence alone, which is more generous than the rule.',
    5: 'Checks whether the RO carries a tag now — not when the tag was added. Odoo records no timestamp of its own for a tag here, so one added late still reads as present. ROs younger than the limit are left out of the count, so the figure covers only ROs that have had their full window.',
    8: 'A straight yes/no: does the RO carry a CAR-IN or CAR-OUT tag showing whether the vehicle is on site. No time limit of its own applies, but ROs younger than the Tag on creation limit are left out of the count alongside that KPI\'s. Inactive until CAR-IN / CAR-OUT tags are picked in Admin.',
    9: 'ROs received this week that were also closed this week (closed ÷ received). A job opened on Thursday has little of the week left to close in, so this figure is structurally low — which is why it is shown for reference and left out of the overall achievement.',
    18: 'Measured from the quotation being approved to a purchase order being raised against the vehicle — Odoo records no link from a purchase order back to a repair order, so the vehicle is the only way to see that an RFQ exists. Counted only for ROs still short of parts; ones with no vehicle set are skipped, because without one an RFQ cannot be seen either way. Purchase orders raised outside the five scored companies do not count as the RFQ, which is the same company scope RFQ confirmed and Parts placed use. An RFQ raised before approval counts as early, not late. Timed in calendar days, not business hours.',
    19: 'Measured from a purchase order being created to its Confirmation Date. Counted only for purchases that belong to a job card in the Orders tab: the order must carry a vehicle, and that vehicle must have a non-historical job card that was already open when the order was raised — the same test Parts placed uses, asked at creation instead of confirmation. That leaves out shop consumables and stationery, purchases for job cards moved to Historical, and purchases for vehicles with no open job. Cancelled requests are left out, and so are confirmed ones carrying no confirmation date, since there is nothing to measure to. Timed in calendar days, not business hours.',
    20: 'Measured from a purchase order\'s Confirmation Date to its Arrival date, judged against the whole job card\'s parts rather than this order\'s own lines — one job\'s parts routinely arrive across several orders, and the vehicle is only unblocked when the last of them is in. The job is matched through the vehicle: the newest non-historical job card that was already open when the order was confirmed — a job card already closed by then belongs to a different visit and cannot receive these parts. Orders with no such job card are skipped, and ones whose parts are complete but which carry no Arrival date are accepted as on time. Timed in calendar days, not business hours.',
    21: 'The share of this week\'s quotations the customer approved, meaning confirmed into a sale order. Counted from quotations created this week: Odoo records no reliable moment a quotation was sent, so creation stands in for sending. Only quotations attached to a job card in the Orders tab are counted — one whose repair orders have all been moved to Historical, or which has no repair order at all, is out of scope, which is what keeps counter parts sales and retail orders out of the rate. Drafts stay in the count on purpose — Send by Email is unused here, so an unapproved quotation sits in draft for good and dropping drafts would leave only the approved ones. In a week still running the newest quotations are simply undecided, so the figure reads low and settles upward as the week closes. No time limit applies.',
    22: 'A deadline, not a duration: did the RO reach Repaired by the scheduled delivery date promised to the customer. Repaired means the FIRST of the Repaired codes it reached that week (Labour Complete / QC Complete / Vehicle Ready) — the last of them failed a car finished at 16:00 on its promised day because Vehicle Ready was ticked the next morning. The promise is a wall-clock moment the customer was given, so it is compared raw — running it through working hours would move the promise itself. A promise whose Gulf clock reads exactly midnight is a promise for that whole day and falls due at 23:59 Gulf on it, so a car ready at any hour of its promised day is on time. ROs with no scheduled delivery date are skipped: nothing was promised, so nothing can be late.',
    6: `Open ROs with parts still outstanding, detected from ${awaitingPartsMethod}. ${snapshotNote}`,
    // KPI 7 no longer shares `snapshotNote`: that string names the configured
    // ageing basis, and this KPI's clock is fixed on status_since by the owner's
    // decision regardless of what Admin selects. The snapshot framing is spelled
    // out here instead, so the tooltip and the code state the same anchor.
    7: `Open job cards whose parts are ready — "All Parts are available" (is_parts_available), which is true both when the parts have arrived and when the job needs none — on which no labour line (repair.order → service_ids) carries a start time. The manual "Awaiting Labour - I" priority-matrix flag no longer decides this KPI: the clock-on is a timestamp Odoo writes itself, the flag was set by hand. The wait is measured in calendar days from when the vehicle entered its current status (status_since), not on the business clock, because the moment a car became ready for labour is not recorded anywhere — is_parts_available is not tracked in the chatter. Counts only the vehicles actually waiting, among open ROs created in the last ${baselineDaysNote} days (closed work is excluded): compliant means still inside the limit, non-compliant means waiting beyond it, and a vehicle that is not waiting is not in the count at all. A job clocked on and then paused counts as started, so it is not waiting. Left out of the count entirely rather than read either way: a job card with no labour lines at all, since there is nothing to clock on and a parts-only job is not a labour failure; one whose labour lines could not be read; and one with no readable status_since, which is never aged from the job card's creation date instead — that is the whole visit's age and overstates every wait.`,
  };
  if (SNAPSHOT_KPI_IDS.some(on)) {
    notes.push('KPIs 6 & 7 reflect the current state of open ROs, so they are the same regardless of the week selected.');
  }

  // While the holiday list is empty the business clock treats Eid like any other
  // working day, and it is the tightest limits that this distorts most. Said out
  // loud, because the alternative is a fine nobody can account for.
  const CLOCK_TIMED_IDS = [1, 2, 11, 12, 14, 15, 16, 17];
  if (!holidays.length && CLOCK_TIMED_IDS.some(on)) {
    notes.push('No public holidays are configured, so a holiday counts as an ordinary working day and burns about nine business hours out of every limit it falls inside. At the current thresholds a single one-day holiday is enough on its own to fail Invoice on delivery, Check-in after RO and Chatter response. Enter the dates under Admin → KPI Configuration, one YYYY-MM-DD per line.');
  }

  // ── Roll up ────────────────────────────────────────────────────────
  const roster = config.saRoster ?? [];

  // Excluded entries build no card at any level while their evaluations stay in
  // the branch and company figures: OdooBot, which is automation and must never
  // be scored, the Administrator account, and central staff whose work is not
  // any one branch's — the live map has a central pair raising RFQs in all five.
  // Named out loud, because an absent name otherwise reads as a broken report,
  // and because the figures above still contain the work.
  const scoredRoster = roster.filter((r) => !r.excluded);
  const excludedFromScoring = roster.filter((r) => r.excluded);
  if (excludedFromScoring.length) {
    const who = excludedFromScoring.map((r) => r.name || `User ${r.odooUserId}`).join(', ');
    notes.push(`Not scored individually, by configuration: ${who}. Each builds no card at all, while every evaluation of theirs still counts in the branch and company figures on this page — it is the scoring that is switched off, not the record. This is where automation (OdooBot, the Administrator account) and central staff whose work belongs to no single branch are put. Clear "exclude from scoring" on the roster entry in Admin → KPI Configuration to put someone back on a card.`);
  }

  // Anyone rostered outside the KPI scope now gets no card at any level: their
  // branch builds no node, so there is nowhere for them to appear. The Admin
  // roster still offers every workshop branch, so an ordinary config edit can
  // put someone here — and a person silently missing from the page reads as a
  // broken report, or worse goes unnoticed while they are unscored.
  //
  // Read across every branch the entry covers rather than the primary one alone:
  // someone whose `branches` names Dubai and EV Hub is scored under Dubai, so
  // naming them here would be false. An off-scope branch carries no evaluations
  // either way — the engine only ever books work to the five — so it costs them
  // nothing beyond a node that does not exist.
  const offScope = scoredRoster.filter(
    (r) => !rosterBranches(r).some((b) => (KPI_BRANCHES as readonly string[]).includes(b)),
  );
  if (offScope.length) {
    const who = offScope
      .map((r) => `${r.name || `User ${r.odooUserId}`} (${rosterBranches(r).join(', ') || 'no branch set'})`)
      .join(', ');
    notes.push(`Not scored here: ${who}. The KPI section covers the five UAE main branches only — Dubai, Ajman, Sharjah, Abu Dhabi and Al Ain — so anyone rostered to a station, to Qatar or to EV Hub has no card on this page. Move them to one of the five in Admin → KPI Configuration if they should be scored. The WIP and sales reports still count their branch.`);
  }

  /**
   * Has any ownership been derived yet?
   *
   * `config.kpiOwners` is absent until the refresh has run once, and the honest
   * reading of that is "nobody has been shown to own anything", not "fall back to
   * a label". There is deliberately no fallback to roles or sections: a figure
   * produced by one would be indistinguishable on the page from a derived one,
   * and the whole point of deriving ownership is that nobody has to take the
   * page's word for who answers for what.
   */
  const ownershipDerived = KPI_BRANCHES.some(
    (b) => KPI_DEFINITIONS.some((d) => ownersFor(config, b, d.id).length > 0),
  );
  if (!ownershipDerived) {
    notes.push(`No KPI ownership has been derived from Odoo yet, so no individual card carries any KPI — every figure on this page is a branch or company reading. Who answers for a KPI is read from who performs its action in that branch, more than ${KPI_OWNER_FLOOR} times in ${KPI_OWNER_WINDOW_DAYS} days, and nothing stands in for that: a figure from a fallback would look exactly like a derived one on this page. Use "Refresh ownership now" under Admin → KPI Configuration to derive it. Individuals still appear with the work they personally performed, because that is observed rather than assumed.`);
  }

  /**
   * The enabled KPIs a person's card carries in a branch.
   *
   * Two sources, and no label anywhere near either of them:
   *
   *   • the KPIs they OWN in that branch, derived from Odoo activity. This is
   *     what decides whose card a KPI appears on at all.
   *   • any KPI they were personally charged with in that branch, even if they do
   *     not own it. They demonstrably performed the work, so dropping the verdict
   *     would hide real activity — usually somebody below the ownership floor
   *     whom the next refresh will pick up. It is disclosed in a note.
   *
   * A KPI in neither set gets NO cell, never a cell reading zero: aggregate()
   * yields pct null for an empty population and null is excluded from every
   * average, but an absent cell is also an absent row, which is the honest
   * rendering of "not this person's KPI".
   */
  const cardKpisFor = (userId: number, branch: string, performed: Set<number>): number[] =>
    enabled.filter((id) => (
      // 7 and 9 are branch readings and must reach no card at all — not even as
      // an empty row. They push no performer, so they can only arrive here
      // through an ownership entry, and "must reach no individual card" has to
      // hold whatever a future refresh writes.
      !BRANCH_ONLY_KPI_IDS.includes(id)
      && (performed.has(id) || ownsKpi(config, branch, id, userId))
    ));

  /** Rule-3 bookkeeping, for the disclosure note after the branches are built. */
  const sharedOut: { branch: string; kpiId: number; verdicts: number; owners: number }[] = [];

  // Five nodes, not seven: the KPI section scores main branches only, so Qatar
  // and EV Hub build no node at all and no station figure is folded into one.
  const branches: BranchNode[] = KPI_BRANCHES.map((b) => {
    const branchEvals = evals.filter((e) => e.branch === b);
    const kpis = aggregate(branchEvals, enabled, snapshotNotes, displayNames, sectionById);

    /**
     * Rule 3: the verdicts with no performer, per KPI.
     *
     * These are the ones where the action never happened at all — no invoice was
     * raised, no RFQ exists, nobody checked the car in — so there is no
     * individual to charge and the engine refused to invent one. Each goes to
     * every owner of that KPI in this branch, because collectively they are who
     * should have done it. It is the only case in the engine where one event is
     * counted against several people, which is why it is disclosed rather than
     * applied quietly.
     *
     * BRANCH_ONLY_KPI_IDS are kept out: 7 and 9 are readings of the branch, and
     * sharing them would fine individuals for a backlog nobody performs.
     */
    const unperformed = new Map<number, Evaluation[]>();
    for (const e of branchEvals) {
      if (e.userId != null) continue;
      if (BRANCH_ONLY_KPI_IDS.includes(e.kpiId)) continue;
      const list = unperformed.get(e.kpiId);
      if (list) list.push(e); else unperformed.set(e.kpiId, [e]);
    }
    for (const [kpiId, list] of unperformed) {
      // The owners who really take it: an owner has to have a card in this
      // branch, so someone off the roster or excluded from scoring is not a
      // recipient and must not be counted as one in the note.
      const takers = scoredRoster.filter(
        (r) => rosterBranches(r).includes(b) && ownsKpi(config, b, kpiId, r.odooUserId),
      ).length;
      sharedOut.push({ branch: b, kpiId, verdicts: list.length, owners: takers });
    }

    // A person appears under every branch they cover, not only a primary one: one
    // user opens job cards and writes quotations in all five branches, and
    // pinning him to one left four fifths of his work scoring a branch while
    // appearing on nobody's card. The same person can therefore hold several
    // cards — one per branch, each carrying that branch's share of their work.
    const serviceAdvisors: SaNode[] = scoredRoster
      .filter((r) => rosterBranches(r).includes(b))
      .map((r) => {
        // Scoped to the branch this card sits under — `branchEvals`, not `evals`.
        // A branch figure is then the sum of the work booked there and a person's
        // figure is their share of it, so the two levels reconcile. Taking all of
        // their work in any branch drew the two cells from different populations,
        // and they could differ by the entire population of a KPI.
        //
        // `userId` is now the person who PERFORMED each action rather than
        // whoever opened the job card, which is what finally lets the invoicing,
        // stage and parts KPIs reach the people who do them.
        const mine = branchEvals.filter((e) => e.userId === r.odooUserId);
        const performed = new Set(mine.map((e) => e.kpiId));
        // No role and no section decides this any more: ownership is derived from
        // Odoo, and work they are personally charged with is on their card
        // whatever ownership says, because it is a fact about them.
        const mineEnabled = cardKpisFor(r.odooUserId, b, performed);
        // Rule 3, applied only to the KPIs they actually OWN here. A KPI that is
        // on this card merely because they performed something on it does not
        // make them answerable for the ones nobody performed.
        const shared = mineEnabled.flatMap(
          (id) => (ownsKpi(config, b, id, r.odooUserId) ? unperformed.get(id) ?? [] : []),
        );
        // Unchanged, and no longer a grouping: `section` still comes from the
        // legacy field because `sections` below — and through it the stored
        // weekly history — is still filed under the two section keys. Neither it
        // nor `roles` has any part in deciding what this card is scored on.
        const section: KpiSection = r.section ?? 'advisor';
        const cells = aggregate([...mine, ...shared], mineEnabled, snapshotNotes, displayNames, sectionById);
        return {
          odooUserId: r.odooUserId,
          name: r.name || mine[0]?.userName || `User ${r.odooUserId}`,
          section,
          roles: rosterRoles(r),
          achievement: overall(cells),
          sections: sectionTotals(cells, config),
          roleAverages: roleTotals(cells, config),
          // Still every RO this person created company-wide: the count is not
          // kept per branch, so a cross-branch person shows the same total on
          // each of their cards. A workload counter, not a KPI figure.
          roCount: roCountByUser[r.odooUserId] ?? 0,
          kpis: cells,
        };
      })
      .sort((a, b2) => (b2.achievement ?? -1) - (a.achievement ?? -1));

    return {
      name: b,
      achievement: overall(kpis),
      sections: sectionTotals(kpis, config),
      roleAverages: roleTotals(kpis, config),
      applicableTotal: kpis.reduce((s, c) => s + c.applicable, 0),
      kpis,
      serviceAdvisors,
    };
  });

  if (!roster.length) {
    notes.push('No service advisors configured yet — set up the SA roster in Admin → KPI Configuration to enable the SA level.');
  }

  // Scoping a card to its branch is a deliberate behaviour change, and it has
  // one cost: work booked to a branch the person is not rostered in used to
  // appear under their single rostered branch, and now appears on no card at
  // all. Counted and named rather than dropped quietly — the ownership map says
  // this is real (one user spans five branches, another three, two more span
  // two), and the remedy is one roster edit.
  //
  // Only rostered, non-excluded people are counted. Work by someone absent from
  // the roster reached no card before this change either, and an excluded
  // person's work is already reported by the exclusion note above.
  const entryById = new Map(scoredRoster.map((r) => [r.odooUserId, r]));
  const strandedByUser = new Map<number, Map<string, number>>();
  for (const e of evals) {
    if (e.userId == null) continue;
    const entry = entryById.get(e.userId);
    if (!entry || rosterBranches(entry).includes(e.branch)) continue;
    // Every verdict naming them in a branch they have no card in is stranded, on
    // any KPI. There is no longer a second test to apply: a KPI they did not own
    // but demonstrably performed would still be on their card in a branch they
    // are rostered in, so the branch is the only thing standing in the way here.
    const perBranch = strandedByUser.get(e.userId) ?? new Map<string, number>();
    perBranch.set(e.branch, (perBranch.get(e.branch) ?? 0) + 1);
    strandedByUser.set(e.userId, perBranch);
  }
  if (strandedByUser.size) {
    const who = [...strandedByUser].map(([uid, perBranch]) => {
      const where = [...perBranch].map(([br, n]) => `${br}: ${n}`).join(', ');
      return `${entryById.get(uid)?.name || `User ${uid}`} (${where})`;
    }).join('; ');
    const n = strandedByUser.size;
    notes.push(`${n} rostered ${n === 1 ? 'person has' : 'people have'} work booked to a branch they are not rostered in, so that work counts for the branch and reaches no individual card — with the number of evaluations per branch: ${who}. A card covers only the branch it appears under, which is what makes a branch's figure the sum of its people's work; until now this work was shown under the person's single rostered branch while counting against a different branch's figure. Add the branch to their roster entry in Admin → KPI Configuration to score it there.`);
  }

  /**
   * Work performed by someone who does not own that KPI in that branch.
   *
   * This replaces the old role-mismatch note, which has no meaning now that
   * ownership is derived rather than configured: there are no two lists left to
   * drift apart. What remains is the real signal — somebody is doing work the
   * derived ownership has not caught up with, almost always because they are
   * below the KPI_OWNER_FLOOR actions per KPI_OWNER_WINDOW_DAYS that earn it, or
   * because they have only just started doing it.
   *
   * Their verdict is NOT dropped: it is on their card, because they demonstrably
   * did the work (see cardKpisFor). This note says so rather than leaving a
   * reader to wonder why a KPI appears on a card the ownership list does not
   * mention.
   *
   * Only people with a card in that branch are counted. Work in a branch they
   * are not rostered in is the note above's business, and counting it twice would
   * read as two separate problems.
   */
  const unownedByUser = new Map<number, Map<string, Map<number, number>>>();
  for (const e of evals) {
    if (e.userId == null) continue;
    const entry = entryById.get(e.userId);
    if (!entry || !rosterBranches(entry).includes(e.branch)) continue;
    if (ownsKpi(config, e.branch, e.kpiId, e.userId)) continue;
    const perBranch = unownedByUser.get(e.userId) ?? new Map<string, Map<number, number>>();
    const perKpi = perBranch.get(e.branch) ?? new Map<number, number>();
    perKpi.set(e.kpiId, (perKpi.get(e.kpiId) ?? 0) + 1);
    perBranch.set(e.branch, perKpi);
    unownedByUser.set(e.userId, perBranch);
  }
  // Silent until ownership exists: with no refresh yet NOBODY owns anything, so
  // this would name every person on the page and repeat what the note above
  // already says plainly.
  if (ownershipDerived && unownedByUser.size) {
    const who = [...unownedByUser].map(([uid, perBranch]) => {
      const what = [...perBranch].map(([br, perKpi]) => {
        const kpis = [...perKpi].map(([id, n]) => `${displayNames[id] ?? `KPI ${id}`}: ${n}`).join(', ');
        return `${br} — ${kpis}`;
      }).join('; ');
      return `${entryById.get(uid)?.name || `User ${uid}`} (${what})`;
    }).join(' | ');
    const n = unownedByUser.size;
    notes.push(`${n} ${n === 1 ? 'person has' : 'people have'} performed work on a KPI they do not own in that branch, with the number of evaluations: ${who}. The verdicts are on their card, because they demonstrably did the work — nothing is dropped. Ownership is derived from Odoo activity and takes more than ${KPI_OWNER_FLOOR} actions in ${KPI_OWNER_WINDOW_DAYS} days to earn, so somebody who has just started doing this work, or who does it occasionally, shows up here until the next refresh picks them up.`);
  }

  /**
   * Rule 3, disclosed wherever it fired.
   *
   * A shared non-compliance is the one case in this engine where several people
   * are marked down for one event, so it cannot be applied silently: the CEO
   * fines from this page, and two people fined for one missing invoice has to be
   * visible as exactly that. The other half is disclosed too — a KPI with no
   * owners in a branch keeps its unperformed verdicts at branch level and they
   * reach nobody, which looks like a gap in the figures unless it is stated.
   */
  const shared = sharedOut.filter((s) => s.owners > 0);
  const orphaned = sharedOut.filter((s) => s.owners === 0);
  if (shared.length) {
    const what = shared
      .map((s) => `${displayNames[s.kpiId] ?? `KPI ${s.kpiId}`} in ${s.branch}: ${s.verdicts} ${s.verdicts === 1 ? 'verdict' : 'verdicts'} across ${s.owners} ${s.owners === 1 ? 'owner' : 'owners'}`)
      .join('; ');
    const total = shared.reduce((n, s) => n + s.verdicts, 0);
    notes.push(`${total} ${total === 1 ? 'verdict' : 'verdicts'} had no performer at all — the action was never carried out, so no individual did it — and ${total === 1 ? 'was' : 'were'} shared across the owners of that KPI in that branch: ${what}. Each owner carries ${total === 1 ? 'it' : 'each of them'} on their own card, so one event can mark down several people. That is deliberate and it is the only place it happens: nobody performed the work, and the alternative was charging it to whoever opened the job card, who in general could not have done it.`);
  }
  // Same guard: before the first refresh every KPI is ownerless by definition,
  // and listing all of them here would bury the one note that explains why.
  if (ownershipDerived && orphaned.length) {
    const what = orphaned
      .map((s) => `${displayNames[s.kpiId] ?? `KPI ${s.kpiId}`} in ${s.branch}: ${s.verdicts}`)
      .join('; ');
    const total = orphaned.reduce((n, s) => n + s.verdicts, 0);
    notes.push(`${total} ${total === 1 ? 'verdict' : 'verdicts'} had no performer and no owner to share with, so ${total === 1 ? 'it stays' : 'they stay'} a branch reading and ${total === 1 ? 'reaches' : 'reach'} no individual card: ${what}. Nobody in that branch has been shown to perform that KPI's action often enough to own it — either the work is not being done there, or whoever does it is below the floor or absent from the roster. The branch and company figures still count ${total === 1 ? 'it' : 'them'} in full.`);
  }

  const companyKpis = aggregate(evals, enabled, snapshotNotes, displayNames, sectionById);

  return {
    week: { start, end },
    generatedAt: new Date().toISOString(),
    company: {
      achievement: overall(companyKpis),
      sections: sectionTotals(companyKpis, config),
      roleAverages: roleTotals(companyKpis, config),
      kpis: companyKpis,
    },
    branches,
    notes,
  };
}

/** Compact snapshot of a computed tree, persisted for deltas and sparklines. */
export function summariseTree(tree: KpiTree): KpiWeekSummary {
  const pcts = (cells: KpiCell[]) =>
    Object.fromEntries(cells.map((c) => [String(c.id), c.pct])) as Record<string, number | null>;
  return {
    weekStart: tree.week.start,
    generatedAt: tree.generatedAt,
    company: { achievement: tree.company.achievement, sections: tree.company.sections, kpis: pcts(tree.company.kpis) },
    branches: Object.fromEntries(
      tree.branches.map((b) => [b.name, { achievement: b.achievement, sections: b.sections, kpis: pcts(b.kpis) }]),
    ),
  };
}
