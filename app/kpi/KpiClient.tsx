'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KpiTree, BranchNode, SaNode, KpiCell } from '@/lib/kpi';
import {
  KPI_DEFINITIONS, KpiWeekSummary, EXCLUDED_FROM_OVERALL, DEFAULT_KPI_TARGET, targetOf,
  KPI_SECTION_ORDER, KPI_SECTION_LABELS, type KpiSection,
} from '@/lib/types';

const BRANCH_COLORS: Record<string, string> = {
  Dubai: '#78C41A', Ajman: '#3B82F6', Sharjah: '#F59E0B',
  'Abu Dhabi': '#8B5CF6', 'Al Ain': '#EF4444', 'EV Hub': '#EC4899', Qatar: '#06B6D4',
};

/**
 * Section accents are deliberately cool hues, kept well clear of the warm
 * green → amber → red performance scale, so a category colour can never be
 * mistaken for a score.
 */
const SECTION_ACCENT: Record<KpiSection, string> = {
  advisor: '#0ea5e9',
  workshop: '#6366f1',
};

/** Short section labels for the compact two-figure readouts. */
const SECTION_SHORT: Record<KpiSection, string> = {
  advisor: 'SA',
  workshop: 'WS',
};

const LOW_VOLUME = 5;      // fewer applicable records than this gets an n=X badge

/** How far below its target a KPI may fall before amber turns red. */
const AMBER_SPAN = 15;

/**
 * Achievement bands, relative to the KPI's own target. Bars are painted at full
 * strength via inline styles rather than utility classes, so a stray token in
 * the Tailwind config can never wash one of them out again.
 *
 * At the default target of 90 the cut-offs are the familiar 90 / 75.
 */
function band(pct: number | null, target: number = DEFAULT_KPI_TARGET): { text: string; hex: string } {
  if (pct === null) return { text: 'text-ink-muted', hex: '#c2c7bf' };
  if (pct >= target) return { text: 'text-evs-green-dark', hex: '#78C41A' };
  if (pct >= target - AMBER_SPAN) return { text: 'text-amber-600', hex: '#f5a300' };
  return { text: 'text-danger', hex: '#e53e3e' };
}

// Grouping comes from the shared definitions, so the page can't drift from them.
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

function Delta({ value, className = '' }: { value: number | null; className?: string }) {
  if (value === null || Math.abs(value) < 0.05) {
    return <span className={`text-[11px] text-ink-muted tabular-nums ${className}`}>—</span>;
  }
  const up = value > 0;
  return (
    <span className={`text-[11px] font-semibold tabular-nums ${up ? 'text-evs-green-dark' : 'text-danger'} ${className}`}>
      {up ? '▲' : '▼'} {Math.abs(value).toFixed(1)}
    </span>
  );
}

function AlertIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`h-3.5 w-3.5 shrink-0 text-danger ${className}`} viewBox="0 0 20 20" fill="currentColor" aria-label="Critical">
      <path fillRule="evenodd" d="M9.4 2.6a.7.7 0 011.2 0l7.2 13a.7.7 0 01-.6 1H2.8a.7.7 0 01-.6-1l7.2-13zM10 7a.8.8 0 00-.8.8v3.4a.8.8 0 001.6 0V7.8A.8.8 0 0010 7zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
    </svg>
  );
}

