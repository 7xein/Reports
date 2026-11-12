'use client';

import { useEffect, useState } from 'react';
import {
  KPI_BRANCHES, KPI_DEFINITIONS, KpiConfig, StageSelector, StageSelectorKind, withKpiDefaults, kpiDisplayName,
  KpiSection, KPI_SECTION_ORDER, KPI_SECTION_LABELS, sectionOf, Branch,
} from '@/lib/types';

interface OdooOptions {
  priorityOptions: { value: string; label: string }[];
  stateOptions: { value: string; label: string }[];
  repairStateOptions: { value: string; label: string }[];
  stages: { id: number; name: string }[];
  tags: { id: number; name: string }[];
  users: { id: number; name: string; roCount: number }[];
  fieldReport: {
    hasStageId: boolean; hasState: boolean; hasPriorityMatrixStatus: boolean;
    hasStatusSince: boolean; hasDateLastStageUpdate: boolean; hasSaleOrderId: boolean;
    stageAgeField: string; notes: string[];
  };
}

/**
 * One suggested roster member, mirroring GET /api/kpi/roster-suggestion.
 * Declared here for the same reason OdooOptions is: lib/odoo.ts is a server
 * module and this card is a client component.
 */
interface RosterSuggestion {
  odooUserId: number;
  name: string;
  branch: string | null;
  section: KpiSection;
  jobTitle: string | null;
  department: string | null;
  rosCreated: number;
  quotesCreated: number;
  stageMoves: number;
  chatterPosts: number;
  branchCounts: Record<string, number>;
}

/** A suggestion plus the reviewer's edits. Lives outside cfg until it is applied. */
interface SuggestedPerson extends RosterSuggestion {
  branchPick: string;
  sectionPick: KpiSection;
  checked: boolean;
  /** Odoo gave no branch the dropdown can offer, so branchPick is a fallback. */
  weakBranch: boolean;
}

const countLabel = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why someone was suggested: job data first, then only the counts that are non-zero. */
function evidenceLine(s: RosterSuggestion): string {
  const bits: string[] = [];
  if (s.jobTitle) bits.push(s.jobTitle);
  if (s.department) bits.push(`${s.department} dept`);
  if (s.rosCreated > 0) bits.push(countLabel(s.rosCreated, 'RO', 'ROs'));
  if (s.quotesCreated > 0) bits.push(countLabel(s.quotesCreated, 'quote', 'quotes'));
  if (s.stageMoves > 0) bits.push(countLabel(s.stageMoves, 'stage move', 'stage moves'));
  if (s.chatterPosts > 0) bits.push(countLabel(s.chatterPosts, 'comment', 'comments'));
  return bits.join(' · ');
}

/**
 * Normalise one API suggestion into an editable row. A branch the dropdown cannot
 * offer — null, or outside KPI_BRANCHES — falls back to the first KPI-scored
 * branch and is flagged, so applying can never write a null or unlisted branch.
 */
function toSuggestedPerson(s: RosterSuggestion, alreadyTracked: boolean): SuggestedPerson {
  const usable = !!s.branch && (KPI_BRANCHES as readonly string[]).includes(s.branch);
  return {
    ...s,
    branchPick: usable ? (s.branch as string) : KPI_BRANCHES[0],
    sectionPick: s.section === 'workshop' ? 'workshop' : 'advisor',
    checked: !alreadyTracked,
    weakBranch: !usable,
  };
}

type MapKey = 'inspection' | 'qa' | 'repaired' | 'underRepair' | 'awaitingParts' | 'awaitingLabour' | 'presenceTags' | 'insuranceTags' | 'closed';
const MAP_LABELS: Record<MapKey, string> = {
  inspection: 'Inspection', qa: 'QA',
  repaired: 'Repaired', underRepair: 'Under repair',
  awaitingParts: 'Awaiting parts', awaitingLabour: 'Awaiting labour',
  presenceTags: 'Car in / out tags',
  insuranceTags: 'Insurance tags',
  closed: 'Closed / completed',
};
const MAP_HINTS: Partial<Record<MapKey, string>> = {
  inspection: 'Reaching this point means check-in is done. Drives check-in, inspection duration and quote-after-inspection. Lives on Repair Status, not State.',
  qa: 'The quality-check step. QA duration measures how long an RO sits here. Lives on Repair Status, not State.',
  presenceTags: 'Leave empty to auto-detect tags named CAR-IN / CAR IN / CAR-OUT. Both the Tags and Stages Tags fields are searched.',
  insuranceTags: 'Repair orders carrying one of these are excluded from Quote approval. Leave empty to auto-detect tags named Insurance.',
  closed: 'Anything NOT in these states counts as an open repair order.',
};

type Thresholds = KpiConfig['thresholds'];

/**
 * The threshold keys lib/types.ts marks optional. Only those may be DELETED when
 * their box is emptied: the engine reads every limit as `thresholds.X ?? default`,
 * so undefined — and nothing else, 0 least of all — is what brings the default back.
 * A key the type declares required has no such fallback, so an empty box there is
 * an error rather than an erasure. The mapped type makes that a compile-time claim:
 * listing a required key below fails to type-check.
 */
type ClearableThresholdKey = {
  [K in keyof Thresholds]-?: undefined extends Thresholds[K] ? K : never;
}[keyof Thresholds];

