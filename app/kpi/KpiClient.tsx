'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KpiTree, BranchNode, SaNode, KpiCell } from '@/lib/kpi';
import { KPI_DEFINITIONS } from '@/lib/types';

const BRANCH_COLORS: Record<string, string> = {
  Dubai: '#78C41A', Ajman: '#3B82F6', Sharjah: '#F59E0B',
  'Abu Dhabi': '#8B5CF6', 'Al Ain': '#EF4444', Qatar: '#06B6D4',
};

// Achievement bands (v1, hardcoded per spec)
function band(pct: number | null): { text: string; bar: string; hex: string } {
  if (pct === null) return { text: 'text-ink-muted', bar: 'bg-ink-muted/30', hex: '#888888' };
  if (pct >= 90) return { text: 'text-evs-green-dark', bar: 'bg-evs-green', hex: '#78C41A' };
  if (pct >= 75) return { text: 'text-amber-600', bar: 'bg-amber-500', hex: '#f59e0b' };
  return { text: 'text-danger', bar: 'bg-danger', hex: '#e53e3e' };
}

// KPI grouping comes from the shared definitions, so the page can't drift from them.
const GROUP_OF: Record<number, string> = Object.fromEntries(KPI_DEFINITIONS.map((d) => [d.id, d.group]));
const GROUP_ORDER: string[] = [...new Set(KPI_DEFINITIONS.map((d) => d.group as string))];

const fmtPct = (p: number | null) => (p === null ? 'N/A' : `${p.toFixed(1)}%`);

function fmtWeek(start: string, end: string) {
  const f = (d: string, withYear = false) =>
    new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
    });
  return `${f(start)} – ${f(end, true)}`;
}

/** Recent week-start Saturdays, newest first. */
function recentWeekStarts(count = 12): string[] {
  const now = new Date(Date.now() + 4 * 3600 * 1000);
  const back = (now.getUTCDay() - 6 + 7) % 7;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - back);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return out;
}

