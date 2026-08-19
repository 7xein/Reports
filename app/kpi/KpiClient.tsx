'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KpiTree, BranchNode, SaNode, KpiCell } from '@/lib/kpi';
import { KPI_DEFINITIONS, KpiWeekSummary } from '@/lib/types';

/*
 * Two colour languages, deliberately kept apart so they never fight:
 *   • WARM  (green → red)  = how well something is doing.
 *   • COOL  (per group)    = which part of the business it belongs to.
 * Every number on the page is a chip on the warm scale; every group keeps its
 * cool accent. That's what makes a screenful readable at a glance.
 */

const LOW_VOLUME = 5;      // fewer applicable records than this → dashed chip

type Band = { bg: string; fg: string; hex: string };

/** Solid five-step achievement scale. */
function band(pct: number | null): Band {
  if (pct === null) return { bg: '#eef0ed', fg: '#9aa39a', hex: '#b6bcb4' };
  if (pct >= 95) return { bg: '#2f6f12', fg: '#ffffff', hex: '#2f6f12' };
  if (pct >= 85) return { bg: '#78C41A', fg: '#12300a', hex: '#78C41A' };
  if (pct >= 70) return { bg: '#f5b301', fg: '#3d2a00', hex: '#f5b301' };
  if (pct >= 50) return { bg: '#f27a1a', fg: '#ffffff', hex: '#f27a1a' };
  return { bg: '#d92d20', fg: '#ffffff', hex: '#d92d20' };
}

/** Cool accent per KPI group — category identity, never performance. */
const GROUP_ACCENT: Record<string, string> = {
  'Delivery & invoicing': '#0ea5e9',
  'Quotations': '#8b5cf6',
  'Tagging': '#14b8a6',
  'Throughput & backlog': '#6366f1',
};
const accentOf = (g: string) => GROUP_ACCENT[g] ?? '#6b7280';

// Grouping comes from the shared definitions, so the page can't drift from them.
const GROUP_OF: Record<number, string> = Object.fromEntries(KPI_DEFINITIONS.map((d) => [d.id, d.group]));
const GROUP_ORDER: string[] = [...new Set(KPI_DEFINITIONS.map((d) => d.group as string))];

const fmtPct = (p: number | null) => (p === null ? '—' : `${Math.round(p)}%`);
const fmtPct1 = (p: number | null) => (p === null ? 'N/A' : `${p.toFixed(1)}%`);

/** Mean of the scored KPIs in a set — the same method the engine uses for achievement. */
function meanPct(cells: KpiCell[]): number | null {
  const scored = cells.filter((c) => c.pct !== null);
  if (!scored.length) return null;
  return scored.reduce((s, c) => s + (c.pct as number), 0) / scored.length;
}

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

/** Short column header for a person — branches keep their full name. */
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

// ── Small pieces ───────────────────────────────────────────────────
function Sparkline({ values, stroke = '#78C41A', w = 64, h = 18 }: {
  values: (number | null)[]; stroke?: string; w?: number; h?: number;
}) {
  const pts = values.filter((v): v is number => v !== null);
  if (pts.length < 2) {
    return <span className="inline-block text-[10px] text-ink-muted/60 text-center" style={{ width: w }}>—</span>;
  }
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const yFor = (v: number) => h - 2 - ((v - min) / span) * (h - 4);
  const coords: string[] = [];
  values.forEach((v, i) => { if (v !== null) coords.push(`${(i * step).toFixed(1)},${yFor(v).toFixed(1)}`); });
  const last = values[values.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <polyline points={coords.join(' ')} fill="none" stroke={stroke} strokeWidth={1.75}
        strokeLinecap="round" strokeLinejoin="round" />
      {last !== null && last !== undefined && <circle cx={w} cy={yFor(last)} r={2.2} fill={stroke} />}
    </svg>
  );
}

