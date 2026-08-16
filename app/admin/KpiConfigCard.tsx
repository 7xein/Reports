'use client';

import { useEffect, useState } from 'react';
import {
  BRANCHES, KPI_DEFINITIONS, KpiConfig, StageSelector, StageSelectorKind, withKpiDefaults,
} from '@/lib/types';

interface OdooOptions {
  priorityOptions: { value: string; label: string }[];
  stateOptions: { value: string; label: string }[];
  stages: { id: number; name: string }[];
  tags: { id: number; name: string }[];
  users: { id: number; name: string; roCount: number }[];
  fieldReport: {
    hasStageId: boolean; hasState: boolean; hasPriorityMatrixStatus: boolean;
    hasDateLastStageUpdate: boolean; hasSaleOrderId: boolean;
    stageAgeField: string; notes: string[];
  };
}

type MapKey = 'repaired' | 'underRepair' | 'awaitingParts' | 'awaitingLabour';
const MAP_LABELS: Record<MapKey, string> = {
  repaired: 'Repaired', underRepair: 'Under repair',
  awaitingParts: 'Awaiting parts', awaitingLabour: 'Awaiting labour',
};

export function KpiConfigCard({ initialConfig }: { initialConfig?: KpiConfig }) {
  const [cfg, setCfg] = useState<KpiConfig>(withKpiDefaults(initialConfig));
  const [opts, setOpts] = useState<OdooOptions | null>(null);
  const [optsError, setOptsError] = useState('');
  const [loadingOpts, setLoadingOpts] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetch('/api/kpi/odoo-options', { credentials: 'include' })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.detail || body?.error || r.statusText);
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
          : [...p.saRoster, { odooUserId: user.id, name: user.name, branch: BRANCHES[0] }],
      };
    });
  }

  function setSaBranch(userId: number, branch: string) {
    setCfg((p) => ({ ...p, saRoster: p.saRoster.map((r) => (r.odooUserId === userId ? { ...r, branch } : r)) }));
  }

  function toggleKpi(id: number) {
    setCfg((p) => ({
      ...p,
      enabledKpis: p.enabledKpis.includes(id) ? p.enabledKpis.filter((k) => k !== id) : [...p.enabledKpis, id].sort(),
    }));
  }

  async function save() {
    setSaving(true); setMessage('');
    try {
      const res = await fetch('/api/data', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'kpi-config', payload: cfg }),
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

  const inputCls = 'w-24 px-3 py-1.5 border border-border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-sm';

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 mt-5">
      <h2 className="text-base font-bold uppercase tracking-wide text-ink">KPI Configuration</h2>
      <p className="text-sm text-ink-muted mt-1 mb-5">
        Maps the 7 KPI rules onto this Odoo instance. Options are read live from Odoo.
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
          const sel = cfg.stageMap[key];
          const list = optionsFor(sel.kind);
          return (
            <div key={key} className="border border-border rounded-md p-3">
              <div className="flex items-center gap-3 flex-wrap mb-2">
                <span className="text-sm font-semibold text-ink min-w-[120px]">{MAP_LABELS[key]}</span>
                {(['priority', 'state', 'stage', 'tag'] as StageSelectorKind[]).map((k) => (
                  <label key={k} className="text-xs text-ink-muted flex items-center gap-1 cursor-pointer">
                    <input type="radio" name={`kind-${key}`} checked={sel.kind === k}
                      onChange={() => setSelector(key, { kind: k, values: [] })} />
                    {k === 'priority' ? 'Priority matrix' : k === 'state' ? 'State' : k === 'stage' ? 'Stage' : 'Tag'}
                  </label>
                ))}
                <span className="text-xs text-ink-muted">{sel.values.length} selected</span>
              </div>
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
      <div className="flex flex-wrap gap-5 mb-6">
        {([
          ['quoteApprovalDays', 'Quote approval (days)'],
          ['tagMinutes', 'Tag deadline (minutes)'],
          ['invoiceGraceMinutes', 'Invoice grace after delivery (minutes)'],
          ['awaitingPartsDays', 'Awaiting parts (days)'],
          ['awaitingLabourDays', 'Awaiting labour (days)'],
        ] as const).map(([k, label]) => (
          <label key={k} className="text-sm text-ink-muted flex items-center gap-2">
            {label}
            <input type="number" min="0" className={inputCls} value={cfg.thresholds[k]}
              onChange={(e) => setCfg((p) => ({ ...p, thresholds: { ...p.thresholds, [k]: parseInt(e.target.value) || 0 } }))} />
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
          ['auto', 'Automatic — stage-change stamp if available, otherwise RO creation date (recommended)'],
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

      {/* 3. SA roster */}
      <div className="text-sm font-bold text-ink mb-1">3. Service advisor roster</div>
      <p className="text-xs text-ink-muted mb-3">
        Only checked users appear at the SA level. Everyone&apos;s ROs still count toward branch totals.
      </p>
      {opts && opts.users.length > 0 ? (
        <div className="overflow-x-auto max-h-72 overflow-y-auto border border-border rounded-md mb-6">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Is SA</th>
                <th className="text-left py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Odoo user</th>
                <th className="text-right py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">ROs (90d)</th>
                <th className="text-left py-2 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Branch</th>
              </tr>
            </thead>
            <tbody>
              {opts.users.map((u) => {
                const entry = rosterById.get(u.id);
                return (
                  <tr key={u.id} className="border-b border-border last:border-b-0">
                    <td className="py-1.5 px-3">
                      <input type="checkbox" checked={!!entry} onChange={() => toggleSa(u)} className="cursor-pointer" />
                    </td>
                    <td className="py-1.5 px-3 text-ink">{u.name}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-ink-muted">{u.roCount}</td>
                    <td className="py-1.5 px-3">
                      <select disabled={!entry} value={entry?.branch ?? ''} onChange={(e) => setSaBranch(u.id, e.target.value)}
                        className="text-sm border border-border rounded px-2 py-1 text-ink bg-white disabled:opacity-40">
                        {BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-sm text-ink-muted mb-6">{loadingOpts ? '' : 'No RO creators found in the last 90 days.'}</div>
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
              {k.id}. {k.name}
            </button>
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