function Ring({ pct, size = 132 }: { pct: number | null; size?: number }) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const filled = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const { hex } = band(pct);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Achievement ${fmtPct(pct)}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#ffffff22" strokeWidth={10} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={hex} strokeWidth={10} strokeLinecap="round"
        strokeDasharray={`${(c * filled) / 100} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .5s cubic-bezier(.2,.8,.2,1)' }}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
        style={{ fill: '#fff', fontSize: size / 5, fontWeight: 800 }}>
        {pct === null ? 'N/A' : `${pct.toFixed(0)}%`}
      </text>
    </svg>
  );
}

function KpiRow({ cell, expandable = false }: { cell: KpiCell; expandable?: boolean }) {
  const [open, setOpen] = useState(false);
  const b = band(cell.pct);
  const na = cell.pct === null;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-ink truncate" title={cell.name}>
          {cell.name}
          {cell.snapshot && (
            <span className="ml-1 text-ink-muted cursor-help"
              title={cell.note || 'Point-in-time: reflects open ROs right now, not the selected week.'}>ⓘ</span>
          )}
        </span>
        <span className="flex-1" />
        <span className={`text-[13px] font-bold tabular-nums shrink-0 ${b.text}`}>{fmtPct(cell.pct)}</span>
        <span className="text-[11px] text-ink-muted tabular-nums shrink-0 w-14 text-right">
          {na ? '—' : `${cell.compliant}/${cell.applicable}`}
        </span>
      </div>

      <div className="h-1.5 bg-border rounded-full overflow-hidden mt-1.5">
        <div
          className={`h-full rounded-full transition-all ${na ? '' : b.bar}`}
          style={{
            width: `${na ? 0 : Math.min(cell.pct as number, 100)}%`,
            // keep a sliver visible for very small non-zero percentages
            minWidth: !na && (cell.pct as number) > 0 ? 3 : 0,
          }}
        />
      </div>

      {na && <div className="text-[11px] text-ink-muted mt-1">No applicable records</div>}
      {expandable && cell.violations.length > 0 && (
        <div className="mt-1">
          <button onClick={() => setOpen((v) => !v)} className="text-[11px] font-semibold text-evs-green-dark hover:underline cursor-pointer">
            {open ? 'Hide' : 'View'} {cell.violations.length}{cell.violations.length === 50 ? '+' : ''} violation{cell.violations.length !== 1 ? 's' : ''}
          </button>
          {open && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {cell.violations.map((v) => (
                <code key={v} className="text-[11px] bg-surface border border-border rounded px-1.5 py-0.5 text-ink-soft select-all">{v}</code>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** KPIs grouped into labelled sections, two per row on wider screens. */
function KpiSections({ cells, expandable = false }: { cells: KpiCell[]; expandable?: boolean }) {
  return (
    <>
      {GROUP_ORDER.map((group) => {
        const items = cells.filter((c) => GROUP_OF[c.id] === group);
        if (!items.length) return null;
        return (
          <div key={group} className="mb-5 last:mb-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-muted mb-2.5 pb-1.5 border-b border-border">
              {group}
            </div>
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-4">
              {items.map((c) => <KpiRow key={c.id} cell={c} expandable={expandable} />)}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function KpiClient({ isAdmin }: { isAdmin: boolean }) {
  const weeks = recentWeekStarts();
  const [week, setWeek] = useState(weeks[0]);
  const [tree, setTree] = useState<KpiTree | null>(null);
  const [prev, setPrev] = useState<KpiTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [branch, setBranch] = useState<string | null>(null);
  const [sa, setSa] = useState<number | null>(null);

  const load = useCallback(async (w: string, refresh = false) => {
    setLoading(true); setError(''); setTree(null); setPrev(null);
    try {
      const res = await fetch(`/api/kpi?week=${w}${refresh ? '&refresh=1' : ''}`, { credentials: 'include' });
      const body = await res.json();
      if (!res.ok) { setError(body?.detail || body?.error || res.statusText); return; }
      setTree(body as KpiTree);
      // Previous week (for trend arrows) — best effort, never blocks the view.
      const pw = new Date(w + 'T00:00:00Z');
      pw.setUTCDate(pw.getUTCDate() - 7);
      fetch(`/api/kpi?week=${pw.toISOString().slice(0, 10)}`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null)).then((d) => d && setPrev(d as KpiTree)).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(week); }, [week, load]);

  const branchNode: BranchNode | undefined = tree?.branches.find((b) => b.name === branch);
  const saNode: SaNode | undefined = branchNode?.serviceAdvisors.find((s) => s.odooUserId === sa);
  const prevPct = (b: string) => prev?.branches.find((x) => x.name === b)?.achievement ?? null;

  return (
    <>
      {/* Controls */}
      <div className="bg-white rounded-lg p-4 mb-4 shadow-sm flex flex-wrap items-center gap-3">
        <span className="text-sm font-bold text-ink shrink-0">Week:</span>
        <select value={week} onChange={(e) => { setWeek(e.target.value); setBranch(null); setSa(null); }}
          className="text-sm border border-border rounded px-3 py-1.5 text-ink bg-white">
          {weeks.map((w, i) => {
            const end = new Date(w + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 6);
            return <option key={w} value={w}>{fmtWeek(w, end.toISOString().slice(0, 10))}{i === 0 ? ' (current)' : ''}</option>;
          })}
        </select>
        <span className="flex-1" />
        {tree && (
          <span className="text-xs text-ink-muted">
            Updated {new Date(tree.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        {isAdmin && (
          <button onClick={() => load(week, true)} disabled={loading}
            className="text-xs font-semibold px-3 py-1.5 rounded border border-border text-ink-muted hover:border-evs-green hover:text-evs-green-dark transition-colors cursor-pointer disabled:opacity-50">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {/* Breadcrumb */}
      {(branch || sa) && (
        <div className="flex items-center gap-2 mb-4 text-sm">
          <button onClick={() => { setBranch(null); setSa(null); }} className="text-evs-green-dark font-semibold hover:underline cursor-pointer">KPI</button>
          {branch && <><span className="text-ink-muted">/</span>
            <button onClick={() => setSa(null)} className={sa ? 'text-evs-green-dark font-semibold hover:underline cursor-pointer' : 'text-ink font-semibold'}>{branch}</button></>}
          {saNode && <><span className="text-ink-muted">/</span><span className="text-ink font-semibold">{saNode.name}</span></>}
        </div>
      )}

      {loading && <div className="bg-white rounded-lg p-8 text-center text-sm text-ink-muted shadow-sm">Loading live KPI data from Odoo…</div>}
      {error && !loading && (
        <div className="bg-white rounded-lg p-6 shadow-sm border-l-4 border-danger">
          <div className="font-bold text-danger mb-1">Could not load KPIs</div>
          <div className="text-sm text-ink-muted">{error}</div>
        </div>
      )}

      {tree && !loading && (
        <>
          {/* ── Level 1 — company + branches ── */}
          {!branchNode && (
            <>
              <div className="rounded-lg p-6 mb-4 shadow-sm flex items-center gap-6 flex-wrap"
                style={{ background: 'linear-gradient(135deg,#0d1f08 0%,#1a3a0d 60%,#0f2a09 100%)' }}>
                <Ring pct={tree.company.achievement} />
                <div>
                  <div className="text-xs uppercase tracking-widest text-white/50 mb-1">Company KPI Achievement</div>
                  <div className="text-white/45 text-sm mt-2">{fmtWeek(tree.week.start, tree.week.end)} · all branches</div>
                </div>
              </div>

              <div className="bg-white rounded-lg p-5 shadow-sm mb-4">
                <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-2">Company KPI Breakdown</div>
                <KpiSections cells={tree.company.kpis} />
              </div>

              <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-3">Branches — click to drill down</div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {tree.branches.map((b) => {
                  const bb = band(b.achievement);
                  const p = prevPct(b.name);
                  const delta = b.achievement !== null && p !== null ? b.achievement - p : null;
                  return (
                    <button key={b.name} onClick={() => { setBranch(b.name); setSa(null); }}
                      className="text-left bg-white rounded-lg p-4 shadow-sm border-l-[3px] hover:shadow-md transition-all cursor-pointer"
                      style={{ borderLeftColor: BRANCH_COLORS[b.name] ?? '#78C41A' }}>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-ink">{b.name}</span>
                        {delta !== null && Math.abs(delta) >= 0.1 && (
                          <span className={`text-xs font-semibold ${delta > 0 ? 'text-evs-green-dark' : 'text-danger'}`}>
                            {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}
                          </span>
                        )}
                      </div>
                      <div className={`text-3xl font-black tabular-nums mt-1.5 ${bb.text}`}>{fmtPct(b.achievement)}</div>
                      <div className="h-1.5 bg-border rounded-full overflow-hidden mt-2">
                        <div className={`h-full rounded-full ${b.achievement === null ? '' : bb.bar}`}
                          style={{
                            width: `${b.achievement === null ? 0 : Math.min(b.achievement, 100)}%`,
                            minWidth: b.achievement !== null && b.achievement > 0 ? 3 : 0,
                          }} />
                      </div>
                      <div className="text-xs text-ink-muted mt-2">
                        {b.applicableTotal} checks · {b.serviceAdvisors.length} advisor{b.serviceAdvisors.length !== 1 ? 's' : ''}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* ── Level 2 — branch ── */}
          {branchNode && !saNode && (
            <>
              <div className="bg-white rounded-lg p-5 shadow-sm mb-4">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">{branchNode.name} — KPI Breakdown</span>
                  <span className={`text-2xl font-black tabular-nums ${band(branchNode.achievement).text}`}>{fmtPct(branchNode.achievement)}</span>
                </div>
                <KpiSections cells={branchNode.kpis} />
              </div>

              <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-3">Service Advisors</div>
              {branchNode.serviceAdvisors.length === 0 ? (
                <div className="bg-white rounded-lg p-6 text-sm text-ink-muted shadow-sm">
                  No service advisors on the roster for {branchNode.name}. Add them in <strong>Admin → KPI Configuration</strong>.
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {branchNode.serviceAdvisors.map((s) => {
                    const sb = band(s.achievement);
                    return (
                      <button key={s.odooUserId} onClick={() => setSa(s.odooUserId)}
                        className="text-left bg-white rounded-lg p-4 shadow-sm hover:shadow-md transition-all cursor-pointer border-t-2"
                        style={{ borderTopColor: sb.hex }}>
                        <div className="font-bold text-ink truncate">{s.name}</div>
                        <div className={`text-2xl font-black tabular-nums mt-1 ${sb.text}`}>{fmtPct(s.achievement)}</div>
                        <div className="text-xs text-ink-muted mt-1.5">{s.roCount} RO{s.roCount !== 1 ? 's' : ''} this week</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ── Level 3 — service advisor ── */}
          {saNode && (
            <div className="bg-white rounded-lg p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <div>
                  <div className="text-lg font-bold text-ink">{saNode.name}</div>
                  <div className="text-xs text-ink-muted mt-0.5">{branchNode?.name} · {saNode.roCount} RO{saNode.roCount !== 1 ? 's' : ''} this week</div>
                </div>
                <span className={`text-3xl font-black tabular-nums ${band(saNode.achievement).text}`}>{fmtPct(saNode.achievement)}</span>
              </div>
              <KpiSections cells={saNode.kpis} expandable />
            </div>
          )}

        </>
      )}
    </>
  );
}
