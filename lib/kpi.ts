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
      ...(snapshot && snapshotNotes?.[d.id] ? { note: snapshotNotes[d.id] } : {}),
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
  if (sel.kind === 'stage') return [['stage_id', 'in', sel.values]];
  if (sel.kind === 'tag')   return [['tag_ids', 'in', sel.values]];
  return [['priority_matrix_status', 'in', sel.values]];
}

/** Inverse of selectorDomain — e.g. "not closed" = every open RO. */
function selectorDomainNot(sel: StageSelector): OdooDomain {
  if (!sel || !sel.values?.length) return []; // nothing marked closed → everything is open
  if (sel.kind === 'state') return [['state', 'not in', sel.values]];
  if (sel.kind === 'stage') return [['stage_id', 'not in', sel.values]];
  if (sel.kind === 'tag')   return [['tag_ids', 'not in', sel.values]];
  return [['priority_matrix_status', 'not in', sel.values]];
}

// ── Engine ─────────────────────────────────────────────────────────
type Rec = Record<string, unknown>;
type FieldsMeta = Record<string, { type?: string; relation?: string; selection?: [string, string][] }>;

/** Matches tag names like "CAR-IN", "CAR IN", "CAR OUT", "car_out". */
const PRESENCE_TAG_RE = /car\s*[-_]?\s*(in|out)\b/i;

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
async function resolvePresenceTagIds(configured: (string | number)[], meta: FieldsMeta): Promise<number[]> {
  const explicit = (configured ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (explicit.length) return explicit;
  const relation = meta.tag_ids?.relation;
  if (!relation) return [];
  try {
    const recs = (await call(relation, 'search_read', [[]], { fields: ['display_name'], limit: 500 })) as { id: number; display_name?: string }[];
    return recs.filter((t) => PRESENCE_TAG_RE.test(t.display_name || '')).map((t) => t.id);
  } catch {
    return [];
  }
}
const m2o = (v: unknown): [number, string] | null => (Array.isArray(v) ? (v as [number, string]) : null);

/**
 * The tracked field + the human labels Odoo stores in its change log for a
 * configured selector. Only selection fields (state / priority matrix) are
 * resolvable this way; stage/tag mappings fall back to date proxies.
 */
function trackedField(sel: StageSelector, meta: FieldsMeta): { field: string; labels: string[] } | null {
  const field = sel.kind === 'state' ? 'state' : sel.kind === 'priority' ? 'priority_matrix_status' : null;
  if (!field) return null;
  const options = meta[field]?.selection ?? [];
  const labels = sel.values
    .map((v) => options.find(([code]) => code === String(v))?.[1])
    .filter((x): x is string => !!x);
  return labels.length ? { field, labels } : null;
}

/**
 * When each RO actually entered the given state, read from Odoo's chatter/tracking
 * log (mail.message + mail.tracking.value). Returns roId → epoch ms of the most
 * recent transition into one of `labels`. Returns {} if tracking isn't readable,
 * so callers fall back to a date proxy.
 */
async function stateEntryTimes(roIds: number[], field: string, labels: string[]): Promise<Record<number, number>> {
  if (!roIds.length || !labels.length) return {};
  return trackedTransitions([
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
async function roIdsEnteringStateInWindow(
  field: string, labels: string[], from: string, to: string,
): Promise<Record<number, number>> {
  if (!labels.length) return {};
  return trackedTransitions([
    ['model', '=', 'repair.order'],
    ['date', '>=', from], ['date', '<', to],
    ['tracking_value_ids', '!=', false],
  ], field, labels);
}

/** Shared chatter-log reader: message domain → { roId: epoch ms of transition }. */
async function trackedTransitions(msgDomain: OdooDomain, field: string, labels: string[]): Promise<Record<number, number>> {
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
        ['model', '=', 'repair.order'], ['name', '=', field],
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
  let snapshotNote = `Scored against every RO created in the last ${baselineDaysNote} days; a vehicle counts against you if it is stuck beyond the limit right now. Ageing measured by ${AGE_LABEL[ageField] ?? ageField}.`;
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

  const push = (kpiId: number, rec: Rec, compliant: boolean, ref: string) => {
    const cid = m2o(rec.company_id)?.[0];
    const branch = cid != null ? idToBranch[cid] : undefined;
    if (!branch) return; // untracked company (EV HUB, CarDIP, …)
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

  // ── KPIs 1 & 3 — repaired ROs: invoice raised, sale order present ──
  if ((on(1) || on(3)) && has('sale_order_id')) {
    const roFields = ['name', 'create_uid', 'company_id', 'sale_order_id'];
    const tfRepaired = trackedField(config.stageMap.repaired, meta);

    // Preferred: ROs that reached the repaired/delivered state during this week,
    // whatever state they're in now. Falls back to current-state matching.
    let deliveredAt = tfRepaired
      ? await roIdsEnteringStateInWindow(tfRepaired.field, tfRepaired.labels, wStart, wEnd)
      : {};
    const enteredIds = Object.keys(deliveredAt).map(Number);

    let repaired: Rec[];
    if (enteredIds.length) {
      repaired = (await call('repair.order', 'read', [enteredIds], { fields: roFields })) as Rec[];
    } else {
      repaired = (await call('repair.order', 'search_read', [[
        ...selectorDomain(config.stageMap.repaired), ...weekDomain,
      ]], { fields: roFields, limit: 0 })) as Rec[];
      if (tfRepaired) {
        deliveredAt = await stateEntryTimes(repaired.map((r) => r.id as number), tfRepaired.field, tfRepaired.labels);
      }
    }

    // Which of the linked sale orders actually have invoices?
    const soIds = [...new Set(repaired.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))];
    const invoiced = new Set<number>();
    if (on(1) && soIds.length) {
      try {
        const sos = (await call('sale.order', 'read', [soIds], { fields: ['invoice_ids'] })) as { id: number; invoice_ids?: number[] }[];
        for (const so of sos) if ((so.invoice_ids ?? []).length) invoiced.add(so.id);
      } catch { notes.push('Could not read sale.order invoice_ids — KPI 1 may be understated.'); }
    }

    // Grace period: a vehicle that only just reached delivery hasn't had a fair
    // chance to be invoiced yet, so it's excluded from KPI 1 until the grace passes.
    const graceMs = (config.thresholds.invoiceGraceMinutes ?? 10) * 60_000;

    for (const r of repaired) {
      const ref = (r.name as string) || '';
      const soId = m2o(r.sale_order_id)?.[0] ?? null;
      if (on(3)) push(3, r, soId != null, ref);
      if (on(1)) {
        const at = deliveredAt[r.id as number];
        // If we can't tell when it was delivered, judge it rather than silently skip.
        const withinGrace = at != null && now - at < graceMs;
        if (!withinGrace) push(1, r, soId != null && invoiced.has(soId), ref);
      }
    }
  }

  // ── KPI 4 — a quotation must exist BEFORE repair starts ──
  // Uses the chatter log to get the moment the RO entered "under repair", so this
  // checks the real sequence (quote created first) rather than just "a quote exists".
  if (on(4) && has('sale_order_id')) {
    const roFields = ['name', 'create_uid', 'company_id', 'sale_order_id'];
    const tf = trackedField(config.stageMap.underRepair, meta);

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

    // Quotation creation times.
    const soIds = [...new Set(inRepair.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))];
    const soCreated: Record<number, number> = {};
    if (soIds.length) {
      try {
        const sos = (await call('sale.order', 'read', [soIds], { fields: ['create_date'] })) as Rec[];
        for (const so of sos) {
          const t = odooTime(so.create_date);
          if (t != null) soCreated[so.id as number] = t;
        }
      } catch { /* fall back to existence-only below */ }
    }

    let sequenceChecked = 0;
    for (const r of inRepair) {
      const ref = (r.name as string) || '';
      const soId = m2o(r.sale_order_id)?.[0] ?? null;
      if (soId == null) { push(4, r, false, ref); continue; } // no quote at all
      const startedAt = entered[r.id as number];
      const quotedAt = soCreated[soId];
      if (startedAt != null && quotedAt != null) {
        sequenceChecked++;
        push(4, r, quotedAt <= startedAt, ref); // quote must pre-date repair start
      } else {
        push(4, r, true, ref); // quote exists but the sequence can't be verified
      }
    }
    if (inRepair.length && sequenceChecked === 0) {
      notes.push('KPI 4 could not read repair-start times from the chatter log, so it only checks that a quotation exists.');
    }
  }

  // ── KPIs 5 & 8 — tagging on ROs created this week ──
  if (on(5) || on(8)) {
    const weekROs = (await call('repair.order', 'search_read', [weekDomain], {
      fields: ['name', 'create_uid', 'company_id', 'create_date', 'tag_ids'], limit: 0,
    })) as Rec[];
    const graceMs = (config.thresholds.tagMinutes ?? 60) * 60_000;

    // Tags that mark the vehicle in/out (KPI 8).
    const presence = new Set(
      on(8) ? await resolvePresenceTagIds(config.stageMap.presenceTags?.values ?? [], meta) : [],
    );

    for (const r of weekROs) {
      const created = odooTime(r.create_date);
      // Only judge ROs that have had their full grace period.
      if (created == null || now - created < graceMs) continue;
      const tags = (r.tag_ids as number[] | undefined) ?? [];
      const ref = (r.name as string) || '';
      if (on(5)) push(5, r, tags.length > 0, ref);
      if (on(8) && presence.size) push(8, r, tags.some((id) => presence.has(id)), ref);
    }

    if (on(8) && !presence.size) {
      notes.push('KPI 8 is inactive — no CAR-IN / CAR-OUT tags were found. Pick them under "Car in / out tags" in Admin → KPI Configuration.');
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
    for (const q of open) {
      const created = odooTime(q.create_date);
      if (created == null) continue;
      push(2, q, now - created <= limitMs, (q.name as string) || '');
    }
    // (b) Quotations confirmed during the week: was approval inside the window?
    const confirmed = (await call('sale.order', 'search_read', [[
      ['state', 'in', ['sale', 'done']],
      ['date_order', '>=', wStart], ['date_order', '<', wEnd],
      ['company_id', 'in', trackedIds],
    ]], { fields: ['name', 'create_uid', 'company_id', 'create_date', 'date_order'], limit: 0 })) as Rec[];
    for (const q of confirmed) {
      const created = odooTime(q.create_date);
      const approved = odooTime(q.date_order);
      if (created == null || approved == null) continue;
      push(2, q, approved - created <= limitMs, (q.name as string) || '');
    }
  }

  // ── KPI 9 — weekly closure rate (closed ÷ received) ──
  if (on(9)) {
    const received = (await call('repair.order', 'search_read', [weekDomain], {
      fields: ['name', 'create_uid', 'company_id'], limit: 0,
    })) as Rec[];

    const tfClosed = trackedField(config.stageMap.closed, meta);
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

  // ── KPI 11 — repaired vehicles must be delivered, not left on the lot ──
  if (on(11)) {
    const limitMs = (config.thresholds.repairedToDeliveredDays ?? 2) * 86400_000;
    const tfRep = trackedField(config.stageMap.repaired, meta);
    const repairedAt = tfRep
      ? await roIdsEnteringStateInWindow(tfRep.field, tfRep.labels, wStart, wEnd)
      : {};
    const ids = Object.keys(repairedAt).map(Number);

    if (ids.length) {
      const recs = (await call('repair.order', 'read', [ids], {
        fields: ['name', 'create_uid', 'company_id'],
      })) as Rec[];
      const tfClosed = trackedField(config.stageMap.closed, meta);
      const deliveredAt = tfClosed ? await stateEntryTimes(ids, tfClosed.field, tfClosed.labels) : {};

      for (const r of recs) {
        const rep = repairedAt[r.id as number];
        if (rep == null) continue;
        const del = deliveredAt[r.id as number];
        const ref = (r.name as string) || '';
        // Delivered → was it quick enough. Still on the lot → only a violation
        // once it has actually overrun.
        push(11, r, del != null ? del - rep <= limitMs : now - rep <= limitMs, ref);
      }
    } else if (!tfRep) {
      notes.push('KPI 11 needs the repaired state to be mapped to a tracked field (state or priority matrix).');
    }
  }

  // ── KPI 12 — quotation raised within N days of the RO ──
  if (on(12) && has('sale_order_id')) {
    const limitMs = (config.thresholds.quoteWithinDays ?? 1) * 86400_000;
    const weekROs = (await call('repair.order', 'search_read', [weekDomain], {
      fields: ['name', 'create_uid', 'company_id', 'create_date', 'sale_order_id'], limit: 0,
    })) as Rec[];

    const soIds = [...new Set(weekROs.map((r) => m2o(r.sale_order_id)?.[0]).filter((x): x is number => x != null))];
    const soCreated: Record<number, number> = {};
    if (soIds.length) {
      try {
        const sos = (await call('sale.order', 'read', [soIds], { fields: ['create_date'] })) as Rec[];
        for (const so of sos) {
          const t = odooTime(so.create_date);
          if (t != null) soCreated[so.id as number] = t;
        }
      } catch { /* fall through — unverifiable quotes count as compliant */ }
    }

    for (const r of weekROs) {
      const roAt = odooTime(r.create_date);
      if (roAt == null) continue;
      const ref = (r.name as string) || '';
      const soId = m2o(r.sale_order_id)?.[0] ?? null;
      if (soId == null) {
        // Never quoted — only judge once the window has actually elapsed.
        if (now - roAt > limitMs) push(12, r, false, ref);
        continue;
      }
      const quotedAt = soCreated[soId];
      push(12, r, quotedAt == null ? true : quotedAt - roAt <= limitMs, ref);
    }
  }

  // ── KPIs 6 & 7 — time spent awaiting parts / labour (point-in-time) ──
  if (on(6) || on(7)) {
    // Baseline population: every RO created in the last N days. Scoring stuck
    // vehicles against the whole workload (rather than only against other stuck
    // vehicles) is what makes these percentages meaningful.
    const baselineDays = config.thresholds.snapshotBaselineDays ?? 90;
    const sinceIso = new Date(now - baselineDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const baseROs = (await call('repair.order', 'search_read', [[
      ['create_date', '>=', sinceIso],
      ['company_id', 'in', trackedIds],
    ]], { fields: ['name', 'create_uid', 'company_id'], limit: 0 })) as Rec[];

    /** Every RO in the window counts; the stuck ones are the violations. */
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
      const tf = trackedField(sel, meta);
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
    snapshotNote = `Scored against every RO created in the last ${baselineDaysNote} days; a vehicle counts against you if it is stuck beyond the limit right now. Ageing measured from when it actually entered the state (Odoo chatter log).`;
  }
  // Labels carry the configured thresholds, e.g. "Delivered in 2 days after repair".
  const displayNames: Record<number, string> = Object.fromEntries(
    KPI_DEFINITIONS.map((d) => [d.id, kpiDisplayName(d.id, d.name, config.thresholds)]),
  );

  // KPI 6 states which method decided a vehicle is waiting on parts.
  const snapshotNotes: Record<number, string> = {
    6: `Open ROs only, detected from ${awaitingPartsMethod}. ${snapshotNote}`,
    7: snapshotNote,
    9: snapshotNote,
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
