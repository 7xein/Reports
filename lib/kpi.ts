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
  BRANCHES, Branch, KPI_DEFINITIONS, KpiConfig, StageSelector, SNAPSHOT_KPI_IDS, kpiDisplayName,
  KpiWeekSummary,
} from './types';
import { call, allTrackedCompanyIds, branchCompanyIds, OdooDomain } from './odoo';

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
function odooTime(raw: unknown): number | null {
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
  note?: string;             // extra context shown in the ⓘ tooltip
  violations: string[];      // capped at 50
}

export interface SaNode {
  odooUserId: number;
  name: string;
  achievement: number | null;
  roCount: number;
  kpis: KpiCell[];
}

export interface BranchNode {
  name: string;
  achievement: number | null;
  applicableTotal: number;
  kpis: KpiCell[];
  serviceAdvisors: SaNode[];
}

export interface KpiTree {
  week: { start: string; end: string };
  generatedAt: string;
  company: { achievement: number | null; kpis: KpiCell[] };
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
): KpiCell[] {
  return KPI_DEFINITIONS.filter((d) => enabled.includes(d.id)).map((d) => {
    const mine = evals.filter((e) => e.kpiId === d.id);
    const compliant = mine.filter((e) => e.compliant).length;
    const applicable = mine.length;
    const snapshot = SNAPSHOT_KPI_IDS.includes(d.id);
    return {
      id: d.id,
      name: names?.[d.id] ?? d.name,
      compliant,
      applicable,
      pct: applicable > 0 ? Math.min((compliant / applicable) * 100, 100) : null,
      snapshot,
      ...(snapshotNotes?.[d.id] ? { note: snapshotNotes[d.id] } : {}),
      violations: mine.filter((e) => !e.compliant).map((e) => e.ref).slice(0, VIOLATION_CAP),
    };
  });
}