function Delta({ value, className = '', light = false }: { value: number | null; className?: string; light?: boolean }) {
  if (value === null || Math.abs(value) < 0.05) {
    return <span className={`text-[11px] tabular-nums ${light ? 'text-white/40' : 'text-ink-muted/70'} ${className}`}>—</span>;
  }
  const up = value > 0;
  const tone = up ? (light ? 'text-evs-green' : 'text-evs-green-dark') : (light ? 'text-red-300' : 'text-danger');
  return (
    <span className={`text-[11px] font-bold tabular-nums ${tone} ${className}`}>
      {up ? '▲' : '▼'}{Math.abs(value).toFixed(1)}
    </span>
  );
}

/** The atom of the whole page: one achievement value as a solid colour block. */
function Chip({ cell, strong = false, onClick }: { cell?: KpiCell | null; strong?: boolean; onClick?: () => void }) {
  const pct = cell?.pct ?? null;
  const b = band(pct);
  const low = !!cell && cell.applicable > 0 && cell.applicable < LOW_VOLUME;
  const title = cell
    ? `${cell.name} — ${fmtPct1(pct)} (${cell.compliant}/${cell.applicable})${low ? ' · low volume' : ''}`
    : 'Not measured';
  const cls = `w-full rounded-md text-center tabular-nums leading-none transition-transform
    ${strong ? 'text-[13px] font-black py-2' : 'text-[12px] font-bold py-1.5'}
    ${onClick ? 'cursor-pointer hover:scale-[1.06]' : ''}
    ${low ? 'border border-dashed border-white/70' : ''}`;
  const style = { background: b.bg, color: b.fg };

  return onClick
    ? <button type="button" onClick={onClick} title={title} className={cls} style={style}>{fmtPct(pct)}</button>
    : <div title={title} className={cls} style={style}>{fmtPct(pct)}</div>;
}

// ── The matrix ─────────────────────────────────────────────────────
type Column = {
  key: string;
  label: string;
  short: string;
  achievement: number | null;
  sub?: string;
  onClick?: () => void;
  cells: Record<number, KpiCell>;
};

/**
 * KPI rows × entity columns. This replaces the old stack of identical progress
 * bars: one screen shows every branch (or advisor) against every KPI, so a weak
 * column and a weak row both jump out without any drilling.
 */
