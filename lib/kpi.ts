/**
 * KPI engine — computes the Company → Branch → Service Advisor tree from live Odoo data.
 *
 * Approach: each KPI produces a flat list of Evaluations
 * ({ kpiId, branch, user, compliant, ref }). One aggregator then rolls that list
 * up at any level, so SA / branch / company numbers all come from the same source
 * and can never disagree.
 *
 * Weekly window: Saturday 00:00 → Friday 23:59 Gulf time (UTC+4).
 */

import {
  WORKSHOP_BRANCHES, Branch, KPI_DEFINITIONS, KpiConfig, StageSelector, SNAPSHOT_KPI_IDS, EXCLUDED_FROM_OVERALL, kpiDisplayName,
  KpiWeekSummary, KpiSection, KPI_SECTION_ORDER, KPI_IDS_FOR_EVERYONE, sectionOf,
} from './types';
import { call, allTrackedCompanyIds, branchCompanyIds, OdooDomain, notHistorical, HISTORICAL_FIELD, isHistorical } from './odoo';
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
  /** Which section this person belongs to; roster entries saved without one are advisors. */
  section: KpiSection;
  achievement: number | null;
  sections: Record<KpiSection, number | null>;
  roCount: number;
  kpis: KpiCell[];
}

export interface BranchNode {
  name: string;
  achievement: number | null;
  sections: Record<KpiSection, number | null>;
  applicableTotal: number;
  kpis: KpiCell[];
  serviceAdvisors: SaNode[];
}