/** Overall achievement = mean of the KPI percentages that have applicable records. */
function overall(cells: KpiCell[]): number | null {
  const active = cells.filter((c) => c.pct !== null);
  if (!active.length) return null;
  return active.reduce((s, c) => s + (c.pct as number), 0) / active.length;
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
function selectorDomainNot(sel: StageSelector): OdooDomain {
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
type FieldsMeta = Record<string, { type?: string; relation?: string; selection?: [string, string][] }>;

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
async function resolvePartsFields(
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
async function readPartsLines(
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

export async function computeKpiTree(config: KpiConfig, weekStartIso?: string): Promise<KpiTree> {
  const notes: string[] = [];
  const start = weekStartFor(weekStartIso, config.weekStartDay ?? 6);
  const endExclusive = addDaysIso(start, 7);
  const end = addDaysIso(start, 6);
  const wStart = gulfToUtc(start);
  const wEnd = gulfToUtc(endExclusive);
  const now = Date.now();

  const trackedIds = await allTrackedCompanyIds();

  // company id → branch
  const idToBranch: Record<number, Branch> = {};
  for (const b of BRANCHES) for (const id of await branchCompanyIds(b)) idToBranch[id] = b;

  // Which optional fields exist on this instance?
  const meta = (await call('repair.order', 'fields_get', [], { attributes: ['type', 'relation', 'selection'] })) as FieldsMeta;
  const stageNames = await resolveStageNames(config, meta);
  const has = (f: string) => Object.prototype.hasOwnProperty.call(meta, f);
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

  const weekDomain: OdooDomain = [
    ['create_date', '>=', wStart],
    ['create_date', '<', wEnd],
    ['company_id', 'in', trackedIds],
  ];
  const enabled = config.enabledKpis ?? [];
  const on = (id: number) => enabled.includes(id);

  // ── KPIs 1 & 11 — time from "Repaired" to the invoice being posted ──
  // Same measurement, two thresholds: KPI 1 is the prompt-invoicing rule, KPI 11
  // stands in for delivery (a car isn't handed over before it's invoiced).
  if ((on(1) || on(11) || on(13)) && has('sale_order_id')) {
    const roFields = ['name', 'create_uid', 'company_id', 'sale_order_id'];
    if (has('invoice_id')) roFields.push('invoice_id');   // some versions link the invoice directly
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
      repaired = (await call('repair.order', 'read', [enteredIds], { fields: roFields, context: roCtx })) as Rec[];
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
        if (inv != null) push(kpiId, r, inv - rep <= limitMs, ref);
        else if (now - rep > limitMs) push(kpiId, r, false, ref);  // overdue, still uninvoiced
        // still inside the window and uninvoiced → not judged yet
      }
    };

    if (on(1)) judgeInvoiceTiming(1, (config.thresholds.invoiceGraceMinutes ?? 60) * 60_000);
    if (on(11)) judgeInvoiceTiming(11, (config.thresholds.repairedToDeliveredDays ?? 2) * 86400_000);

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
    const roFields = ['name', 'create_uid', 'company_id', 'sale_order_id'];
    const tf = trackedField(config.stageMap.underRepair, meta, stageNames);

    // ROs that STARTED repair during this week, whatever state they're in now.
    let entered = tf ? await roIdsEnteringStateInWindow(tf.field, tf.labels, wStart, wEnd) : {};
    const startedIds = Object.keys(entered).map(Number);

    let inRepair: Rec[];
    if (startedIds.length) {
      inRepair = (await call('repair.order', 'read', [startedIds], { fields: roFields })) as Rec[];
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

  // ── KPI 2 — quotation approval within N days ──
  if (on(2)) {
    const limitMs = (config.thresholds.quoteApprovalDays ?? 7) * 86400_000;
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

    // Insurance jobs are exempt: approval is the insurer's to give, so holding an
    // advisor to a two-day clock measures the insurer, not them. Resolved from the
    // repair order behind each quotation, across both tag fields.
    const insuranceExempt = new Set<number>();
    const insuranceTags = await resolveTagMatches(config.stageMap.insuranceTags?.values ?? [], meta, INSURANCE_TAG_RE);
    if (insuranceTags.some((m) => m.ids.size) && has('sale_order_id')) {
      const soIds = [...new Set([...open, ...confirmed].map((q) => q.id as number))];
      for (let i = 0; i < soIds.length; i += 2000) {
        try {
          const insured = (await call('repair.order', 'search_read', [[
            ['sale_order_id', 'in', soIds.slice(i, i + 2000)],
            ...anyTagDomain(insuranceTags),
          ]], { fields: ['sale_order_id'], limit: 0 })) as Rec[];
          for (const r of insured) {
            const id = m2o(r.sale_order_id)?.[0];
            if (id != null) insuranceExempt.add(id);
          }
        } catch { /* leave this chunk unexempted rather than dropping the KPI */ }
      }
    }

    for (const q of open) {
      if (insuranceExempt.has(q.id as number)) continue;
      const created = odooTime(q.create_date);
      if (created == null) continue;
      push(2, q, now - created <= limitMs, (q.name as string) || '');
    }
    for (const q of confirmed) {
      if (insuranceExempt.has(q.id as number)) continue;
      const created = odooTime(q.create_date);
      const approved = odooTime(q.date_order);
      if (created == null || approved == null) continue;
      push(2, q, approved - created <= limitMs, (q.name as string) || '');
    }
    if (insuranceExempt.size) {
      notes.push(`Quote approval excluded ${insuranceExempt.size} insurance quotation${insuranceExempt.size === 1 ? '' : 's'} — approval there is the insurer's to give.`);
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
    const limitMs = (config.thresholds.checkInDays ?? 1) * 86400_000;
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
        push(14, r, hits[0].t - roAt <= limitMs, ref);   // FIRST arrival is the check-in
        continue;
      }
      // No Inspection on record. Only a failure if we have some other stage change
      // for this RO — that proves tracking was live and it really did skip check-in.
      if (!events.length) { unobserved++; continue; }
      if (now - roAt > limitMs) { judged++; push(14, r, false, ref); }
    }
    if (unobserved) {
      notes.push(`Check-in ignored ${unobserved} of ${weekROs.length} ROs with no stage history at all — they moved before tracking was switched on, so their check-in was never recorded. Judged ${judged}.`);
    }
  }

  // KPIs 15 & 12 — inspection start → quotation created. Same measurement, two
  // windows: 15 is how long inspection itself may run, 12 allows the quote a
  // little longer still.
  if ((on(12) || on(15)) && tfInspection && has('sale_order_id')) {
    const entered = await roIdsEnteringStateInWindow(tfInspection.field, tfInspection.labels, wStart, wEnd);
    const ids = Object.keys(entered).map(Number);
    if (!ids.length) {
      notes.push(`No repair order entered "${tfInspection.labels.join('/')}" during this week according to the chatter — inspection and quote-after-inspection have nothing to measure.`);
    }

    if (ids.length) {
      const ros = (await call('repair.order', 'read', [ids], {
        fields: ['name', 'create_uid', 'company_id', 'sale_order_id'],
      })) as Rec[];

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
          if (quotedAt != null) push(kpiId, r, quotedAt - from <= limitMs, ref);
          else if (now - from > limitMs) push(kpiId, r, false, ref);  // still unquoted, window gone
        }
      };

      if (on(15)) judgeQuoteTiming(15, (config.thresholds.inspectionDays ?? 3) * 86400_000);
      if (on(12)) judgeQuoteTiming(12, (config.thresholds.quoteAfterInspectionDays ?? 5) * 86400_000);
    }
  }

  // KPI 16 — how long the RO actually sat in QA.
  if (on(16) && tfQa) {
    const limitMs = (config.thresholds.qaDays ?? 1) * 86400_000;
    const entered = await roIdsEnteringStateInWindow(tfQa.field, tfQa.labels, wStart, wEnd);
    const ids = Object.keys(entered).map(Number);
    if (!ids.length) {
      notes.push(`No repair order entered "${tfQa.labels.join('/')}" during this week according to the chatter — QA duration has nothing to measure.`);
    }

    if (ids.length) {
      const ros = (await call('repair.order', 'read', [ids], {
        fields: ['name', 'create_uid', 'company_id'],
      })) as Rec[];
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

        if (left != null) push(16, r, left - from <= limitMs, ref);
        else if (now - from > limitMs) push(16, r, false, ref);  // still in QA, over the limit
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
    const limitMs = (config.thresholds.mentionResponseDays ?? 1) * 86400_000;
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
          const ros = (await call('repair.order', 'read', [roIds], { fields: ['name', 'company_id'] })) as Rec[];
          const roInfo: Record<number, { name: string; branch: Branch | undefined }> = {};
          for (const r of ros) {
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
                  judgements.push({ partner: author, compliant: at - o.at <= limitMs, ref: info.name, branch: info.branch });
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
              if (now - o.at > limitMs) {
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
  // Labels carry the configured thresholds, e.g. "Delivered in 2 days after repair".
  const displayNames: Record<number, string> = Object.fromEntries(
    KPI_DEFINITIONS.map((d) => [d.id, kpiDisplayName(d.id, d.name, config.thresholds)]),
  );

  // KPI 6 states which method decided a vehicle is waiting on parts.
  const snapshotNotes: Record<number, string> = {
    1: 'Measured from the moment the RO became Repaired to the moment its linked invoice was posted.',
    3: 'Checks the quotation was approved (confirmed into a sale order) before the RO moved into Under Repair.',
    12: 'Measured from the RO entering Inspection, so the headline figure is what is left after the allowed inspection time.',
    13: 'A straight yes/no: was the follow-up screenshot uploaded. Only ROs flagged for QA are counted, since Odoo keeps the field read-only on the rest.',
    14: 'Check-in counts as complete the moment the RO reaches Inspection.',
    15: 'Measured from the RO entering Inspection to its quotation being created.',
    17: 'Time from being @mentioned to your next comment on that RO. Tagging several people is one request — whoever answers first settles it, and if nobody does it falls to the person tagged first. Answering someone does not oblige them to answer you back, so a thread closes instead of looping.',
    16: 'Measured from the RO entering QA to the next state change; an RO still in QA past the limit counts against you.',
    11: 'Delivery is inferred from invoicing — measured from Repaired to the linked invoice being posted, on a longer timeline than Invoice on delivery.',
    6: `Open ROs only, detected from ${awaitingPartsMethod}. ${snapshotNote}`,
    7: snapshotNote,
  };
  if (SNAPSHOT_KPI_IDS.some(on)) {
    notes.push('KPIs 6 & 7 reflect the current state of open ROs, so they are the same regardless of the week selected.');
  }

  // ── Roll up ────────────────────────────────────────────────────────
  const roster = config.saRoster ?? [];

  const branches: BranchNode[] = BRANCHES.map((b) => {
    const branchEvals = evals.filter((e) => e.branch === b);
    const kpis = aggregate(branchEvals, enabled, snapshotNotes, displayNames);

    // Advisors are placed by the branch assigned to them in the roster — never by
    // the company on their ROs — so each one appears exactly once, under their own
    // branch. Their scores cover all of their work, wherever it was booked.
    const serviceAdvisors: SaNode[] = roster
      .filter((r) => r.branch === b)
      .map((r) => {
        const mine = evals.filter((e) => e.userId === r.odooUserId);
        const cells = aggregate(mine, enabled, snapshotNotes, displayNames);
        return {
          odooUserId: r.odooUserId,
          name: r.name || mine[0]?.userName || `User ${r.odooUserId}`,
          achievement: overall(cells),
          roCount: roCountByUser[r.odooUserId] ?? 0,
          kpis: cells,
        };
      })
      .sort((a, b2) => (b2.achievement ?? -1) - (a.achievement ?? -1));

    return {
      name: b,
      achievement: overall(kpis),
      applicableTotal: kpis.reduce((s, c) => s + c.applicable, 0),
      kpis,
      serviceAdvisors,
    };
  });

  if (!roster.length) {
    notes.push('No service advisors configured yet — set up the SA roster in Admin → KPI Configuration to enable the SA level.');
  }

  const companyKpis = aggregate(evals, enabled, snapshotNotes, displayNames);

  return {
    week: { start, end },
    generatedAt: new Date().toISOString(),
    company: { achievement: overall(companyKpis), kpis: companyKpis },
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
    company: { achievement: tree.company.achievement, kpis: pcts(tree.company.kpis) },
    branches: Object.fromEntries(
      tree.branches.map((b) => [b.name, { achievement: b.achievement, kpis: pcts(b.kpis) }]),
    ),
  };
}