// ── KPI row ────────────────────────────────────────────────────────
function KpiRow({ cell, delta, expandable = false }: {
  cell: KpiCell;
  delta: number | null;
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const target = targetOf(cell.id);
  const b = band(cell.pct, target);
  const lowVolume = cell.applicable > 0 && cell.applicable < LOW_VOLUME;

  return (
    <div id={`kpi-${cell.id}`} className="px-4 py-2.5 border-b border-border last:border-b-0">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[13px] font-semibold truncate text-ink" title={cell.name}>
            {cell.name}
          </span>
          {cell.snapshot && (
            <span className="text-ink-muted cursor-help text-[11px]"
              title={cell.note || 'Point-in-time: reflects open ROs right now, not the selected week.'}>ⓘ</span>
          )}
          {lowVolume && (
            <span className="text-[10px] font-semibold text-ink-muted bg-surface border border-border rounded px-1.5 py-0.5 shrink-0"
              title="Low volume — small sample, read with care">n={cell.applicable}</span>
          )}
          {EXCLUDED_FROM_OVERALL.includes(cell.id) && (
            <span className="text-[10px] font-semibold text-ink-muted bg-surface border border-border rounded px-1.5 py-0.5 shrink-0"
              title="Shown for reference — not included in the overall achievement">not in overall</span>
          )}
        </span>

        <span className="flex-1 min-w-[8px]" />

        <Delta value={delta} className="w-12 text-right" />
        <span className="text-[11px] text-ink-muted tabular-nums w-14 text-right">
          {cell.compliant}/{cell.applicable}
        </span>
        {target !== DEFAULT_KPI_TARGET && (
          <span className="text-[11px] text-ink-muted tabular-nums shrink-0"
            title={`This KPI is judged against ${target}%, not the general ${DEFAULT_KPI_TARGET}%`}>target {target}%</span>
        )}
        <span className={`text-sm font-bold tabular-nums w-16 text-right ${b.text}`}>
          {cell.pct === null ? '—' : fmtPct(cell.pct)}
        </span>
      </div>

      <div className="h-1.5 bg-border rounded-full overflow-hidden mt-2">
        <div
          className="h-full rounded-full transition-all"
          style={{
            background: b.hex,
            // Nothing applicable runs the full width in grey — the row still reads
            // as complete without claiming a score it never earned.
            width: cell.pct === null ? '100%' : `${Math.min(cell.pct, 100)}%`,
            minWidth: (cell.pct ?? 0) > 0 ? 3 : 0,
          }}
        />
      </div>

      {expandable && cell.violations.length > 0 && (
        <div className="mt-1.5">
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

/** Compact "SA 62% · WS 48%" readout. Section totals always come from the tree. */
const fmtPctShort = (p: number | null) => (p === null ? '—' : `${Math.round(p)}%`);

function SectionFigures({ sections, labelClass, className = '' }: {
  sections: Record<KpiSection, number | null>;
  labelClass: string;
  className?: string;
}) {
  return (
    <span className={`text-[11px] tabular-nums whitespace-nowrap ${className}`}>
      {KPI_SECTION_ORDER.map((s, i) => (
        <span key={s}>
          {i > 0 && <span className={labelClass}> · </span>}
          <span className={labelClass}>{SECTION_SHORT[s]} </span>
          <span className="font-bold" style={{ color: band(sections[s]).hex }}>{fmtPctShort(sections[s])}</span>
        </span>
      ))}
    </span>
  );
}

// ── Grouped sections ───────────────────────────────────────────────
function KpiSections({ cells, sections, deltaFor, expandable = false }: {
  cells: KpiCell[];
  sections: Record<KpiSection, number | null>;
  deltaFor: (id: number) => number | null;
  expandable?: boolean;
}) {
  return (
    <div className="mb-4">
      {KPI_SECTION_ORDER.map((section, si) => {
        // The per-KPI override lives in admin and is already baked into the
        // server-computed section totals — rows only need the default grouping.
        const sectionCells = cells.filter((c) => c.section === section);
        // Groups whose KPIs span both sections legitimately appear under each,
        // showing only that section's rows.
        const groups = GROUP_ORDER
          .map((group) => ({ group, all: sectionCells.filter((c) => GROUP_OF[c.id] === group) }))
          .filter((g) => g.all.length > 0);
        // No cards means no section at all — never a header on its own.
        if (!groups.length) return null;

        const measured = sectionCells.filter((c) => c.pct !== null).length;
        const accent = SECTION_ACCENT[section];
        const total = sections[section];

        return (
          <div key={section} className={si > 0 ? 'mt-8' : ''}>
            <div className="flex items-baseline flex-wrap gap-x-2 pb-2 mb-3 border-b border-border">
              <span className="w-1 h-4 rounded-full shrink-0" style={{ background: accent }} />
              <span className="text-[13px] font-black uppercase tracking-[0.18em]" style={{ color: accent }}>
                {KPI_SECTION_LABELS[section]}
              </span>
              <span className="ml-auto flex items-baseline gap-2">
                <span className={`text-xl font-black tabular-nums ${band(total).text}`}>{fmtPct(total)}</span>
                <span className="text-[11px] text-ink-muted whitespace-nowrap">
                  {measured} of {sectionCells.length} measured
                </span>
              </span>
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              {groups.map(({ group, all }, i) => {
                // An odd number of cards leaves the last one alone on its row —
                // let it run full width rather than sit next to a gap.
                const wide = groups.length % 2 === 1 && i === groups.length - 1;
                // Worst-first within the group; unmeasured KPIs sink to the bottom.
                const ordered = [...all].sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101));
                return (
                  <div key={group} className={`border border-border rounded-lg overflow-hidden bg-white ${wide ? 'lg:col-span-2' : ''}`}>
                    <div className="bg-surface border-b border-border px-4 py-2 flex items-center gap-2">
                      <span className="w-1 h-3.5 rounded-full bg-evs-green shrink-0" />
                      <span className="text-xs font-bold uppercase tracking-wider text-ink">{group}</span>
                      <span className="text-[11px] text-ink-muted ml-auto">{all.length} KPI{all.length !== 1 ? 's' : ''}</span>
                    </div>
                    {ordered.map((c) => (
                      <KpiRow key={c.id} cell={c} delta={deltaFor(c.id)} expandable={expandable} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────
type TreeWithHistory = KpiTree & { history?: KpiWeekSummary[] };

export function KpiClient({ isAdmin }: { isAdmin: boolean }) {
  const weeks = recentWeekStarts();
  const [week, setWeek] = useState(weeks[0]);
  const [tree, setTree] = useState<TreeWithHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [branch, setBranch] = useState<string | null>(null);
  const [sa, setSa] = useState<number | null>(null);

  const load = useCallback(async (w: string, refresh = false) => {
    setLoading(true); setError(''); setTree(null);
    try {
      const res = await fetch(`/api/kpi?week=${w}${refresh ? '&refresh=1' : ''}`, { credentials: 'include' });
      const body = await res.json();
      if (!res.ok) { setError(body?.detail || body?.error || res.statusText); return; }
      setTree(body as TreeWithHistory);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(week); }, [week, load]);

  const branchNode: BranchNode | undefined = tree?.branches.find((b) => b.name === branch);
  const saNode: SaNode | undefined = branchNode?.serviceAdvisors.find((s) => s.odooUserId === sa);

  // ── History-derived deltas ───────────────────────────────────────
  const history = tree?.history ?? [];
  const past = history.filter((h) => h.weekStart !== tree?.week.start);
  const prev = past.length ? past[past.length - 1] : null;

  const companyDelta = prev && tree?.company.achievement != null && prev.company.achievement != null
    ? tree.company.achievement - prev.company.achievement : null;

  const branchDelta = (name: string) => {
    const now = tree?.branches.find((b) => b.name === name)?.achievement;
    const before = prev?.branches?.[name]?.achievement;
    return now != null && before != null ? now - before : null;
  };

  // KPI history is company-wide at level 1, branch-scoped once drilled in.
  const currentCells = () => (branch ? branchNode?.kpis : tree?.company.kpis) ?? [];
  const kpiDelta = (id: number) => {
    const cur = currentCells().find((c) => c.id === id)?.pct;
    const before = branch ? prev?.branches?.[branch]?.kpis?.[String(id)] : prev?.company.kpis?.[String(id)];
    return cur != null && before != null ? cur - before : null;
  };

  const scrollToKpi = (id: number) =>
    document.getElementById(`kpi-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

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
          {/* ── Level 1 — overview ── */}
          {!branchNode && (
            <>
              <div className="grid lg:grid-cols-2 gap-4 mb-4">
                {/* Company achievement */}
                <div className="rounded-lg p-6 shadow-sm flex flex-col justify-between"
                  style={{ background: 'linear-gradient(135deg,#0d1f08 0%,#1a3a0d 60%,#0f2a09 100%)' }}>
                  <div className="text-xs uppercase tracking-widest text-white/50">Company KPI Achievement</div>
                  <div className="flex items-end gap-4 mt-3 flex-wrap">
                    <span className="text-5xl font-black tabular-nums leading-none"
                      style={{ color: band(tree.company.achievement).hex }}>
                      {tree.company.achievement === null ? 'N/A' : `${tree.company.achievement.toFixed(1)}%`}
                    </span>
                    {companyDelta !== null && (
                      <span className={`text-sm font-bold tabular-nums pb-1 ${companyDelta >= 0 ? 'text-evs-green' : 'text-danger'}`}>
                        {companyDelta >= 0 ? '▲' : '▼'} {Math.abs(companyDelta).toFixed(1)} vs last week
                      </span>
                    )}
                  </div>
                  <SectionFigures sections={tree.company.sections} labelClass="text-white/50" className="mt-2 block" />
                  <div className="text-white/45 text-xs mt-4">{fmtWeek(tree.week.start, tree.week.end)} · all branches</div>
                </div>

                {/* Needs attention */}
                <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                  <div className="bg-surface border-b border-border px-4 py-2 flex items-center gap-2">
                    <AlertIcon />
                    <span className="text-xs font-bold uppercase tracking-wider text-ink">Needs Attention</span>
                  </div>
                  <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border">
                    <div className="p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-2">Lowest KPIs</div>
                      {[...tree.company.kpis].filter((c) => c.pct !== null)
                        .sort((a, b) => (a.pct as number) - (b.pct as number)).slice(0, 3)
                        .map((c) => (
                          <button key={c.id} onClick={() => scrollToKpi(c.id)}
                            className="w-full text-left flex items-center gap-2 py-1.5 px-1 rounded hover:bg-surface cursor-pointer">
                            <span className="text-[12px] text-ink truncate flex-1">{c.name}</span>
                            <span className="text-[10px] text-ink-muted tabular-nums">{c.compliant}/{c.applicable}</span>
                            <Delta value={kpiDelta(c.id)} />
                            <span className="text-[12px] font-bold tabular-nums text-danger w-12 text-right">{fmtPct(c.pct)}</span>
                          </button>
                        ))}
                      {!tree.company.kpis.some((c) => c.pct !== null) && (
                        <div className="text-[11px] text-ink-muted py-1.5">No scored KPIs this week.</div>
                      )}
                    </div>
                    <div className="p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-2">Lowest Branches</div>
                      {[...tree.branches].filter((b) => b.achievement !== null)
                        .sort((a, b) => (a.achievement as number) - (b.achievement as number)).slice(0, 3)
                        .map((b) => (
                          <button key={b.name} onClick={() => { setBranch(b.name); setSa(null); }}
                            className="w-full text-left flex items-center gap-2 py-1.5 px-1 rounded hover:bg-surface cursor-pointer">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: BRANCH_COLORS[b.name] ?? '#999' }} />
                            <span className="text-[12px] text-ink truncate flex-1">{b.name}</span>
                            <span className="text-[10px] text-ink-muted tabular-nums">{b.applicableTotal}</span>
                            <Delta value={branchDelta(b.name)} />
                            <span className="text-[12px] font-bold tabular-nums text-danger w-12 text-right">{fmtPct(b.achievement)}</span>
                          </button>
                        ))}
                      {!tree.branches.some((b) => b.achievement !== null) && (
                        <div className="text-[11px] text-ink-muted py-1.5">No branch data this week.</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Branch leaderboard */}
              <div className="bg-white rounded-lg shadow-sm overflow-hidden mb-4">
                <div className="bg-surface border-b border-border px-4 py-2 flex items-center gap-2">
                  <span className="w-1 h-3.5 rounded-full bg-evs-green shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider text-ink">Branch Leaderboard</span>
                  <span className="text-[11px] text-ink-muted ml-auto">best → worst · click to drill down</span>
                </div>
                {[...tree.branches]
                  .sort((a, b) => (b.achievement ?? -1) - (a.achievement ?? -1))
                  .map((b, i) => {
                    const bb = band(b.achievement);
                    return (
                      <button key={b.name} onClick={() => { setBranch(b.name); setSa(null); }}
                        className="w-full text-left px-4 py-2.5 border-b border-border last:border-b-0 hover:bg-surface transition-colors cursor-pointer">
                        <div className="flex items-center gap-3">
                          <span className="text-[11px] font-bold text-ink-muted tabular-nums w-5 shrink-0">#{i + 1}</span>
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: BRANCH_COLORS[b.name] ?? '#999' }} />
                          <span className="text-[13px] font-semibold text-ink w-24 shrink-0 truncate">{b.name}</span>
                          <span className="hidden sm:block flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                            <span className="block h-full rounded-full"
                              style={{ background: bb.hex, width: `${Math.min(b.achievement ?? 0, 100)}%` }} />
                          </span>
                          <span className="flex-1 sm:hidden" />
                          <SectionFigures sections={b.sections} labelClass="text-ink-muted"
                            className="hidden md:flex items-baseline gap-1 shrink-0" />
                          <Delta value={branchDelta(b.name)} className="w-14 text-right" />
                          <span className={`text-sm font-bold tabular-nums w-16 text-right ${bb.text}`}>{fmtPct(b.achievement)}</span>
                        </div>
                      </button>
                    );
                  })}
              </div>

              <KpiSections cells={tree.company.kpis} sections={tree.company.sections} deltaFor={kpiDelta} />
            </>
          )}

          {/* ── Level 2 — branch ── */}
          {branchNode && !saNode && (
            <>
              <div className="bg-white rounded-lg shadow-sm p-5 mb-4 flex items-center gap-4 flex-wrap">
                <div>
                  <div className="text-xs uppercase tracking-widest text-ink-muted">{branchNode.name}</div>
                  <div className="flex items-baseline gap-3 mt-1">
                    <span className={`text-3xl font-black tabular-nums ${band(branchNode.achievement).text}`}>
                      {fmtPct(branchNode.achievement)}
                    </span>
                    <Delta value={branchDelta(branchNode.name)} />
                  </div>
                </div>
              </div>

              <KpiSections cells={branchNode.kpis} sections={branchNode.sections} deltaFor={kpiDelta} />

              <div className="text-sm font-bold uppercase tracking-wide text-ink-muted mb-3 mt-5">People</div>
              {branchNode.serviceAdvisors.length === 0 ? (
                <div className="bg-white rounded-lg p-6 text-sm text-ink-muted shadow-sm">
                  No people on the roster for {branchNode.name}. Add them in <strong>Admin → KPI Configuration</strong>.
                </div>
              ) : (
                KPI_SECTION_ORDER.map((section, si) => {
                  // Already sorted by achievement in the engine — filtering keeps that order.
                  const people = branchNode.serviceAdvisors.filter((s) => s.section === section);
                  // No people means no section at all — never a header on its own.
                  if (!people.length) return null;
                  const accent = SECTION_ACCENT[section];
                  return (
                    <div key={section} className={si > 0 ? 'mt-6' : ''}>
                      <div className="flex items-baseline flex-wrap gap-x-2 mb-3">
                        <span className="w-1 h-3.5 rounded-full shrink-0" style={{ background: accent }} />
                        <span className="text-[11px] font-black uppercase tracking-[0.18em]" style={{ color: accent }}>
                          {KPI_SECTION_LABELS[section]}
                        </span>
                        <span className="ml-auto text-[11px] text-ink-muted whitespace-nowrap">
                          {people.length} {people.length === 1 ? 'person' : 'people'}
                        </span>
                      </div>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {people.map((s) => {
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
                    </div>
                  );
                })
              )}
            </>
          )}

          {/* ── Level 3 — service advisor ── */}
          {saNode && (
            <>
              <div className="bg-white rounded-lg shadow-sm p-5 mb-4 flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-lg font-bold text-ink">{saNode.name}</div>
                  <div className="text-xs text-ink-muted mt-0.5">{branchNode?.name} · {saNode.roCount} RO{saNode.roCount !== 1 ? 's' : ''} this week</div>
                </div>
                <span className={`text-3xl font-black tabular-nums ${band(saNode.achievement).text}`}>{fmtPct(saNode.achievement)}</span>
              </div>
              <KpiSections cells={saNode.kpis} sections={saNode.sections} deltaFor={() => null} expandable />
            </>
          )}
        </>
      )}
    </>
  );
}