export interface KpiTree {
  week: { start: string; end: string };
  generatedAt: string;
  company: { achievement: number | null; sections: Record<KpiSection, number | null>; kpis: KpiCell[] };
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
  const scored = cells.filter(countsTowardOverall);
  // Deliberately NOT what `overall` averages: the overall is the mean of every
  // scored KPI, not the mean of these two — sections with unequal KPI counts
  // would otherwise reweight the headline figure.
  return Object.fromEntries(
    KPI_SECTION_ORDER.map((s) => [s, meanPct(scored.filter((c) => sectionOf(c.id, config) === s))]),
  ) as Record<KpiSection, number | null>;
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
 */
async function invoicePostedTimes(moveIds: number[]): Promise<Record<number, number>> {
  if (!moveIds.length) return {};
  const out: Record<number, number> = {};
  try {
    const mm = (await call('account.move', 'fields_get', [], { attributes: ['selection'] })) as FieldsMeta;
    const postedLabel = (mm.state?.selection ?? []).find(([v]) => v === 'posted')?.[1];
    if (postedLabel) {
      Object.assign(out, await trackedTransitions('account.move', [
        ['model', '=', 'account.move'],
        ['res_id', 'in', moveIds],
        ['tracking_value_ids', '!=', false],
      ], 'state', [postedLabel]));
    }
  } catch { /* chatter unavailable — fall back below */ }

  const missing = moveIds.filter((id) => out[id] == null);
  if (missing.length) {
    try {
      const moves = (await call('account.move', 'read', [missing], {
        fields: ['invoice_date', 'create_date', 'state'],
      })) as Rec[];
      for (const m of moves) {
        if (m.state !== 'posted') continue;
        const d = typeof m.invoice_date === 'string' ? Date.parse(`${m.invoice_date}T00:00:00Z`) : NaN;
        const t = Number.isNaN(d) ? odooTime(m.create_date) : d;
        if (t != null) out[m.id as number] = t;
      }
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * RO id → when its earliest linked invoice was posted.
 *
 * Two link shapes exist depending on the Odoo version: a direct invoice_id on the
 * repair order, and the sale order's invoice_ids. Both are followed.
 */
async function invoiceTimesForRos(ros: Rec[]): Promise<Record<number, number>> {
  const roMoves: Record<number, number[]> = {};
  for (const r of ros) {
    const direct = m2o(r.invoice_id)?.[0];
    if (direct != null) roMoves[r.id as number] = [direct];
  }

  const soIds = [...new Set(ros.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))];
  const soToMoves: Record<number, number[]> = {};
  if (soIds.length) {
    try {
      const sos = (await call('sale.order', 'read', [soIds], { fields: ['invoice_ids'] })) as { id: number; invoice_ids?: number[] }[];
      for (const so of sos) soToMoves[so.id] = so.invoice_ids ?? [];
    } catch { /* direct links may still carry us */ }
  }
  for (const r of ros) {
    const soId = m2o(r.sale_order_id)?.[0];
    if (soId == null) continue;
    const ids = new Set([...(roMoves[r.id as number] ?? []), ...(soToMoves[soId] ?? [])]);
    if (ids.size) roMoves[r.id as number] = [...ids];
  }

  const posted = await invoicePostedTimes([...new Set(Object.values(roMoves).flat())]);
  const out: Record<number, number> = {};
  for (const [roId, moves] of Object.entries(roMoves)) {
    const times = moves.map((id) => posted[id]).filter((t): t is number => t != null);
    if (times.length) out[Number(roId)] = Math.min(...times);
  }
  return out;
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
const TAG_FIELDS = ['tag_ids', 'x_studio_stages_tags'] as const;

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
async function resolveTagMatches(
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
function anyTagDomain(matches: TagMatch[]): OdooDomain {
  const live = matches.filter((m) => m.ids.size);
  if (!live.length) return [['id', '=', 0]];
  const clauses: OdooDomain = live.map((m) => [m.field, 'in', [...m.ids]] as [string, string, unknown]);
  // Odoo domains are prefix notation: n clauses need n-1 leading '|'.
  return [...Array(live.length - 1).fill('|'), ...clauses];
}

/** Does this record carry one of the matched tags in any of its tag fields? */
function hasAnyTag(rec: Rec, matches: TagMatch[]): boolean {
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
 * When each RO actually entered the given state, read from Odoo's chatter/tracking
 * log (mail.message + mail.tracking.value). Returns roId → epoch ms of the most
 * recent transition into one of `labels`. Returns {} if tracking isn't readable,
 * so callers fall back to a date proxy.
 */
async function stateEntryTimes(roIds: number[], field: string, labels: string[]): Promise<Record<number, number>> {
  if (!roIds.length || !labels.length) return {};
  return trackedTransitions('repair.order', [
    ['model', '=', 'repair.order'],
    ['res_id', 'in', roIds],
    ['tracking_value_ids', '!=', false],
  ], field, labels);
}

/**
 * ROs that ENTERED one of `labels` at any point during [from, to) — regardless of
 * what state they're in now. This is what makes past weeks meaningful: an RO
 * repaired last week has since moved on, so filtering by current state finds
 * nothing.
 */
/**
 * Every tracked change of `field` per RO, ascending: [{ t, label }].
 *
 * trackedTransitions only answers "when did it arrive"; this answers "and when
 * did it leave", which is what a dwell-time KPI needs.
 */
async function stateTimeline(roIds: number[], field: string): Promise<Record<number, { t: number; label: string }[]>> {
  if (!roIds.length) return {};
  try {
    const msgs = (await call('mail.message', 'search_read', [[
      ['model', '=', 'repair.order'],
      ['res_id', 'in', roIds],
      ['tracking_value_ids', '!=', false],
    ]], { fields: ['res_id', 'date', 'tracking_value_ids'], limit: 0 })) as Rec[];
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

    const out: Record<number, { t: number; label: string }[]> = {};
    for (const m of msgs) {
      const t = odooTime(m.date);
      if (t == null) continue;
      for (const id of (m.tracking_value_ids as number[] | undefined) ?? []) {
        const label = labelOf.get(id);
        if (!label) continue;
        (out[m.res_id as number] ??= []).push({ t, label });
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
): Promise<Record<number, number>> {
  if (!labels.length) return {};
  return trackedTransitions('repair.order', [
    ['model', '=', 'repair.order'],
    ['date', '>=', from], ['date', '<', to],
    ['tracking_value_ids', '!=', false],
  ], field, labels);
}

/** Shared chatter-log reader: message domain → { roId: epoch ms of transition }. */
async function trackedTransitions(model: string, msgDomain: OdooDomain, field: string, labels: string[]): Promise<Record<number, number>> {
  try {
    const msgs = (await call('mail.message', 'search_read', [msgDomain], {
      fields: ['res_id', 'date', 'tracking_value_ids'], limit: 0,
    })) as Rec[];
    if (!msgs.length) return {};

    const tvIds = [...new Set(msgs.flatMap((m) => (m.tracking_value_ids as number[] | undefined) ?? []))];
    if (!tvIds.length) return {};

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
    if (!hits.size) return {};

    const out: Record<number, number> = {};
    for (const m of msgs) {
      const ids = (m.tracking_value_ids as number[] | undefined) ?? [];
      if (!ids.some((id) => hits.has(id))) continue;
      const t = odooTime(m.date);
      const rid = m.res_id as number;
      if (t == null) continue;
      if (out[rid] == null || t > out[rid]) out[rid] = t; // most recent entry
    }
    return out;
  } catch {
    return {}; // tracking unavailable — caller falls back
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

  const trackedIds = await allTrackedCompanyIds();

  // company id → branch
  const idToBranch: Record<number, Branch> = {};
  // EV Hub is absent, so its companies never resolve to a branch and its
  // records drop out of every KPI at the push() guard.
  for (const b of WORKSHOP_BRANCHES) for (const id of await branchCompanyIds(b)) idToBranch[id] = b;

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
  // Which date KPIs 6 & 7 age from. `auto` prefers a true stage-change stamp and
  // otherwise falls back to create_date — deliberately NOT write_date, which any
  // edit resets and which therefore hides genuinely stale vehicles.
  const basis = config.ageBasis ?? 'auto';
  const ageField =
    basis === 'auto'
      ? (has('date_last_stage_update') ? 'date_last_stage_update' : 'create_date')
      : (has(basis) ? basis : 'create_date');
  const AGE_LABEL: Record<string, string> = {
    date_last_stage_update: 'time since the last stage change',
    create_date: 'age of the repair order',
    write_date: 'time since last modification — any edit resets this clock',
  };
  const baselineDaysNote = config.thresholds.snapshotBaselineDays ?? 90;
  let snapshotNote = `Scored against open ROs created in the last ${baselineDaysNote} days (closed work is excluded); a vehicle counts against you if it is stuck beyond the limit right now. Ageing measured by ${AGE_LABEL[ageField] ?? ageField}.`;
  let usedTrackingForAging = false;
  let awaitingPartsMethod = 'outstanding parts lines (Done qty below Demand)';
  if (ageField === 'write_date') {
    notes.push('KPIs 6 & 7 are measured from write_date — any edit resets the clock, so violations may be undercounted.');
  }
  if (!has('sale_order_id')) {
    notes.push('repair.order has no sale_order_id — KPIs 1, 3 and 4 cannot be evaluated.');
  }

  const evals: Evaluation[] = [];
  const roCountByUser: Record<number, number> = {};

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

  const push = (kpiId: number, rec: Rec, compliant: boolean, ref: string) => {
    const cid = m2o(rec.company_id)?.[0];
    const branch = cid != null ? idToBranch[cid] : undefined;
    if (!branch) return; // untracked company (CarDIP, …)
    const u = m2o(rec.create_uid);
    evals.push({
      kpiId, branch,
      userId: u?.[0] ?? null,
      userName: u?.[1] ?? 'Unknown',
      compliant, ref,
    });
  };

  /**
   * Quotations whose every repair order has been moved to Historical — dead work
   * nobody should be scored on.
   *
   * The KPIs built from sale.order never meet the historical filter on
   * repair.order, so they ask here instead. "No repair order at all" is a
   * quotation in its own right and one live order means the work is still live,
   * so this query must see BOTH sides: adding `notHist` would hide the historical
   * rows and make the two cases indistinguishable. Ids it does not return stay
   * scored, which is why a failed chunk costs nothing.
   */
  const deadQuotations = async (soIds: number[]): Promise<Set<number>> => {
    const dead = new Set<number>();
    if (!has('sale_order_id') || !histField.length || !soIds.length) return dead;
    const live = new Map<number, boolean>();
    for (let i = 0; i < soIds.length; i += 2000) {
      try {
        const ros = (await call('repair.order', 'search_read', [[
          ['sale_order_id', 'in', soIds.slice(i, i + 2000)],
        ]], { fields: ['sale_order_id', ...histField], limit: 0 })) as Rec[];
        for (const r of ros) {
          const id = m2o(r.sale_order_id)?.[0];
          // OR-accumulated, so the order the rows arrive in cannot matter.
          if (id != null) live.set(id, (live.get(id) ?? false) || !isHistorical(r));
        }
      } catch { /* a failed chunk leaves its quotations out of the map, so they stay scored rather than vanishing from the KPI */ }
    }
    for (const [id, isLive] of live) if (!isLive) dead.add(id);
    return dead;
  };

  // Shared by every weekly repair.order query, so the historical clause lands on
  // all of them from here.
  const weekDomain: OdooDomain = [
    ['create_date', '>=', wStart],
    ['create_date', '<', wEnd],
    ['company_id', 'in', trackedIds],
    ...notHist,
  ];
  const enabled = config.enabledKpis ?? [];
  const on = (id: number) => enabled.includes(id);

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
    // Odoo makes the screenshot read-only unless repair_is_qa is set, so the flag
    // decides who the KPI can fairly apply to.
    const qaFlagField = on(13) && has('repair_is_qa') ? 'repair_is_qa' : undefined;
    if (qaFlagField) roFields.push(qaFlagField);
    if (on(13) && !followUpField) {
      notes.push('Customer follow-up is inactive — no follow-up screenshot field found on repair.order.');
    }
    roFields.push(...histField);   // the chatter branch below reads by id, past any domain
    const roCtx = { bin_size: true };
    const tfRepaired = trackedField(config.stageMap.repaired, meta, stageNames);

    // Preferred: ROs that reached the repaired/delivered state during this week,
    // whatever state they're in now. Falls back to current-state matching.
    let deliveredAt = tfRepaired
      ? await roIdsEnteringStateInWindow(tfRepaired.field, tfRepaired.labels, wStart, wEnd)
      : {};
    const enteredIds = Object.keys(deliveredAt).map(Number);

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
        deliveredAt = await stateEntryTimes(repaired.map((r) => r.id as number), tfRepaired.field, tfRepaired.labels);
      }
    }

    const invoicedAt = (on(1) || on(11)) ? await invoiceTimesForRos(repaired) : {};

    /** Judge repaired → invoice-posted against a time limit. */
    const judgeInvoiceTiming = (kpiId: number, limitMs: number) => {
      for (const r of repaired) {
        const rep = deliveredAt[r.id as number];
        if (rep == null) continue;                 // no repaired timestamp → not measurable
        const inv = invoicedAt[r.id as number];
        const ref = (r.name as string) || '';
        if (inv != null) push(kpiId, r, elapsed(rep, inv) <= limitMs, ref);
        // The running clock is business time too, or a Thursday repair would be
        // failed by the weekend before anyone could invoice it.
        else if (elapsed(rep, now) > limitMs) push(kpiId, r, false, ref);  // overdue, still uninvoiced
        // still inside the window and uninvoiced → not judged yet
      }
    };

    if (on(1)) judgeInvoiceTiming(1, businessHours(config.thresholds.invoiceHours ?? 1));
    if (on(11)) judgeInvoiceTiming(11, businessHours(config.thresholds.deliveryHours ?? 48));

    // Follow-up is the one KPI here that is not a stopwatch: a vehicle either has
    // the screenshot or it does not. No timestamp is involved, so it survives the
    // chatter fallback.
    //
    // Scope matters more than timing here. Odoo makes follow_up_screenshot
    // read-only unless repair_is_qa is set, so an RO that never went through QA
    // CANNOT carry one. Judging those would mark advisors down for a box Odoo
    // never let them fill.
    if (on(13) && followUpField) {
      const eligible = qaFlagField ? repaired.filter((r) => !!r[qaFlagField]) : repaired;
      for (const r of eligible) push(13, r, !!r[followUpField], (r.name as string) || '');
      if (qaFlagField && repaired.length && !eligible.length) {
        notes.push(`None of this week's ${repaired.length} repaired ROs were flagged for QA, so the follow-up screenshot could not be uploaded on any of them.`);
      }
    }

    // ── KPI 22 — did the vehicle reach Repaired by the promised date? ──
    //
    // A deadline, not a duration: the promise is a wall-clock moment the customer
    // was given, so it is compared raw. Running it through the business clock
    // would move the promise itself.
    if (on(22) && scheduleField) {
      // A date-only promise means "that day", so it falls due as the day closes.
      const dateOnly = meta[scheduleField]?.type === 'date';
      let unpromised = 0;
      for (const r of repaired) {
        const rep = deliveredAt[r.id as number];
        if (rep == null) continue;                 // no repaired timestamp → not measurable
        const raw = r[scheduleField];
        const due = dateOnly && typeof raw === 'string'
          ? Date.parse(`${raw}T23:59:59+04:00`)
          : odooTime(raw);
        // Nothing promised, so nothing can be late.
        if (due == null || !Number.isFinite(due)) { unpromised++; continue; }
        push(22, r, rep <= due, (r.name as string) || '');
      }
      if (unpromised) {
        notes.push(`Ready by promised time skipped ${unpromised} repaired RO${unpromised === 1 ? '' : 's'} with no scheduled delivery date — nothing was promised, so nothing can be late.`);
      }
    }
    if (on(22) && !scheduleField) {
      notes.push('Ready by promised time is inactive — repair.order carries no schedule_date to judge the promise against.');
    }

    if (!Object.keys(deliveredAt).length) {
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
    let entered = tf ? await roIdsEnteringStateInWindow(tf.field, tf.labels, wStart, wEnd) : {};
    const startedIds = Object.keys(entered).map(Number);

    let inRepair: Rec[];
    if (startedIds.length) {
      // Read by id, so the domain cannot help — drop them before any quote is judged.
      inRepair = ((await call('repair.order', 'read', [startedIds], { fields: roFields })) as Rec[])
        .filter((r) => !isHistorical(r));
    } else {
      inRepair = (await call('repair.order', 'search_read', [[
        ...selectorDomain(config.stageMap.underRepair), ...weekDomain,
      ]], { fields: roFields, limit: 0 })) as Rec[];
      if (tf) entered = await stateEntryTimes(inRepair.map((r) => r.id as number), tf.field, tf.labels);
    }

    // Quotation creation and approval times. date_order is when Odoo confirms a
    // quotation into a sale order — i.e. the moment the customer approved it.
    const soIds = [...new Set(inRepair.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))];
    const soCreated: Record<number, number> = {};
    const soApproved: Record<number, number> = {};
    if (soIds.length) {
      try {
        const sos = (await call('sale.order', 'read', [soIds], { fields: ['create_date', 'date_order', 'state'] })) as Rec[];
        for (const so of sos) {
          const c = odooTime(so.create_date);
          if (c != null) soCreated[so.id as number] = c;
          if (so.state === 'sale' || so.state === 'done') {
            const a = odooTime(so.date_order);
            if (a != null) soApproved[so.id as number] = a;
          }
        }
      } catch { /* fall back to existence-only below */ }
    }

    let sequenceChecked = 0;
    for (const r of inRepair) {
      const ref = (r.name as string) || '';
      const soId = m2o(r.sale_order_id)?.[0] ?? null;
      const startedAt = entered[r.id as number];

      if (on(4)) {
        if (soId == null) push(4, r, false, ref);              // no quote at all
        else {
          const quotedAt = soCreated[soId];
          if (startedAt != null && quotedAt != null) {
            sequenceChecked++;
            push(4, r, quotedAt <= startedAt, ref);            // quote must pre-date repair start
          } else {
            push(4, r, true, ref);                             // exists, sequence unverifiable
          }
        }
      }

      if (on(3)) {
        // The quotation must have been APPROVED (confirmed into a sale order)
        // before the RO moved into Under Repair.
        if (soId == null) push(3, r, false, ref);
        else {
          const approvedAt = soApproved[soId];
          if (approvedAt == null) push(3, r, false, ref);       // never approved
          else if (startedAt != null) push(3, r, approvedAt <= startedAt, ref);
          else push(3, r, true, ref);                           // approved, sequence unverifiable
        }
      }
    }
    if (inRepair.length && sequenceChecked === 0) {
      notes.push(tf
        ? `No "${tf.labels.join('/')}" transitions found on ${tf.field} in the chatter, so the quotation KPIs only check that a quotation exists rather than that it came first.`
        : 'Under repair is not mapped, so the quotation KPIs only check that a quotation exists.');
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
    const graceMs = (config.thresholds.tagMinutes ?? 60) * 60_000;

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
    const limitMs = businessHours(config.thresholds.quoteApprovalHours ?? 48);
    // (a) Still-open quotations: compliant while they're inside the window.
    const open = (await call('sale.order', 'search_read', [[
      ['state', 'in', ['draft', 'sent']],
      ['company_id', 'in', trackedIds],
    ]], { fields: ['name', 'create_uid', 'company_id', 'create_date'], limit: 0 })) as Rec[];
    // (b) Quotations confirmed during the week: was approval inside the window?
    const confirmed = (await call('sale.order', 'search_read', [[
      ['state', 'in', ['sale', 'done']],
      ['date_order', '>=', wStart], ['date_order', '<', wEnd],
      ['company_id', 'in', trackedIds],
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

    // Quotations whose every repair order has gone to Historical are dead work.
    const dead = await deadQuotations(soIds);

    let historicalSkipped = 0;
    for (const q of open) {
      if (insuranceExempt.has(q.id as number)) continue;
      if (dead.has(q.id as number)) { historicalSkipped++; continue; }
      const created = odooTime(q.create_date);
      if (created == null) continue;
      // Still open, so the clock is still running — on business time, or a
      // quotation raised on Thursday would fail over a weekend nobody worked.
      push(2, q, elapsed(created, now) <= limitMs, (q.name as string) || '');
    }
    for (const q of confirmed) {
      if (insuranceExempt.has(q.id as number)) continue;
      if (dead.has(q.id as number)) { historicalSkipped++; continue; }
      const created = odooTime(q.create_date);
      const approved = odooTime(q.date_order);
      if (created == null || approved == null) continue;
      push(2, q, elapsed(created, approved) <= limitMs, (q.name as string) || '');
    }
    if (insuranceExempt.size) {
      notes.push(`Quote approval excluded ${insuranceExempt.size} insurance quotation${insuranceExempt.size === 1 ? '' : 's'} — approval there is the insurer's to give.`);
    }
    if (historicalSkipped) {
      notes.push(`Quote approval excluded ${historicalSkipped} quotation${historicalSkipped === 1 ? '' : 's'} whose repair orders have all been moved to Historical — that work is out of the working set.`);
    }
  }

  // ── KPI 21 — quotation approval rate ──
  //
  // A rate, not a stopwatch: there is no limit and no tri-state, so every
  // quotation raised this week is counted, approved or not.
  if (on(21)) {
    const quotes = (await call('sale.order', 'search_read', [[
      ['create_date', '>=', wStart], ['create_date', '<', wEnd],
      ['company_id', 'in', trackedIds],
    ]], { fields: ['name', 'create_uid', 'company_id', 'state'], limit: 0 })) as Rec[];

    // Same dead-work rule as Quote approval — nobody is scored on a quotation
    // whose every repair order has been moved to Historical.
    const dead = await deadQuotations(quotes.map((q) => q.id as number));
    let historicalSkipped = 0;
    const byState: Record<string, number> = {};
    for (const q of quotes) {
      if (dead.has(q.id as number)) { historicalSkipped++; continue; }
      const st = String(q.state ?? 'unknown');
      byState[st] = (byState[st] ?? 0) + 1;
      // Confirmed into a sale order is what "the customer approved it" looks like.
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
      notes.push(`Quotation approval rate excluded ${historicalSkipped} quotation${historicalSkipped === 1 ? '' : 's'} whose repair orders have all been moved to Historical.`);
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
      : {};
    let closedSet = new Set(Object.keys(closedThisWeek).map(Number));

    if (!closedSet.size) {
      // No chatter history — fall back to "created this week and closed now".
      const nowClosed = (await call('repair.order', 'search_read', [[
        ...selectorDomain(config.stageMap.closed), ...weekDomain,
      ]], { fields: ['id'], limit: 0 })) as Rec[];
      closedSet = new Set(nowClosed.map((r) => r.id as number));
    }

    for (const r of received) push(9, r, closedSet.has(r.id as number), (r.name as string) || '');
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
  const tfQa = trackedField(config.stageMap.qa, meta, stageNames);

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
    const limitMs = businessHours(config.thresholds.checkInHours ?? 3);
    const weekROs = (await call('repair.order', 'search_read', [weekDomain], {
      fields: ['name', 'create_uid', 'company_id', 'create_date'], limit: 0,
    })) as Rec[];
    // Full stage history, not just the Inspection hits, so a silent RO can be told
    // apart from one that genuinely skipped check-in.
    const timeline = await stateTimeline(weekROs.map((r) => r.id as number), tfInspection.field);

    let unobserved = 0, judged = 0;
    for (const r of weekROs) {
      const roAt = odooTime(r.create_date);
      if (roAt == null) continue;
      const ref = (r.name as string) || '';
      const events = timeline[r.id as number] ?? [];
      const hits = events.filter((e) => tfInspection.labels.includes(e.label));

      if (hits.length) {
        judged++;
        push(14, r, elapsed(roAt, hits[0].t) <= limitMs, ref);   // FIRST arrival is the check-in
        continue;
      }
      // No Inspection on record. Only a failure if we have some other stage change
      // for this RO — that proves tracking was live and it really did skip check-in.
      if (!events.length) { unobserved++; continue; }
      // Business time while the clock runs, so an RO raised at closing is not
      // failed by the night it sat through.
      if (elapsed(roAt, now) > limitMs) { judged++; push(14, r, false, ref); }
    }
    if (unobserved) {
      notes.push(`Check-in ignored ${unobserved} of ${weekROs.length} ROs with no stage history at all — they moved before tracking was switched on, so their check-in was never recorded. Judged ${judged}.`);
    }
  }

  // KPIs 15 & 12 — inspection start → quotation created. Same measurement, two
  // business-hour windows: 15 is how long inspection itself may run, 12 is the
  // tighter promise on getting the quote out.
  if ((on(12) || on(15)) && tfInspection && has('sale_order_id')) {
    const entered = await roIdsEnteringStateInWindow(tfInspection.field, tfInspection.labels, wStart, wEnd);
    const ids = Object.keys(entered).map(Number);
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
      if (soIds.length) {
        try {
          const sos = (await call('sale.order', 'read', [soIds], { fields: ['create_date'] })) as Rec[];
          for (const so of sos) {
            const t = odooTime(so.create_date);
            if (t != null) soCreated[so.id as number] = t;
          }
        } catch { /* unreadable — the tri-state below still catches overruns */ }
      }

      const judgeQuoteTiming = (kpiId: number, limitMs: number) => {
        for (const r of ros) {
          const from = entered[r.id as number];
          if (from == null) continue;
          const ref = (r.name as string) || '';
          const soId = m2o(r.sale_order_id)?.[0] ?? null;
          const quotedAt = soId != null ? soCreated[soId] : undefined;
          if (quotedAt != null) push(kpiId, r, elapsed(from, quotedAt) <= limitMs, ref);
          // The unquoted clock runs on business time as well — otherwise the
          // weekend, not the workshop, decides the overrun.
          else if (elapsed(from, now) > limitMs) push(kpiId, r, false, ref);  // still unquoted, window gone
        }
      };

      if (on(15)) judgeQuoteTiming(15, businessHours(config.thresholds.inspectionHours ?? 27));
      if (on(12)) judgeQuoteTiming(12, businessHours(config.thresholds.quoteSentHours ?? 4));
    }
  }

  // KPI 16 — how long the RO actually sat in QA.
  if (on(16) && tfQa) {
    const limitMs = businessHours(config.thresholds.qaHours ?? 9);
    const entered = await roIdsEnteringStateInWindow(tfQa.field, tfQa.labels, wStart, wEnd);
    const ids = Object.keys(entered).map(Number);
    if (!ids.length) {
      notes.push(`No repair order entered "${tfQa.labels.join('/')}" during this week according to the chatter — QA duration has nothing to measure.`);
    }

    if (ids.length) {
      // Ids come from the chatter, so the historical ones have to be dropped here.
      const ros = ((await call('repair.order', 'read', [ids], {
        fields: ['name', 'create_uid', 'company_id', ...histField],
      })) as Rec[]).filter((r) => !isHistorical(r));
      const timeline = await stateTimeline(ids, tfQa.field);

      for (const r of ros) {
        const ref = (r.name as string) || '';
        const events = timeline[r.id as number] ?? [];
        // The last arrival in QA, and whatever state change followed it.
        let enterIdx = -1;
        for (let i = 0; i < events.length; i++) if (tfQa.labels.includes(events[i].label)) enterIdx = i;
        const from = enterIdx >= 0 ? events[enterIdx].t : entered[r.id as number];
        if (from == null) continue;
        const left = enterIdx >= 0 && enterIdx + 1 < events.length ? events[enterIdx + 1].t : null;

        if (left != null) push(16, r, elapsed(from, left) <= limitMs, ref);
        // Still in QA: business time only, so an overnight wait is not an overrun.
        else if (elapsed(from, now) > limitMs) push(16, r, false, ref);  // still in QA, over the limit
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

      // ── KPI 18 — RFQ raised within N days of the quotation being approved ──
      if (on(18)) {
        const limitMs = (config.thresholds.rfqAfterApprovalDays ?? 1) * 86400_000;
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
              ['company_id', 'in', trackedIds],
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
                ['company_id', 'in', trackedIds],
                ...notHist,
              ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', 'sale_order_id', 'fleet_id'], limit: 0 })) as Rec[]);
            } catch { /* a failed chunk leaves its orders unjudged rather than failing the KPI */ }
          }

          // When each vehicle had a purchase order raised against it. Every state
          // counts: a draft — or even a later cancelled — RFQ was still raised.
          const fleetIds = [...new Set(ros.map((r) => m2o(r.fleet_id)?.[0]).filter((x): x is number => x != null))];
          const rfqTimes: Record<number, number[]> = {};
          for (let i = 0; i < fleetIds.length; i += 2000) {
            try {
              const pos = (await call('purchase.order', 'search_read', [[
                ['fleet_id', 'in', fleetIds.slice(i, i + 2000)],
              ]], { fields: ['fleet_id', 'create_date'], limit: 0 })) as Rec[];
              for (const po of pos) {
                const fleet = m2o(po.fleet_id)?.[0];
                const t = poTime(po.create_date);
                if (fleet != null && t != null) (rfqTimes[fleet] ??= []).push(t);
              }
            } catch { /* this chunk's vehicles simply have no RFQ times */ }
          }

          // Attributed through the REPAIR ORDER: when the RFQ is the thing
          // missing there is no purchase order to hang the miss on, so the job
          // card's owner is the only stable subject.
          let noVehicle = 0;
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
            const raised = (rfqTimes[fleet] ?? [])
              .some((t) => t <= approved + limitMs && (roCreated == null || t >= roCreated));
            const ref = (r.name as string) || '';
            if (raised) push(18, r, true, ref);
            else if (now - approved > limitMs) push(18, r, false, ref);
            // still inside the window with no RFQ yet → not judged
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
        } else {
          const limitMs = (config.thresholds.rfqConfirmDays ?? 1) * 86400_000;
          let raised: Rec[] = [];
          try {
            // Cancelled RFQs are out of the population: a withdrawn request was
            // never waiting on a confirmation, so counting it would read as a
            // failure to confirm something nobody wanted any more.
            raised = (await call('purchase.order', 'search_read', [[
              ['create_date', '>=', wStart], ['create_date', '<', wEnd],
              ['state', '!=', 'cancel'],
              ['company_id', 'in', trackedIds],
            ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', 'state', 'date_approve'], limit: 0 })) as Rec[];
          } catch {
            notes.push('RFQ confirmed (KPI 19) could not read the purchase orders raised this week.');
          }

          let undated = 0;
          for (const po of raised) {
            const created = poTime(po.create_date);
            if (created == null) continue;
            const ref = (po.name as string) || '';
            const confirmed = poTime(po.date_approve);
            if (confirmed != null) push(19, po, confirmed - created <= limitMs, ref);
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
          const limitMs = (config.thresholds.partsPlacedDays ?? 21) * 86400_000;
          const poFields = ['name', 'create_uid', 'company_id', 'fleet_id', 'date_approve'];
          if (poHas('effective_date')) poFields.push('effective_date');
          let confirmedPos: Rec[] = [];
          try {
            confirmedPos = (await call('purchase.order', 'search_read', [[
              ['date_approve', '>=', wStart], ['date_approve', '<', wEnd],
              ['state', 'in', CONFIRMED_STATES],
              ['company_id', 'in', trackedIds],
            ]], { fields: poFields, limit: 0 })) as Rec[];
          } catch {
            notes.push('Parts placed (KPI 20) could not read the purchase orders confirmed this week.');
          }

          // Every live repair order for the vehicles involved, oldest first. The
          // job is chosen per purchase order below, not per vehicle.
          const fleetIds = [...new Set(confirmedPos.map((po) => m2o(po.fleet_id)?.[0]).filter((x): x is number => x != null))];
          type Job = { id: number; created: number; lines: number[] };
          const jobsByFleet: Record<number, Job[]> = {};
          for (let i = 0; i < fleetIds.length; i += 2000) {
            try {
              const ros = (await call('repair.order', 'search_read', [[
                ['fleet_id', 'in', fleetIds.slice(i, i + 2000)],
                ['create_date', '<', wEnd],
                ...notHist,
              ]], { fields: ['fleet_id', 'create_date', parts.lineField], limit: 0 })) as Rec[];
              for (const r of ros) {
                const fleet = m2o(r.fleet_id)?.[0];
                const created = odooTime(r.create_date);
                if (fleet == null || created == null) continue;
                (jobsByFleet[fleet] ??= []).push({
                  id: r.id as number,
                  created,
                  lines: (r[parts.lineField] as number[] | undefined) ?? [],
                });
              }
            } catch { /* this chunk's vehicles stay unlinked rather than dropping the KPI */ }
          }
          for (const list of Object.values(jobsByFleet)) list.sort((a, b) => a.created - b.created);

          /**
           * The job this purchase order was bought for: the newest live repair
           * order already open when it was confirmed. Matching on the vehicle
           * alone would just as happily pick a visit from two years ago and judge
           * today's parts against a job that closed long before them.
           */
          const jobFor = (fleet: number | null, at: number): Job | null => {
            if (fleet == null) return null;
            let best: Job | null = null;
            for (const job of jobsByFleet[fleet] ?? []) {
              if (job.created > at) break;   // ascending, so nothing later can qualify
              best = job;
            }
            return best;
          };

          const placements: { po: Rec; at: number; lines: number[] }[] = [];
          let unlinked = 0;
          for (const po of confirmedPos) {
            const at = poTime(po.date_approve);
            if (at == null) continue;
            const job = jobFor(m2o(po.fleet_id)?.[0] ?? null, at);
            if (!job) { unlinked++; continue; }   // no job card to receive against
            placements.push({ po, at, lines: job.lines });
          }

          const lineInfo = await readPartsLines(parts, [...new Set(placements.flatMap((p) => p.lines))]);

          let noArrival = 0;
          for (const p of placements) {
            const ref = (p.po.name as string) || '';
            // Judged on the whole job card, not this order's own lines: one job's
            // parts routinely arrive across several purchase orders, and the
            // vehicle is only unblocked when the last of them is in.
            const complete = p.lines.every((id) => !lineInfo[id]?.short);
            if (complete) {
              const landed = poTime(p.po.effective_date);
              if (landed != null) push(20, p.po, landed - p.at <= limitMs, ref);
              else { noArrival++; push(20, p.po, true, ref); }   // generous, and counted below
            } else if (now - p.at > limitMs) {
              push(20, p.po, false, ref);   // still short, window gone
            }
            // still short but inside the window → not judged
          }
          if (noArrival) {
            notes.push(`Parts placed accepted ${noArrival} purchase order${noArrival === 1 ? '' : 's'} as on time whose parts are complete but which carry no Arrival date, so the receipt itself could not be timed.`);
          }
          if (unlinked) {
            notes.push(`Parts placed skipped ${unlinked} confirmed purchase order${unlinked === 1 ? '' : 's'} with no live repair order open for that vehicle at the moment of confirmation.`);
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
    const limitMs = businessHours(config.thresholds.mentionResponseHours ?? 1);
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

          type Judgement = { partner: number; compliant: boolean; ref: string; branch: Branch };
          const judgements: Judgement[] = [];
          const involved = new Set<number>();
          let pending = 0;

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
              involved.add(author);

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

              // 2. A new request — but not back at whoever was just answered.
              const recipients = (m[recipientField] as number[] | undefined) ?? [];
              const candidates = mentionOrder(m.body, recipients)
                .filter((pid) => pid !== author && !answered.has(pid));
              if (!candidates.length) continue;
              for (const pid of candidates) involved.add(pid);
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

          // Names for display, user ids for attribution.
          const partnerIds = [...involved];
          const names: Record<number, string> = {};
          const userIds: Record<number, number> = {};
          if (partnerIds.length) {
            try {
              const partners = (await call('res.partner', 'read', [partnerIds], { fields: ['display_name'] })) as Rec[];
              for (const pt of partners) names[pt.id as number] = (pt.display_name as string) || `Partner ${pt.id}`;
            } catch { /* fall back to the id below */ }
            try {
              const users = (await call('res.users', 'search_read', [[['partner_id', 'in', partnerIds]]], {
                fields: ['partner_id'], limit: 0,
              })) as Rec[];
              for (const usr of users) {
                const pid = m2o(usr.partner_id)?.[0];
                if (pid != null) userIds[pid] = usr.id as number;
              }
            } catch { /* attribute to the partner name alone */ }
          }

          for (const j of judgements) {
            pushFor(17, j.branch, { id: userIds[j.partner] ?? null, name: names[j.partner] ?? `Partner ${j.partner}` }, j.compliant, j.ref);
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
    // Baseline population: OPEN ROs created in the last N days. Closed work is
    // excluded deliberately — a car that has already left cannot be waiting on
    // anything, and counting thousands of them buried the signal: a few hundred
    // genuinely stuck vehicles read as a comfortable 98%.
    const baselineDays = config.thresholds.snapshotBaselineDays ?? 90;
    const sinceIso = new Date(now - baselineDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const baseROs = (await call('repair.order', 'search_read', [[
      ['create_date', '>=', sinceIso],
      ...selectorDomainNot(config.stageMap.closed),
      ['company_id', 'in', trackedIds],
      ...notHist,
    ]], { fields: ['name', 'create_uid', 'company_id'], limit: 0 })) as Rec[];

/** Every open RO in the window counts; the stuck ones are the violations. */
    const scoreAgainstBaseline = (kpiId: number, overdue: Map<number, Rec>) => {
      const seen = new Set<number>();
      for (const r of baseROs) {
        const id = r.id as number;
        seen.add(id);
        push(kpiId, r, !overdue.has(id), (r.name as string) || '');
      }
      // Stuck vehicles older than the window still count against us.
      for (const [id, r] of overdue) {
        if (!seen.has(id)) push(kpiId, r, false, (r.name as string) || '');
      }
    };

    /** Currently-open ROs held past `days` in a mapped state (used for labour). */
    const overdueByState = async (sel: StageSelector, days: number) => {
      const recs = (await call('repair.order', 'search_read', [[
        ...selectorDomain(sel),
        ['company_id', 'in', trackedIds],
        ...notHist,
      ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', ageField], limit: 0 })) as Rec[];
      const tf = trackedField(sel, meta, stageNames);
      const entered = tf ? await stateEntryTimes(recs.map((r) => r.id as number), tf.field, tf.labels) : {};
      if (Object.keys(entered).length) usedTrackingForAging = true;
      const limitMs = days * 86400_000;
      const overdue = new Map<number, Rec>();
      for (const r of recs) {
        const since = entered[r.id as number] ?? odooTime(r[ageField]) ?? odooTime(r.create_date);
        if (since == null) continue;
        if (now - since > limitMs) overdue.set(r.id as number, r);
      }
      return overdue;
    };

    // ── KPI 6 — open ROs held up waiting for parts ──
    // "Awaiting parts" is derived from the parts lines themselves: an OPEN repair
    // order with any line whose Done quantity is short of Demand is still waiting
    // on parts. Ages from when that part was requested.
    if (on(6)) {
      const days = config.thresholds.awaitingPartsDays ?? 14;
      const useParts = (config.awaitingPartsSource ?? 'parts') === 'parts';
      const parts = useParts ? await resolvePartsFields(meta) : null;
      let overdue: Map<number, Rec>;

      if (parts) {
        const openROs = (await call('repair.order', 'search_read', [[
          ...selectorDomainNot(config.stageMap.closed),
          ['company_id', 'in', trackedIds],
          ...notHist,
        ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', parts.lineField], limit: 0 })) as Rec[];

        const lineIds = [...new Set(openROs.flatMap((r) => (r[parts.lineField] as number[] | undefined) ?? []))];
        const lineInfo = await readPartsLines(parts, lineIds);

        const limitMs = days * 86400_000;
        overdue = new Map<number, Rec>();
        for (const r of openROs) {
          // Oldest outstanding part decides how long this RO has been held up.
          let waitingSince: number | null = null;
          for (const id of (r[parts.lineField] as number[] | undefined) ?? []) {
            const li = lineInfo[id];
            if (!li?.short) continue;
            const t = li.since ?? odooTime(r.create_date);
            if (t != null && (waitingSince == null || t < waitingSince)) waitingSince = t;
          }
          if (waitingSince == null) continue; // nothing outstanding — not waiting on parts
          if (now - waitingSince > limitMs) overdue.set(r.id as number, r);
        }
      } else {
        if (useParts) {
          notes.push('Could not read the parts lines (Demand/Done), so "Awaiting parts" fell back to the mapped state.');
        }
        awaitingPartsMethod = 'the mapped state';
        overdue = await overdueByState(config.stageMap.awaitingParts, days);
      }
      scoreAgainstBaseline(6, overdue);
    }

    // ── KPI 7 — awaiting labour (mapped state) ──
    if (on(7)) {
      scoreAgainstBaseline(7, await overdueByState(config.stageMap.awaitingLabour, config.thresholds.awaitingLabourDays ?? 2));
    }

  }

  if (usedTrackingForAging) {
    snapshotNote = `Scored against open ROs created in the last ${baselineDaysNote} days (closed work is excluded); a vehicle counts against you if it is stuck beyond the limit right now. Ageing measured from when it actually entered the state (Odoo chatter log).`;
  }
  // Labels carry the configured thresholds, e.g. "Delivered within 48 business hrs".
  // Resolved once here so every level agrees, and so the client never has to
  // know about the override map to place a KPI in the right section.
  const sectionById: Record<number, KpiSection> = Object.fromEntries(
    KPI_DEFINITIONS.map((d) => [d.id, sectionOf(d.id, config)]),
  );
  const displayNames: Record<number, string> = Object.fromEntries(
    KPI_DEFINITIONS.map((d) => [d.id, kpiDisplayName(d.id, d.name, config.thresholds)]),
  );

  // Every retimed KPI repeats this, so no limit on the page can be read as wall-clock.
  const CLOCK = 'Timed on the business clock: only Sat–Thu 09:00–18:00 Gulf counts, with Friday and public holidays excluded.';

  // KPI 6 states which method decided a vehicle is waiting on parts.
  const snapshotNotes: Record<number, string> = {
    1: `Measured from the moment the RO became Repaired to the moment its linked invoice was posted. ${CLOCK}`,
    2: `Measured from the quotation being created to its approval; one still awaiting approval past the limit counts against you. ${CLOCK}`,
    3: 'Checks the quotation was approved (confirmed into a sale order) before the RO moved into Under Repair.',
    12: `Measured from the RO entering Inspection to its quotation being created — the promise on getting a quote out, tighter than the inspection limit itself. ${CLOCK}`,
    13: 'A straight yes/no: was the follow-up screenshot uploaded. Only ROs flagged for QA are counted, since Odoo keeps the field read-only on the rest.',
    14: `Check-in counts as complete the moment the RO reaches Inspection. ${CLOCK}`,
    15: `Measured from the RO entering Inspection to its quotation being created. ${CLOCK}`,
    17: `Time from being @mentioned to your next comment on that RO. Tagging several people is one request — whoever answers first settles it, and if nobody does it falls to the person tagged first. Answering someone does not oblige them to answer you back, so a thread closes instead of looping. ${CLOCK}`,
    16: `Measured from the RO entering QA to the next state change; an RO still in QA past the limit counts against you. ${CLOCK}`,
    11: `Delivery is inferred from invoicing — measured from Repaired to the linked invoice being posted, on a longer timeline than Invoice on delivery. ${CLOCK}`,
    18: `Measured from the quotation being approved to the last parts line being added, since Odoo records no separate "parts confirmed" moment. ROs with no parts lines are skipped — a job that needed no parts cannot be told from one whose parts were never ordered. ${CLOCK}`,
    19: 'The share of this week\'s quotations the customer approved (confirmed into a sale order). Counted from quotations CREATED this week: Odoo records no reliable moment a quotation was sent. No time limit applies.',
    20: 'A deadline, not a duration: did the RO reach Repaired by the scheduled delivery date promised to the customer. The promise is a wall-clock date, so the business clock plays no part. ROs with no promised date are skipped.',
    6: `Open ROs only, detected from ${awaitingPartsMethod}. ${snapshotNote}`,
    7: snapshotNote,
  };
  if (SNAPSHOT_KPI_IDS.some(on)) {
    notes.push('KPIs 6 & 7 reflect the current state of open ROs, so they are the same regardless of the week selected.');
  }

  // ── Roll up ────────────────────────────────────────────────────────
  const roster = config.saRoster ?? [];

  const branches: BranchNode[] = WORKSHOP_BRANCHES.map((b) => {
    const branchEvals = evals.filter((e) => e.branch === b);
    const kpis = aggregate(branchEvals, enabled, snapshotNotes, displayNames, sectionById);

    // Advisors are placed by the branch assigned to them in the roster — never by
    // the company on their ROs — so each one appears exactly once, under their own
    // branch. Their scores cover all of their work, wherever it was booked.
    const serviceAdvisors: SaNode[] = roster
      .filter((r) => r.branch === b)
      .map((r) => {
        // A person is scored only on their own section's KPIs: a technician held to
        // quotation KPIs they never touch reads as failure rather than as
        // not-their-job (and an advisor to workshop timings likewise). The ids in
        // KPI_IDS_FOR_EVERYONE stay in both lists — anyone can be @mentioned.
        // Section resolved once per person; sectionById is sectionOf(id, config)
        // precomputed, so an admin's kpiSections override still wins.
        const section: KpiSection = r.section ?? 'advisor';
        const mineEnabled = enabled.filter(
          (id) => (sectionById[id] ?? sectionOf(id, config)) === section || KPI_IDS_FOR_EVERYONE.includes(id),
        );
        const mine = evals.filter((e) => e.userId === r.odooUserId);
        const cells = aggregate(mine, mineEnabled, snapshotNotes, displayNames, sectionById);
        return {
          odooUserId: r.odooUserId,
          name: r.name || mine[0]?.userName || `User ${r.odooUserId}`,
          section,
          achievement: overall(cells),
          sections: sectionTotals(cells, config),
          roCount: roCountByUser[r.odooUserId] ?? 0,
          kpis: cells,
        };
      })
      .sort((a, b2) => (b2.achievement ?? -1) - (a.achievement ?? -1));

    return {
      name: b,
      achievement: overall(kpis),
      sections: sectionTotals(kpis, config),
      applicableTotal: kpis.reduce((s, c) => s + c.applicable, 0),
      kpis,
      serviceAdvisors,
    };
  });

  if (!roster.length) {
    notes.push('No service advisors configured yet — set up the SA roster in Admin → KPI Configuration to enable the SA level.');
  }

  const companyKpis = aggregate(evals, enabled, snapshotNotes, displayNames, sectionById);

  return {
    week: { start, end },
    generatedAt: new Date().toISOString(),
    company: { achievement: overall(companyKpis), sections: sectionTotals(companyKpis, config), kpis: companyKpis },
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