function Matrix({ rows, columns, primaryLabel, primaryCells, sparkFor, deltaFor, onCell }: {
  rows: KpiCell[];
  columns: Column[];
  primaryLabel: string;
  primaryCells: Record<number, KpiCell>;
  sparkFor: (id: number) => (number | null)[];
  deltaFor: (id: number) => number | null;
  onCell?: (colKey: string) => void;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden mb-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse" style={{ minWidth: 250 + 84 * (columns.length + 1) }}>
          <thead>
            <tr className="bg-evs-dark text-white">
              <th className="sticky left-0 z-20 bg-evs-dark text-left px-4 py-3 w-[250px] min-w-[250px]">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/55">KPI</div>
              </th>
              <th className="px-2 py-3 w-[100px] min-w-[100px]">
                <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">8-week trend</div>
              </th>
              <th className="px-2 py-2 w-[84px] min-w-[84px] border-l border-white/15 align-bottom">
                <div className="text-[10px] font-bold uppercase tracking-wider text-white/80 pb-1.5 truncate" title={primaryLabel}>
                  {primaryLabel}
                </div>
              </th>
              {columns.map((c) => {
                const cb = band(c.achievement);
                const inner = (
                  <>
                    <div className="text-[11px] font-bold text-white/85 truncate">{c.short}</div>
                    <div className="mt-1 rounded text-[11px] font-black py-1 tabular-nums"
                      style={{ background: cb.bg, color: cb.fg }}>{fmtPct(c.achievement)}</div>
                    {c.sub && <div className="text-[9px] text-white/35 mt-0.5 truncate">{c.sub}</div>}
                  </>
                );
                return (
                  <th key={c.key} className="px-1.5 py-2 w-[84px] min-w-[84px]">
                    {c.onClick
                      ? <button type="button" onClick={c.onClick} title={`${c.label} — ${fmtPct1(c.achievement)}`}
                          className="w-full cursor-pointer hover:opacity-85 transition-opacity">{inner}</button>
                      : <div title={c.label}>{inner}</div>}
                  </th>
                );
              })}
            </tr>
          </thead>

          {GROUP_ORDER.map((group) => {
            const inGroup = rows.filter((r) => GROUP_OF[r.id] === group);
            if (!inGroup.length) return null;
            // Worst first inside the group; unmeasured KPIs sink to the bottom.
            const ordered = [...inGroup].sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));
            const accent = accentOf(group);

            return (
              <tbody key={group} id={`group-${group.replace(/\W+/g, '-')}`}>
                <tr>
                  <td colSpan={3 + columns.length} className="p-0">
                    {/* Band spans the table; the label itself stays pinned while scrolling sideways. */}
                    <div className="border-y border-border" style={{ background: `${accent}14` }}>
                      <div className="sticky left-0 flex items-center gap-2 px-4 py-1.5 w-[250px] min-w-[250px]">
                        <span className="w-1.5 h-3.5 rounded-full shrink-0" style={{ background: accent }} />
                        <span className="text-[11px] font-black uppercase tracking-[0.15em] truncate" style={{ color: accent }}>{group}</span>
                        <span className="text-[11px] font-bold tabular-nums ml-auto" style={{ color: accent }}>
                          {fmtPct1(meanPct(inGroup))}
                        </span>
                      </div>
                    </div>
                  </td>
                </tr>

                {ordered.map((r) => (
                  <tr key={r.id} className="group border-b border-border last:border-b-0 hover:bg-surface/70">
                    <td className="sticky left-0 z-10 bg-white group-hover:bg-surface px-4 py-1.5 w-[250px] min-w-[250px] border-r border-border transition-colors">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1 h-3 rounded-full shrink-0" style={{ background: accent }} />
                        <span className="text-[12.5px] font-semibold text-ink truncate" title={r.name}>{r.name}</span>
                        {r.note && (
                          <span className="text-ink-muted cursor-help text-[10px] shrink-0" title={r.note}>ⓘ</span>
                        )}
                        {r.snapshot && !r.note && (
                          <span className="text-ink-muted cursor-help text-[10px] shrink-0"
                            title="Point-in-time: reflects open ROs right now, not the selected week.">ⓘ</span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 w-[100px] min-w-[100px] whitespace-nowrap text-center">
                      <Sparkline values={sparkFor(r.id)} stroke={band(r.pct).hex} />
                      <Delta value={deltaFor(r.id)} className="ml-1" />
                    </td>
                    <td className="px-2 py-1.5 w-[84px] min-w-[84px] border-l border-border bg-surface/50">
                      <Chip cell={primaryCells[r.id]} strong />
                    </td>
                    {columns.map((c) => (
                      <td key={c.key} className="px-1.5 py-1.5 w-[84px] min-w-[84px]">
                        <Chip cell={c.cells[r.id]} onClick={onCell ? () => onCell(c.key) : undefined} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>

      <div className="flex items-center gap-3 flex-wrap px-4 py-2.5 bg-surface border-t border-border text-[10px] text-ink-muted">
        <span className="font-bold uppercase tracking-[0.15em]">Scale</span>
        {([['95–100', 95], ['85–94', 85], ['70–84', 70], ['50–69', 50], ['0–49', 0]] as const).map(([label, v]) => (
          <span key={label} className="flex items-center gap-1">
            <span className="w-3.5 h-3.5 rounded" style={{ background: band(v).bg }} />{label}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="w-3.5 h-3.5 rounded" style={{ background: band(null).bg }} />not measured
        </span>
        <span className="flex items-center gap-1 ml-auto">
          <span className="w-3.5 h-3.5 rounded border border-dashed border-ink-muted" />under {LOW_VOLUME} records
        </span>
      </div>
    </div>
  );
}

// ── Dark hero: one big number, its trend, and a score per group ────
function Hero({ eyebrow, title, pct, delta, spark, cells, meta, onGroup }: {
  eyebrow: string; title?: string; pct: number | null; delta: number | null;
  spark: (number | null)[]; cells: KpiCell[]; meta: string; onGroup: (g: string) => void;
}) {
  return (
    <div className="rounded-xl shadow-sm overflow-hidden mb-4"
      style={{ background: 'linear-gradient(135deg,#0d1f08 0%,#1c3f0e 55%,#0f2a09 100%)' }}>
      <div className="grid lg:grid-cols-[minmax(0,330px)_1fr]">
        <div className="p-5 lg:border-r border-white/10">
          <div className="text-[10px] uppercase tracking-[0.2em] text-white/45">{eyebrow}</div>
          {title && <div className="text-lg font-bold text-white mt-0.5 truncate">{title}</div>}
          <div className="flex items-end gap-3 mt-2 flex-wrap">
            <span className="text-[52px] font-black tabular-nums leading-none" style={{ color: band(pct).hex }}>
              {fmtPct1(pct)}
            </span>
            <span className="pb-1.5"><Delta value={delta} light /></span>
            <span className="ml-auto pb-1"><Sparkline values={spark} stroke="#ffffff" w={96} h={28} /></span>
          </div>
          <div className="text-white/40 text-[11px] mt-3">{meta}</div>
        </div>

        {/* Group scores — which part of the business is weak, not just which KPI. */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-px bg-white/10">
          {GROUP_ORDER.map((g) => {
            const inGroup = cells.filter((c) => GROUP_OF[c.id] === g);
            const score = meanPct(inGroup);
            const accent = accentOf(g);
            return (
              <button key={g} type="button" onClick={() => onGroup(g)}
                className="text-left p-4 cursor-pointer transition-colors hover:bg-white/[0.07] bg-white/[0.02]">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: accent }} />
                  <span className="text-[10px] font-bold uppercase tracking-wider truncate" style={{ color: accent }}>{g}</span>
                </div>
                <div className="text-2xl font-black tabular-nums mt-1.5" style={{ color: band(score).hex }}>
                  {fmtPct(score)}
                </div>
                <div className="text-[10px] text-white/35 mt-0.5">
                  {inGroup.filter((c) => c.pct !== null).length}/{inGroup.length} measured
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Advisor detail: chips plus the offending RO numbers ────────────
function SaDetail({ cells }: { cells: KpiCell[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-3 mb-4">
      {GROUP_ORDER.map((group) => {
        const inGroup = cells.filter((c) => GROUP_OF[c.id] === group);
        if (!inGroup.length) return null;
        const ordered = [...inGroup].sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));
        const accent = accentOf(group);
        return (
          <div key={group} id={`group-${group.replace(/\W+/g, '-')}`} className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2" style={{ background: `${accent}14` }}>
              <span className="w-1.5 h-3.5 rounded-full" style={{ background: accent }} />
              <span className="text-[11px] font-black uppercase tracking-[0.15em]" style={{ color: accent }}>{group}</span>
              <span className="text-[11px] font-bold tabular-nums ml-auto" style={{ color: accent }}>{fmtPct1(meanPct(inGroup))}</span>
            </div>
            {ordered.map((c) => (
              <div key={c.id} className="px-4 py-2.5 border-t border-border">
                <div className="flex items-center gap-3">
                  <span className="w-1 h-3 rounded-full shrink-0" style={{ background: accent }} />
                  <span className="text-[13px] font-semibold text-ink flex-1 min-w-0 truncate" title={c.name}>{c.name}</span>
                  {c.note && <span className="text-ink-muted cursor-help text-[10px]" title={c.note}>ⓘ</span>}
                  <span className="text-[11px] text-ink-muted tabular-nums">{c.compliant}/{c.applicable}</span>
                  <span className="w-[70px] shrink-0"><Chip cell={c} strong /></span>
                </div>
                {c.violations.length > 0 && (
                  <div className="mt-1.5 pl-4">
                    <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)}
                      className="text-[11px] font-semibold text-evs-green-dark hover:underline cursor-pointer">
                      {open === c.id ? 'Hide' : 'View'} {c.violations.length}{c.violations.length === 50 ? '+' : ''} miss{c.violations.length !== 1 ? 'es' : ''}
                    </button>
                    {open === c.id && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {c.violations.map((v) => (
                          <code key={v} className="text-[11px] bg-surface border border-border rounded px-1.5 py-0.5 text-ink-soft select-all">{v}</code>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
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

  // ── History-derived deltas + sparklines ──────────────────────────
  const history = tree?.history ?? [];
  const past = history.filter((h) => h.weekStart !== tree?.week.start);
  const prev = past.length ? past[past.length - 1] : null;

  const companySpark = [...past.map((h) => h.company.achievement), tree?.company.achievement ?? null];
  const companyDelta = prev && tree?.company.achievement != null && prev.company.achievement != null
    ? tree.company.achievement - prev.company.achievement : null;

  const branchSpark = (name: string) => [
    ...past.map((h) => h.branches?.[name]?.achievement ?? null),
    tree?.branches.find((b) => b.name === name)?.achievement ?? null,
  ];
  const branchDelta = (name: string) => {
    const now = tree?.branches.find((b) => b.name === name)?.achievement;
    const before = prev?.branches?.[name]?.achievement;
    return now != null && before != null ? now - before : null;
  };

  // KPI history is company-wide at level 1, branch-scoped once drilled in.
  const currentCells = (): KpiCell[] => (branch ? branchNode?.kpis : tree?.company.kpis) ?? [];
  const kpiSpark = (id: number) => [
    ...past.map((h) => (branch ? h.branches?.[branch]?.kpis?.[String(id)] : h.company.kpis?.[String(id)]) ?? null),
    currentCells().find((c) => c.id === id)?.pct ?? null,
  ];
  const kpiDelta = (id: number) => {
    const cur = currentCells().find((c) => c.id === id)?.pct;
    const before = branch ? prev?.branches?.[branch]?.kpis?.[String(id)] : prev?.company.kpis?.[String(id)];
    return cur != null && before != null ? cur - before : null;
  };

  const cellMap = (cells: KpiCell[]) => Object.fromEntries(cells.map((c) => [c.id, c])) as Record<number, KpiCell>;

  const jumpToGroup = (g: string) =>
    document.getElementById(`group-${g.replace(/\W+/g, '-')}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <>
      {/* Controls */}
      <div className="bg-white rounded-xl p-4 mb-4 shadow-sm flex flex-wrap items-center gap-3">
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
          <button onClick={() => { setBranch(null); setSa(null); }} className="text-evs-green-dark font-semibold hover:underline cursor-pointer">All branches</button>
          {branch && <><span className="text-ink-muted">/</span>
            <button onClick={() => setSa(null)} className={sa ? 'text-evs-green-dark font-semibold hover:underline cursor-pointer' : 'text-ink font-semibold'}>{branch}</button></>}
          {saNode && <><span className="text-ink-muted">/</span><span className="text-ink font-semibold">{saNode.name}</span></>}
        </div>
      )}

      {loading && <div className="bg-white rounded-xl p-8 text-center text-sm text-ink-muted shadow-sm">Loading live KPI data from Odoo…</div>}
      {error && !loading && (
        <div className="bg-white rounded-xl p-6 shadow-sm border-l-4 border-danger">
          <div className="font-bold text-danger mb-1">Could not load KPIs</div>
          <div className="text-sm text-ink-muted">{error}</div>
        </div>
      )}

      {tree && !loading && (
        <>
          {/* ── Level 1 — company × branches ── */}
          {!branchNode && (
            <>
              <Hero
                eyebrow="Company KPI achievement"
                pct={tree.company.achievement}
                delta={companyDelta}
                spark={companySpark}
                cells={tree.company.kpis}
                meta={`${fmtWeek(tree.week.start, tree.week.end)} · ${tree.branches.length} branches`}
                onGroup={jumpToGroup}
              />
              <Matrix
                rows={tree.company.kpis}
                primaryLabel="Company"
                primaryCells={cellMap(tree.company.kpis)}
                sparkFor={kpiSpark}
                deltaFor={kpiDelta}
                onCell={(key) => { setBranch(key); setSa(null); }}
                columns={[...tree.branches]
                  .sort((a, b) => (b.achievement ?? -1) - (a.achievement ?? -1))
                  .map((b) => ({
                    key: b.name,
                    label: b.name,
                    short: b.name,
                    achievement: b.achievement,
                    sub: `${b.applicableTotal} checks`,
                    onClick: () => { setBranch(b.name); setSa(null); },
                    cells: cellMap(b.kpis),
                  }))}
              />
            </>
          )}

          {/* ── Level 2 — branch × service advisors ── */}
          {branchNode && !saNode && (
            <>
              <Hero
                eyebrow="Branch KPI achievement"
                title={branchNode.name}
                pct={branchNode.achievement}
                delta={branchDelta(branchNode.name)}
                spark={branchSpark(branchNode.name)}
                cells={branchNode.kpis}
                meta={`${fmtWeek(tree.week.start, tree.week.end)} · ${branchNode.applicableTotal} checks · ${branchNode.serviceAdvisors.length} advisor${branchNode.serviceAdvisors.length !== 1 ? 's' : ''}`}
                onGroup={jumpToGroup}
              />
              <Matrix
                rows={branchNode.kpis}
                primaryLabel={branchNode.name}
                primaryCells={cellMap(branchNode.kpis)}
                sparkFor={kpiSpark}
                deltaFor={kpiDelta}
                onCell={(key) => setSa(Number(key))}
                columns={[...branchNode.serviceAdvisors]
                  .sort((a, b) => (b.achievement ?? -1) - (a.achievement ?? -1))
                  .map((s) => ({
                    key: String(s.odooUserId),
                    label: s.name,
                    short: initials(s.name),
                    achievement: s.achievement,
                    sub: `${s.roCount} RO${s.roCount !== 1 ? 's' : ''}`,
                    onClick: () => setSa(s.odooUserId),
                    cells: cellMap(s.kpis),
                  }))}
              />
              {branchNode.serviceAdvisors.length === 0 ? (
                <div className="bg-white rounded-xl p-5 text-sm text-ink-muted shadow-sm mb-4">
                  No service advisors on the roster for {branchNode.name}. Add them in <strong>Admin → KPI Configuration</strong>.
                </div>
              ) : (
                <div className="text-[11px] text-ink-muted mb-4 leading-relaxed">
                  <span className="font-semibold">Advisor columns, best to worst:</span>{' '}
                  {[...branchNode.serviceAdvisors]
                    .sort((a, b) => (b.achievement ?? -1) - (a.achievement ?? -1))
                    .map((s) => `${initials(s.name)} = ${s.name}`).join(' · ')}
                </div>
              )}
            </>
          )}

          {/* ── Level 3 — one service advisor ── */}
          {saNode && (
            <>
              <Hero
                eyebrow={`Service advisor · ${branchNode?.name ?? ''}`}
                title={saNode.name}
                pct={saNode.achievement}
                delta={null}
                spark={[]}
                cells={saNode.kpis}
                meta={`${fmtWeek(tree.week.start, tree.week.end)} · ${saNode.roCount} RO${saNode.roCount !== 1 ? 's' : ''} this week`}
                onGroup={jumpToGroup}
              />
              <SaDetail cells={saNode.kpis} />
            </>
          )}

          {tree.notes?.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm p-4 text-[11px] text-ink-muted space-y-1">
              {tree.notes.map((n, i) => <div key={i}>· {n}</div>)}
            </div>
          )}
        </>
      )}
    </>
  );
}