const CLEARABLE_THRESHOLDS: readonly ClearableThresholdKey[] = [
  'checkInHours', 'quoteSentHours', 'quoteApprovalHours', 'invoiceHours', 'deliveryHours',
  'mentionResponseHours', 'inspectionHours', 'qaHours',
  'snapshotBaselineDays', 'rfqAfterApprovalDays', 'rfqConfirmDays', 'partsPlacedDays',
  'followUpGraceDays', 'lowVolumeMin',
];

const isClearableThreshold = (k: keyof Thresholds): k is ClearableThresholdKey =>
  (CLEARABLE_THRESHOLDS as readonly string[]).includes(k);

/** Help text for a threshold whose unit or meaning the label alone cannot carry. */
const THRESHOLD_HINTS: Partial<Record<keyof Thresholds, string>> = {
  followUpGraceDays:
    'Grace period, in calendar days after the vehicle is delivered, before the customer follow-up screenshot is expected. Without it the follow-up KPI judges a repair order the moment it is repaired.',
};

/** The only shape lib/business-hours.ts matches: zero-padded YYYY-MM-DD. */
const HOLIDAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a date the holiday clock can actually skip. The format test alone
 * would pass 2026-02-31, so the parts are round-tripped through UTC: an impossible
 * day rolls over into the next month and comes back different from what was typed.
 */
function isUsableHoliday(line: string): boolean {
  if (!HOLIDAY_FORMAT.test(line)) return false;
  const [y, m, d] = line.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Splits the holidays box into what the clock can use and what it cannot.
 *
 * Anything unmatched used to be saved verbatim and excluded from nothing, while
 * Admin and the KPI page both promised holidays were skipped — and a single missed
 * national holiday burns ~9 business hours, enough on its own to fail KPIs 1, 14
 * and 17. Rejected lines are handed back rather than dropped, so they can be shown.
 */
function splitHolidays(text: string): { kept: string[]; rejected: string[] } {
  const lines = text.split('\n').map((d) => d.trim()).filter(Boolean);
  return {
    kept: [...new Set(lines.filter(isUsableHoliday))].sort(),
    rejected: [...new Set(lines.filter((l) => !isUsableHoliday(l)))],
  };
}

export function KpiConfigCard({ initialConfig }: { initialConfig?: KpiConfig }) {
  const [cfg, setCfg] = useState<KpiConfig>(withKpiDefaults(initialConfig));
  const [opts, setOpts] = useState<OdooOptions | null>(null);
  const [optsError, setOptsError] = useState('');
  const [loadingOpts, setLoadingOpts] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [personSearch, setPersonSearch] = useState('');
  // The holidays box is edited as free text so a half-typed line survives a keystroke.
  const [holidayText, setHolidayText] = useState(
    (withKpiDefaults(initialConfig).publicHolidays ?? []).join('\n'),
  );
  // Lines the clock could never match, surfaced next to the field instead of
  // dropped in silence. Seeded from the stored config so junk saved before this
  // check existed is visible too.
  const [holidayRejects, setHolidayRejects] = useState<string[]>(
    () => splitHolidays((withKpiDefaults(initialConfig).publicHolidays ?? []).join('\n')).rejected,
  );
  // Thresholds are edited as raw text for the same reason the holidays box is: the
  // field must keep showing exactly what was typed, so a refused value can be
  // explained instead of silently snapping back to the stored one.
  const [thresholdText, setThresholdText] = useState<Partial<Record<string, string>>>({});
  const [thresholdErrors, setThresholdErrors] = useState<Partial<Record<string, string>>>({});
  const [suggesting, setSuggesting] = useState(false);
  // null = no preview open. The preview is deliberately separate from cfg:
  // nothing reaches the roster until "Add selected to roster" is pressed.
  const [suggestions, setSuggestions] = useState<SuggestedPerson[] | null>(null);
  const [suggestNotes, setSuggestNotes] = useState<string[]>([]);

  useEffect(() => {
    fetch('/api/kpi/odoo-options', { credentials: 'include' })
      .then(async (r) => {
        // Defensive parse, for the same reason as the KPI page: a timed-out
        // route answers with plain text, and parsing that throws a JSON error
        // that tells the reader nothing about what actually went wrong.
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.detail || body?.error || r.statusText || `Request failed (${r.status})`);
        if (!body) throw new Error('The server answered with something that was not a list of options.');
        setOpts(body as OdooOptions);
      })
      .catch((e) => setOptsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingOpts(false));
  }, []);

  function setSelector(key: MapKey, next: StageSelector) {
    setCfg((p) => ({ ...p, stageMap: { ...p.stageMap, [key]: next } }));
  }

  function toggleValue(key: MapKey, value: string | number) {
    const cur = cfg.stageMap[key];
    const has = cur.values.some((v) => String(v) === String(value));
    setSelector(key, { ...cur, values: has ? cur.values.filter((v) => String(v) !== String(value)) : [...cur.values, value] });
  }

  function optionsFor(kind: StageSelectorKind): { value: string | number; label: string }[] {
    if (!opts) return [];
    if (kind === 'priority') return opts.priorityOptions.map((o) => ({ value: o.value, label: `${o.label} (${o.value})` }));
    if (kind === 'state') return (opts.stateOptions ?? []).map((o) => ({ value: o.value, label: `${o.label} (${o.value})` }));
    if (kind === 'repairState') return (opts.repairStateOptions ?? []).map((o) => ({ value: o.value, label: `${o.label} (${o.value})` }));
    if (kind === 'stage') return opts.stages.map((s) => ({ value: s.id, label: s.name }));
    return opts.tags.map((t) => ({ value: t.id, label: t.name }));
  }

  const rosterById = new Map(cfg.saRoster.map((r) => [r.odooUserId, r]));

  function toggleSa(user: { id: number; name: string }) {
    setCfg((p) => {
      const exists = p.saRoster.some((r) => r.odooUserId === user.id);
      return {
        ...p,
        saRoster: exists
          ? p.saRoster.filter((r) => r.odooUserId !== user.id)
          : [...p.saRoster, { odooUserId: user.id, name: user.name, branch: KPI_BRANCHES[0] }],
      };
    });
  }

  function setSaBranch(userId: number, branch: string) {
    setCfg((p) => ({ ...p, saRoster: p.saRoster.map((r) => (r.odooUserId === userId ? { ...r, branch } : r)) }));
  }

  function setSaSection(userId: number, section: KpiSection) {
    setCfg((p) => ({ ...p, saRoster: p.saRoster.map((r) => (r.odooUserId === userId ? { ...r, section } : r)) }));
  }

  /**
   * Back to the default means DELETING the branch's key — a stored 0 or null
   * would still read as "nominated" and credit every verdict to nobody.
   */
  function setRfqCoordinator(branch: Branch, userId: string) {
    setCfg((p) => {
      const next = { ...(p.rfqCoordinators ?? {}) };
      const user = (opts?.users ?? []).find((u) => String(u.id) === userId);
      if (user) next[branch] = { id: user.id, name: user.name };
      else delete next[branch];
      return { ...p, rfqCoordinators: next };
    });
  }

  /**
   * Reads 30 days of Odoo activity into a review panel. Slow (~30s). A second run
   * replaces the whole preview, and a failure leaves both preview and roster alone.
   */
  async function loadSuggestion() {
    setSuggesting(true); setMessage('');
    try {
      const res = await fetch('/api/kpi/roster-suggestion', { credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(`Error ${res.status}: ${body?.detail || body?.error || res.statusText}`);
        return;
      }
      const people: RosterSuggestion[] = Array.isArray(body?.people) ? body.people : [];
      setSuggestions(people.map((p) => toSuggestedPerson(p, rosterById.has(p.odooUserId))));
      setSuggestNotes(Array.isArray(body?.notes) ? body.notes : []);
    } catch (e) {
      setMessage(`Suggestion failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setSuggesting(false); }
  }

  function toggleSuggestion(userId: number) {
    setSuggestions((p) => p && p.map((s) => (s.odooUserId === userId ? { ...s, checked: !s.checked } : s)));
  }

  function setAllSuggestions(checked: boolean) {
    setSuggestions((p) => p && p.map((s) => ({ ...s, checked })));
  }

  function setSuggestionBranch(userId: number, branch: string) {
    setSuggestions((p) => p && p.map((s) => (s.odooUserId === userId ? { ...s, branchPick: branch } : s)));
  }

  function setSuggestionSection(userId: number, section: KpiSection) {
    setSuggestions((p) => p && p.map((s) => (s.odooUserId === userId ? { ...s, sectionPick: section } : s)));
  }

  function discardSuggestion() {
    setSuggestions(null); setSuggestNotes([]);
  }

  /**
   * Merges the checked rows into the roster: upsert by odooUserId, so re-checking
   * someone already tracked updates their row instead of duplicating it. Unchecked
   * rows and untouched roster entries are left exactly as they were, and nothing is
   * persisted — save() stays an explicit act.
   */
  function applySuggestion() {
    const picked = (suggestions ?? []).filter((s) => s.checked);
    if (picked.length === 0) {
      setMessage('Nothing selected — the roster is unchanged.');
      return;
    }
    setCfg((p) => {
      const next = [...p.saRoster];
      for (const s of picked) {
        const entry = { odooUserId: s.odooUserId, name: s.name, branch: s.branchPick, section: s.sectionPick };
        const at = next.findIndex((r) => r.odooUserId === s.odooUserId);
        if (at >= 0) next[at] = { ...next[at], ...entry };
        else next.push(entry);
      }
      return { ...p, saRoster: next };
    });
    discardSuggestion();
    setMessage(`✓ Added ${countLabel(picked.length, 'person', 'people')} to the roster — not saved yet. Press Save KPI Configuration below to persist.`);
  }

  function toggleKpi(id: number) {
    setCfg((p) => ({
      ...p,
      enabledKpis: p.enabledKpis.includes(id) ? p.enabledKpis.filter((k) => k !== id) : [...p.enabledKpis, id].sort(),
    }));
  }

  function setKpiSection(id: number, section: KpiSection) {
    setCfg((p) => ({ ...p, kpiSections: { ...(p.kpiSections ?? {}), [id]: section } }));
  }

  /**
   * Commits a threshold only when it is a whole number above zero.
   *
   * The old handler was `parseInt(e.target.value) || 0`, so an emptied box saved 0.
   * The engine reads `thresholds.X ?? default` and 0 is not nullish, so the default
   * never came back: the limit became zero, nothing could be inside it, and roughly
   * fourteen KPIs marked everyone non-compliant — with no warning anywhere.
   */
  function setThreshold(k: keyof Thresholds, raw: string, badInput: boolean) {
    setThresholdText((p) => ({ ...p, [k]: raw }));
    const trimmed = raw.trim();
    const fail = (why: string) => setThresholdErrors((p) => ({ ...p, [k]: why }));
    const pass = () => setThresholdErrors((p) => {
      const next = { ...p };
      delete next[k];
      return next;
    });

    // A number input reports '' for text it cannot parse at all ('-', 'e', '1..2').
    // badInput separates that from a box the admin deliberately emptied.
    if (trimmed === '' && badInput) {
      fail('Enter a whole number above 0.');
      return;
    }
    if (trimmed === '') {
      if (!isClearableThreshold(k)) {
        fail('This limit has no built-in default, so it cannot be left empty — enter a whole number above 0.');
        return;
      }
      // Narrowed into a const: TypeScript drops a parameter's narrowing inside a
      // callback, and only an optional key may be deleted.
      const clearable: ClearableThresholdKey = k;
      pass();
      setCfg((p) => {
        const thresholds = { ...p.thresholds };
        delete thresholds[clearable];
        return { ...p, thresholds };
      });
      return;
    }
    // Whole numbers only, and above zero: a zero limit fails everyone, and nothing
    // downstream reads a fraction of an hour, a day or a minute.
    if (!/^\d+$/.test(trimmed) || Number(trimmed) === 0) {
      fail(
        'Must be a whole number above 0.'
        + (isClearableThreshold(k) ? ' Clear the box to use the built-in default.' : ''),
      );
      return;
    }
    pass();
    setCfg((p) => ({ ...p, thresholds: { ...p.thresholds, [k]: Number(trimmed) } }));
  }

  /** One threshold box, its hint, and the reason its last value was refused. */
  function thresholdField(k: keyof Thresholds, label: string) {
    const error = thresholdErrors[k];
    const hint = THRESHOLD_HINTS[k];
    return (
      <div key={k} className="flex flex-col gap-1 max-w-xs">
        <label className="text-sm text-ink-muted flex items-center gap-2">
          {label}
          {/* No `?? 0` fallback: an unset optional threshold shows as an empty box,
              which is exactly what it means — the engine's own default applies. */}
          <input type="number" min="1" step="1" className={inputCls}
            aria-invalid={!!error}
            value={thresholdText[k] ?? cfg.thresholds[k] ?? ''}
            onChange={(e) => setThreshold(k, e.target.value, e.target.validity.badInput)} />
        </label>
        {hint && <span className="text-xs text-ink-muted">{hint}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    );
  }

  async function save() {
    // A refused threshold was never written into cfg, so saving now would quietly
    // persist the previous value under a box showing something else. Stop instead.
    const refused = Object.keys(thresholdErrors).filter((k) => thresholdErrors[k]);
    if (refused.length > 0) {
      setMessage(`Not saved — ${countLabel(refused.length, 'threshold', 'thresholds')} still rejected above. Fix or clear the highlighted boxes.`);
      return;
    }
    setSaving(true); setMessage('');
    try {
      const res = await fetch('/api/data', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // The holidays are re-validated here as well as on keystroke, so dates
        // stored before this check existed cannot survive an untouched save.
        body: JSON.stringify({ type: 'kpi-config', payload: { ...cfg, publicHolidays: splitHolidays(holidayText).kept } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMessage(`Error ${res.status}: ${body?.detail || body?.error || res.statusText}`);
        return;
      }
      setMessage('✓ KPI configuration saved — the KPI page will use it on the next refresh.');
    } catch (e) {
      setMessage(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setSaving(false); }
  }

  const allUsers = opts?.users ?? [];
  // Read through the override rather than assumed — an admin may have moved KPI 18.
  const kpi18Section = sectionOf(18, cfg);
  const personQuery = personSearch.trim().toLowerCase();
  const matchedUsers = allUsers.filter(
    (u) => !rosterById.has(u.id) && (personQuery === '' || u.name.toLowerCase().includes(personQuery)),
  );
  const shownMatchIds = new Set(matchedUsers.slice(0, 60).map((u) => u.id));
  const hiddenMatchCount = matchedUsers.length - shownMatchIds.size;
  const visibleUsers = allUsers.filter((u) => rosterById.has(u.id) || shownMatchIds.has(u.id));

  const inputCls = 'w-24 px-3 py-1.5 border border-border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-sm';
  const selectedSuggestions = suggestions?.filter((s) => s.checked).length ?? 0;
  // No focus:outline-none on the preview controls — the focus ring must stay visible.
  const suggestPillCls = 'text-xs px-2.5 py-1 rounded-full border bg-white text-ink-muted border-border hover:border-gray-400 transition-colors cursor-pointer';
  const suggestSelectCls = 'text-xs border border-border rounded px-2 py-1 text-ink bg-white focus:border-evs-green';

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 mt-5">
      <h2 className="text-base font-bold uppercase tracking-wide text-ink">KPI Configuration</h2>
      <p className="text-sm text-ink-muted mt-1 mb-5">
        Maps the KPI rules onto this Odoo instance. Options are read live from Odoo, and
        the thresholds below also set the KPI names shown on the dashboard.
      </p>

      {loadingOpts && <div className="text-sm text-ink-muted mb-4">Loading options from Odoo…</div>}
      {optsError && (
        <div className="mb-4 px-4 py-2.5 bg-danger/5 border border-danger/20 rounded-md text-sm text-danger">
          Could not load Odoo options: {optsError}. Thresholds and toggles can still be edited.
        </div>
      )}

      {/* Field verification */}
      {opts && (
        <div className="mb-5 px-4 py-3 bg-surface border border-border rounded-md">
          <div className="text-xs font-bold uppercase tracking-wide text-ink-muted mb-2">Odoo field check (repair.order)</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {([
              ['stage_id', opts.fieldReport.hasStageId],
              ['state', opts.fieldReport.hasState],
              ['priority_matrix_status', opts.fieldReport.hasPriorityMatrixStatus],
              ['status_since', opts.fieldReport.hasStatusSince],
              ['date_last_stage_update', opts.fieldReport.hasDateLastStageUpdate],
              ['sale_order_id', opts.fieldReport.hasSaleOrderId],
            ] as const).map(([f, ok]) => (
              <span key={f} className={ok ? 'text-evs-green-dark' : 'text-ink-muted'}>{ok ? '✓' : '✕'} {f}</span>
            ))}
          </div>
          {opts.fieldReport.notes.map((n) => <div key={n} className="text-xs text-ink-muted mt-1.5">ⓘ {n}</div>)}
        </div>
      )}

      {/* 1. Stage & tag mapping */}
      <div className="text-sm font-bold text-ink mb-3">1. State mapping</div>
      <div className="space-y-4 mb-6">
        {(Object.keys(MAP_LABELS) as MapKey[]).map((key) => {
          const sel = cfg.stageMap[key] ?? { kind: 'tag' as StageSelectorKind, values: [] };
          const list = optionsFor(sel.kind);
          return (
            <div key={key} className="border border-border rounded-md p-3">
              <div className="flex items-center gap-3 flex-wrap mb-2">
                <span className="text-sm font-semibold text-ink min-w-[120px]">{MAP_LABELS[key]}</span>
                {(['priority', 'repairState', 'state', 'stage', 'tag'] as StageSelectorKind[]).map((k) => (
                  <label key={k} className="text-xs text-ink-muted flex items-center gap-1 cursor-pointer">
                    <input type="radio" name={`kind-${key}`} checked={sel.kind === k}
                      onChange={() => setSelector(key, { kind: k, values: [] })} />
                    {k === 'priority' ? 'Priority matrix' : k === 'repairState' ? 'Repair Status' : k === 'state' ? 'State' : k === 'stage' ? 'Stage' : 'Tag'}
                  </label>
                ))}
                <span className="text-xs text-ink-muted">{sel.values.length} selected</span>
              </div>
              {MAP_HINTS[key] && <div className="text-xs text-ink-muted mb-2">{MAP_HINTS[key]}</div>}
              {list.length === 0 ? (
                <div className="text-xs text-ink-muted">No {sel.kind} options available on this instance.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                  {list.map((o) => {
                    const active = sel.values.some((v) => String(v) === String(o.value));
                    return (
                      <button key={String(o.value)} onClick={() => toggleValue(key, o.value)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors cursor-pointer ${
                          active ? 'bg-evs-green text-white border-evs-green' : 'bg-white text-ink-muted border-border hover:border-gray-400'}`}>
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 2. Thresholds */}
      <div className="text-sm font-bold text-ink mb-3">2. Thresholds</div>
      <p className="text-xs text-ink-muted mb-2">
        Counted on the business-hours clock: work hours are Sat–Thu 09:00–18:00; Fridays and public holidays do not count.
      </p>
      <div className="flex flex-wrap gap-5 mb-5">
        {([
          ['checkInHours', 'Check-in within (business hrs)'],
          ['inspectionHours', 'Inspection duration (business hrs)'],
          ['quoteSentHours', 'Quote sent after inspection (business hrs)'],
          ['quoteApprovalHours', 'Quote approval (business hrs)'],
          ['qaHours', 'QA duration (business hrs)'],
          ['invoiceHours', 'Invoice posted after Repaired (business hrs)'],
          ['deliveryHours', 'Delivered after Repaired (business hrs)'],
          ['mentionResponseHours', 'Reply to a chatter mention (business hrs)'],
        ] as const).map(([k, label]) => thresholdField(k, label))}
      </div>
      <p className="text-xs text-ink-muted mb-2">Counted in calendar time, including Fridays and holidays.</p>
      <div className="flex flex-wrap gap-5 mb-6">
        {([
          ['rfqAfterApprovalDays', 'RFQ raised within (days of approval)'],
          ['rfqConfirmDays', 'RFQ confirmed within (days)'],
          ['partsPlacedDays', 'Parts placed within (days of PO)'],
          ['tagMinutes', 'Tag deadline (minutes)'],
          ['awaitingPartsDays', 'Awaiting parts (days)'],
          ['awaitingLabourDays', 'Awaiting labour (days)'],
          ['followUpGraceDays', 'Follow-up grace after delivery (days)'],
          ['snapshotBaselineDays', 'Awaiting parts/labour compared against last N days'],
        ] as const).map(([k, label]) => thresholdField(k, label))}
      </div>

      {/* 2a. How "Awaiting parts" is detected */}
      <div className="text-sm font-bold text-ink mb-1">2a. &ldquo;Awaiting parts&rdquo; detected by</div>
      <p className="text-xs text-ink-muted mb-2">Only open repair orders are considered either way.</p>
      <div className="flex flex-col gap-1.5 mb-6">
        {([
          ['parts', 'Outstanding parts — a parts line whose Done quantity is below Demand (recommended: reads the real parts data)'],
          ['state', 'Mapped state — whatever is selected as "Awaiting parts" above (currently Priority Matrix P)'],
        ] as const).map(([v, label]) => (
          <label key={v} className="text-xs text-ink-muted flex items-start gap-2 cursor-pointer">
            <input type="radio" name="awaitingPartsSource" className="mt-0.5"
              checked={(cfg.awaitingPartsSource ?? 'parts') === v}
              onChange={() => setCfg((p) => ({ ...p, awaitingPartsSource: v }))} />
            <span>{label}</span>
          </label>
        ))}
      </div>

      {/* 2b. Age basis for KPIs 6 & 7 */}
      <div className="text-sm font-bold text-ink mb-1">2b. Time-in-state measured from</div>
      <p className="text-xs text-ink-muted mb-2">
        Used by &ldquo;Awaiting parts&rdquo; and &ldquo;Awaiting labour&rdquo; to decide how long a vehicle has been waiting.
      </p>
      <div className="flex flex-col gap-1.5 mb-6">
        {([
          ['auto', 'Automatic — Status Since if available, then the stage-change stamp, otherwise RO creation date (recommended)'],
          ['status_since', 'Status Since — how long the vehicle has been in its current status (most accurate on this instance)'],
          ['date_last_stage_update', 'Last stage change — most accurate, only if Odoo has the field'],
          ['create_date', 'Repair order creation date — may over-report, but never hides a stuck vehicle'],
          ['write_date', 'Last modified — ⚠ any edit resets the clock and hides overdue vehicles'],
        ] as const).map(([v, label]) => (
          <label key={v} className="text-xs text-ink-muted flex items-start gap-2 cursor-pointer">
            <input type="radio" name="ageBasis" className="mt-0.5" checked={(cfg.ageBasis ?? 'auto') === v}
              onChange={() => setCfg((p) => ({ ...p, ageBasis: v }))} />
            <span>{label}</span>
          </label>
        ))}
      </div>

      {/* 2c. Public holidays */}
      <div className="text-sm font-bold text-ink mb-1">2c. Public holidays</div>
      <p className="text-xs text-ink-muted mb-2">
        One date per line, zero-padded (YYYY-MM-DD). These days are skipped by every business-hours KPI,
        exactly like Fridays. A line in any other shape is listed below the box and is not saved — the
        clock matches nothing else, so it would be excluded from nothing.
      </p>
      <div className="mb-6">
        <label className="text-sm text-ink-muted flex flex-col gap-2">
          Gulf public holidays
          {/* Bound to the raw text rather than to the parsed list: feeding the list
              back into the box would swallow each newline as it is typed. */}
          <textarea rows={4} spellCheck={false} placeholder={'2026-12-02\n2026-12-03'}
            className="w-56 px-3 py-1.5 border border-border rounded text-ink focus:border-evs-green focus:outline-none text-sm font-mono"
            value={holidayText}
            onChange={(e) => {
              setHolidayText(e.target.value);
              // Only usable dates reach the config; the rest are reported, never
              // auto-corrected — guessing 02/12/2026 is day-first or month-first
              // would move a holiday rather than flag it.
              const { kept, rejected } = splitHolidays(e.target.value);
              setHolidayRejects(rejected);
              setCfg((p) => ({ ...p, publicHolidays: kept }));
            }} />
          {holidayRejects.length > 0 && (
            <span className="text-xs text-danger">
              Not saved — expected YYYY-MM-DD, zero-padded and a real calendar date
              (2026-12-02, not 2026-12-2 or 02/12/2026):{' '}
              {holidayRejects.join(', ')}
            </span>
          )}
        </label>
      </div>

      {/* 2d. Who raises the RFQs */}
      <div className="text-sm font-bold text-ink mb-1">2d. RFQ coordinator per branch</div>
      <p className="text-xs text-ink-muted mb-2">
        RFQ after approval scores whoever opened the job card, which is rarely the person who raises the RFQ —
        name that person here and the branch&rsquo;s verdicts, hits and misses alike, move onto them.
      </p>
      <div className="flex flex-col gap-2 mb-6">
        {KPI_BRANCHES.map((b) => {
          const chosen = cfg.rfqCoordinators?.[b];
          const entry = chosen ? rosterById.get(chosen.id) : undefined;
          // A stored person Odoo no longer lists (archived, or options failed to
          // load) still has to appear, or the box would read as the default while
          // the config says otherwise.
          const missing = chosen && !allUsers.some((u) => u.id === chosen.id) ? chosen : undefined;
          return (
            <div key={b} className="flex flex-col gap-1">
              <label className="text-sm text-ink-muted flex items-center gap-2 flex-wrap">
                <span className="w-24">{b}</span>
                <select value={chosen ? String(chosen.id) : ''}
                  onChange={(e) => setRfqCoordinator(b, e.target.value)}
                  className="text-sm border border-border rounded px-2 py-1 text-ink bg-white focus:border-evs-green">
                  <option value="">— job card owner (default) —</option>
                  {missing && <option value={String(missing.id)}>{missing.name}</option>}
                  {allUsers.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.roCount > 0 ? `${u.name} (${u.roCount} ROs)` : u.name}
                    </option>
                  ))}
                </select>
              </label>
              {chosen && !entry && (
                <div className="text-xs text-ink-muted ml-24">
                  ⚠ {chosen.name} is not in Tracked people, so they get no card of their own — these
                  evaluations will only roll into the {b} total.
                </div>
              )}
              {/* Absent section means Service Advisor, so an untouched roster entry counts as one. */}
              {chosen && entry && (entry.section ?? 'advisor') === 'advisor' && kpi18Section === 'workshop' && (
                <div className="text-xs text-ink-muted ml-24">
                  ⚠ {chosen.name} is listed under {KPI_SECTION_LABELS.advisor}, but RFQ after approval sits in{' '}
                  {KPI_SECTION_LABELS.workshop} — it will not appear on their card until the person or the KPI is
                  reassigned (section 5 below).
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 3. Tracked people roster */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <div className="text-sm font-bold text-ink">3. Tracked people</div>
        <button
          onClick={loadSuggestion}
          disabled={suggesting}
          aria-busy={suggesting}
          title="Reads the last 30 days of Odoo activity and proposes who to track. Takes up to half a minute; nothing is saved until you apply it."
          className={`
            inline-flex items-center gap-2 px-4 py-1.5 text-sm font-semibold rounded-md
            border-2 transition-all duration-200
            ${suggesting
              ? 'border-amber-400 bg-amber-50 text-amber-700 cursor-wait'
              : 'border-ink/20 bg-white text-ink hover:border-evs-green hover:text-evs-green-dark'}
            disabled:opacity-50
          `}
        >
          {suggesting ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Reading Odoo…
            </>
          ) : 'Suggest from Odoo (30 days)'}
        </button>
      </div>
      <p className="text-xs text-ink-muted mb-3">
        Only checked users are measured individually. Everyone&apos;s ROs still count toward branch totals.
        A person&apos;s section decides which group they appear under on the KPI page — it is separate from
        which section a KPI itself belongs to (set in 5. KPI sections).
      </p>

      {/* 3a. Suggestion preview — reviewed here, merged into the roster only on apply. */}
      {suggestions && (
        <div className="border border-border rounded-md p-3 mb-4">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <span className="text-xs font-bold uppercase tracking-wide text-ink-muted">
              Suggested from Odoo — nothing is saved until you apply it
            </span>
            <span className="text-xs text-ink-muted tabular-nums">
              {selectedSuggestions} of {suggestions.length} selected
            </span>
          </div>
          <div className="flex items-center gap-2 mb-2">
            <button onClick={() => setAllSuggestions(true)} className={suggestPillCls}>Select all</button>
            <button onClick={() => setAllSuggestions(false)} className={suggestPillCls}>Select none</button>
          </div>
          {suggestNotes.map((n) => <div key={n} className="text-xs text-ink-muted mb-1.5">ⓘ {n}</div>)}

          <div className="max-h-72 overflow-y-auto border border-border rounded-md divide-y divide-border">
            {suggestions.map((s) => {
              const tracked = rosterById.has(s.odooUserId);
              const evidence = evidenceLine(s);
              return (
                <div key={s.odooUserId} className="flex items-start gap-3 px-3 py-2">
                  <input type="checkbox" checked={s.checked} onChange={() => toggleSuggestion(s.odooUserId)}
                    aria-label={`Add ${s.name} to the tracked roster`} className="mt-1 cursor-pointer" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap text-sm text-ink">
                      <span className="truncate">{s.name}</span>
                      {tracked && <span className="text-[11px] text-ink-muted">already tracked</span>}
                      {s.weakBranch && <span className="text-[11px] text-ink-muted">no clear branch</span>}
                    </div>
                    {evidence && <div className="text-[11px] text-ink-muted">{evidence}</div>}
                  </div>
                  <select value={s.branchPick} aria-label={`Branch for ${s.name}`}
                    onChange={(e) => setSuggestionBranch(s.odooUserId, e.target.value)} className={suggestSelectCls}>
                    {KPI_BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <select value={s.sectionPick} aria-label={`Section for ${s.name}`}
                    onChange={(e) => setSuggestionSection(s.odooUserId, e.target.value as KpiSection)} className={suggestSelectCls}>
                    {KPI_SECTION_ORDER.map((sec) => <option key={sec} value={sec}>{KPI_SECTION_LABELS[sec]}</option>)}
                  </select>
                </div>
              );
            })}
            {suggestions.length === 0 && (
              <div className="px-3 py-2 text-xs text-ink-muted">Odoo reported no activity in the last 30 days.</div>
            )}
          </div>

          <div className="flex items-center gap-3 mt-3">
            <button onClick={applySuggestion}
              className="px-4 py-1.5 bg-evs-green text-white text-sm font-bold rounded-md hover:bg-evs-green-dark transition-colors cursor-pointer">
              Add selected to roster
            </button>
            <button onClick={discardSuggestion}
              className="px-4 py-1.5 text-sm font-semibold rounded-md border-2 border-ink/20 bg-white text-ink hover:border-evs-green hover:text-evs-green-dark transition-all duration-200 cursor-pointer">
              Discard
            </button>
          </div>
        </div>
      )}

      {opts && opts.users.length > 0 ? (
        <>
        <input type="text" value={personSearch} onChange={(e) => setPersonSearch(e.target.value)}
          placeholder="Search people…"
          className="text-sm border border-border rounded px-3 py-1.5 text-ink focus:border-evs-green focus:outline-none mb-2" />
        <div className="overflow-x-auto max-h-72 overflow-y-auto border border-border rounded-md mb-6">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Tracked</th>
                <th className="text-left py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Odoo user</th>
                <th className="text-right py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">ROs (90d)</th>
                <th className="text-left py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Branch</th>
                <th className="text-left py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Section</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u) => {
                const entry = rosterById.get(u.id);
                return (
                  <tr key={u.id} className="border-b border-border last:border-b-0">
                    <td className="py-1.5 px-3">
                      <input type="checkbox" checked={!!entry} onChange={() => toggleSa(u)} className="cursor-pointer" />
                    </td>
                    <td className="py-1.5 px-3 text-ink">{u.name}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-ink-muted">
                      {u.roCount > 0 ? <span className="text-[10px] text-ink-muted">{u.roCount} ROs</span> : null}
                    </td>
                    <td className="py-1.5 px-3">
                      <select disabled={!entry} value={entry?.branch ?? ''} onChange={(e) => setSaBranch(u.id, e.target.value)}
                        className="text-sm border border-border rounded px-2 py-1 text-ink bg-white disabled:opacity-40">
                        {KPI_BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </td>
                    <td className="py-1.5 px-3">
                      {/* Absent section means Service Advisor — the documented default, so never blank. */}
                      <select disabled={!entry} value={entry?.section ?? 'advisor'}
                        onChange={(e) => setSaSection(u.id, e.target.value as KpiSection)}
                        className="text-sm border border-border rounded px-2 py-1 text-ink bg-white disabled:opacity-40">
                        {KPI_SECTION_ORDER.map((s) => <option key={s} value={s}>{KPI_SECTION_LABELS[s]}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
              {visibleUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 px-3 text-xs text-ink-muted">No one matches that search.</td>
                </tr>
              )}
              {hiddenMatchCount > 0 && (
                <tr>
                  <td colSpan={5} className="py-2 px-3 text-xs text-ink-muted">
                    …and {hiddenMatchCount} more — refine your search
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </>
      ) : (
        <div className="text-sm text-ink-muted mb-6">{loadingOpts ? '' : 'No Odoo users found.'}</div>
      )}

      {/* 4. Enabled KPIs */}
      <div className="text-sm font-bold text-ink mb-3">4. Enabled KPIs</div>
      <div className="flex flex-wrap gap-2 mb-6">
        {KPI_DEFINITIONS.map((k) => {
          const on = cfg.enabledKpis.includes(k.id);
          return (
            <button key={k.id} onClick={() => toggleKpi(k.id)} title={k.rule}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors cursor-pointer ${
                on ? 'bg-evs-green text-white border-evs-green' : 'bg-white text-ink-muted border-border hover:border-gray-400'}`}>
              {kpiDisplayName(k.id, k.name, cfg.thresholds)}
            </button>
          );
        })}
      </div>

      {/* 5. KPI sections */}
      <div className="text-sm font-bold text-ink mb-1">5. KPI sections</div>
      <p className="text-xs text-ink-muted mb-3">
        KPIs are grouped on the dashboard into Service Advisor and Workshop, each with its own total.
        Both still feed the branch total.
      </p>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 mb-6">
        {KPI_DEFINITIONS.map((k) => {
          const current = sectionOf(k.id, cfg);
          return (
            <div key={k.id} className="flex items-center justify-between gap-3 min-w-0">
              <span className="text-[13px] text-ink truncate" title={k.rule}>
                {kpiDisplayName(k.id, k.name, cfg.thresholds)}
              </span>
              <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
                {KPI_SECTION_ORDER.map((s) => (
                  <button key={s} onClick={() => setKpiSection(k.id, s)}
                    className={`text-[11px] font-semibold px-2.5 py-1 transition-colors cursor-pointer ${
                      current === s ? 'bg-evs-green text-white' : 'bg-white text-ink-muted hover:text-ink'}`}>
                    {KPI_SECTION_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-4">
        <button onClick={save} disabled={saving}
          className="px-6 py-2.5 bg-evs-green text-white text-sm font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50">
          {saving ? 'Saving…' : 'Save KPI Configuration →'}
        </button>
        {message && (
          <span className={`text-sm font-semibold ${message.startsWith('✓') ? 'text-evs-green-dark' : 'text-danger'}`}>{message}</span>
        )}
      </div>
    </div>
  );
}
