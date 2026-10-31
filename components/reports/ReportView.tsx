'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_WINDOW_DAYS,
  REPORTS,
  WINDOW_OPTIONS,
  rowInScope,
  type ReportResult,
  type ReportSlug,
} from '@/lib/reports/types';
import { getSubBranches, subKey } from '@/lib/types';
import { BranchScopePicker } from '@/components/BranchScopePicker';
import { Spinner } from '@/components/Spinner';
import { BADGE_TONE, CHIP_ACTIVE_TONE, SEARCHABLE_KINDS, TILE_BORDER_TONE, VALUE_TONE, isEmpty } from './cells';
import { ReportTable } from './ReportTable';

const SCOPE_STORAGE_KEY = 'evhub.scope';
/** A cached report older than this is shown at once and re-read in the background. */
const STALE_MS = 10 * 60 * 1000;

/**
 * Reports already read this session, keyed `${slug}:${days | '-'}`. Module level,
 * so it survives client-side navigation between the EVHUB sub-tabs.
 */
const reportCache = new Map<string, ReportResult>();
/** Only one background prefetch chain runs at a time. */
let prefetching = false;

const cacheKey = (slug: string, windowed: boolean, days: number) => `${slug}:${windowed ? days : '-'}`;

function readStoredScope(): string {
  try {
    return window.localStorage.getItem(SCOPE_STORAGE_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

function writeStoredScope(scope: string) {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    /* storage unavailable — the choice just won't be remembered */
  }
}

async function errorMessage(res: Response): Promise<string> {
  let message = res.statusText || `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') message = body.error;
  } catch {
    /* not JSON */
  }
  return message;
}

async function fetchReport(slug: string, days: number | null, refresh: boolean): Promise<ReportResult> {
  const q = new URLSearchParams();
  if (days !== null) q.set('days', String(days));
  if (refresh) q.set('refresh', '1');
  const qs = q.toString();
  const res = await fetch(`/api/evhub/${slug}${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ReportResult;
}

/** After the visible report loads, read the other sub-tabs at their default window, one at a time. */
async function prefetchOthers(current: string) {
  if (prefetching) return;
  prefetching = true;
  try {
    for (const r of REPORTS) {
      if (r.slug === current) continue;
      const key = cacheKey(r.slug, r.windowed, DEFAULT_WINDOW_DAYS);
      if (reportCache.has(key)) continue;
      try {
        reportCache.set(key, await fetchReport(r.slug, r.windowed ? DEFAULT_WINDOW_DAYS : null, false));
      } catch {
        /* prefetch is best effort */
      }
    }
  } finally {
    prefetching = false;
  }
}

function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain filename */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

function isStale(r: ReportResult): boolean {
  const t = new Date(r.generatedAt).getTime();
  return Number.isNaN(t) || Date.now() - t > STALE_MS;
}

function gulfTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false });
}

const INDETERMINATE_CSS =
  '@keyframes evhub-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}';

export function ReportView({ slug, windowed }: { slug: ReportSlug; windowed: boolean }) {
  const [days, setDays] = useState<number>(DEFAULT_WINDOW_DAYS);
  const [scope, setScope] = useState('all');
  const [data, setData] = useState<ReportResult | null>(
    () => reportCache.get(cacheKey(slug, windowed, DEFAULT_WINDOW_DAYS)) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  /** A fetch for the visible report is in flight. */
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  /** Window button just clicked whose data has not arrived yet. */
  const [pendingDays, setPendingDays] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (opts: { refresh?: boolean; background?: boolean } = {}) => {
      const id = ++requestId.current;
      setLoading(true);
      setRefreshing(!!opts.refresh);
      setRevalidating(!!opts.background);
      if (!opts.background) setError(null);
      try {
        const json = await fetchReport(slug, windowed ? days : null, !!opts.refresh);
        reportCache.set(cacheKey(slug, windowed, days), json);
        if (id !== requestId.current) return;
        setData(json);
        setError(null);
        if (!opts.background) setChip(null);
        void prefetchOthers(slug);
      } catch (e) {
        if (id !== requestId.current) return;
        setError(e instanceof Error ? e.message : 'Could not load the report.');
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setRefreshing(false);
          setRevalidating(false);
          setPendingDays(null);
        }
      }
    },
    [slug, windowed, days],
  );

  // Restore the remembered scope; it is checked against the report below.
  useEffect(() => {
    setScope(readStoredScope());
  }, []);

  // Show a cached copy at once (re-reading it in the background when stale), else fetch.
  useEffect(() => {
    const cached = reportCache.get(cacheKey(slug, windowed, days));
    if (cached) {
      setData(cached);
      setError(null);
      if (isStale(cached)) {
        void load({ background: true });
      } else {
        requestId.current++; // drop any slower fetch still running for another window
        setLoading(false);
        setRefreshing(false);
        setRevalidating(false);
        setPendingDays(null);
        void prefetchOthers(slug);
      }
    } else {
      setData((d) => (d && d.slug === slug ? d : null));
      void load();
    }
  }, [slug, windowed, days, load]);

  // Every scope the picker can reach for this report; a remembered scope outside it reads as 'all'.
  const validScopes = useMemo(() => {
    const set = new Set<string>(['all']);
    for (const b of data?.branches ?? []) {
      set.add(b);
      for (const s of getSubBranches(b)) set.add(subKey(b, s));
    }
    return set;
  }, [data]);
  const activeScope = data?.branchScoped && validScopes.has(scope) ? scope : 'all';

  function onScopeChange(value: string) {
    setScope(value);
    setChip(null);
    writeStoredScope(value);
  }

  function onWindowChange(opt: number) {
    if (opt === days) return;
    setDays(opt);
    setPendingDays(reportCache.has(cacheKey(slug, windowed, opt)) ? null : opt);
  }

  async function exportXlsx() {
    setExporting(true);
    try {
      const q = new URLSearchParams();
      if (windowed) q.set('days', String(days));
      q.set('format', 'xlsx');
      q.set('scope', activeScope);
      const res = await fetch(`/api/evhub/${slug}?${q.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorMessage(res));
      const blob = await res.blob();
      const name = filenameFrom(res.headers.get('Content-Disposition')) ?? `EVHUB-${slug}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export the report.');
    } finally {
      setExporting(false);
    }
  }

  const columns = data?.columns ?? [];
  const badgeCol = columns.find((c) => c.kind === 'badge') ?? null;

  const scopedRows = useMemo(
    () => (data?.rows ?? []).filter((r) => rowInScope(r, activeScope)),
    [data, activeScope],
  );
  const tiles = data ? data.summaries?.[activeScope] ?? data.summary : [];

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scopedRows;
    const keys = columns.filter((c) => SEARCHABLE_KINDS.has(c.kind)).map((c) => c.key);
    return scopedRows.filter((row) =>
      keys.some((k) => {
        const v = row[k];
        return !isEmpty(v) && String(v).toLowerCase().includes(q);
      }),
    );
  }, [scopedRows, columns, search]);

  const chipCounts = useMemo(() => {
    if (!badgeCol) return [];
    const counts = new Map<string, number>();
    for (const row of searched) {
      const v = row[badgeCol.key];
      if (isEmpty(v)) continue;
      const label = String(v);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [searched, badgeCol]);

  const filtered = useMemo(() => {
    if (!badgeCol || chip === null) return searched;
    return searched.filter((row) => String(row[badgeCol.key] ?? '') === chip);
  }, [searched, badgeCol, chip]);

  const firstLoad = !data && !error;
  const resetKey = `${data?.generatedAt ?? ''}|${activeScope}|${search}|${chip ?? ''}`;

  return (
    <div className="space-y-4">
      <style>{INDETERMINATE_CSS}</style>

      {data?.branchScoped && (
        <BranchScopePicker branches={data.branches} scope={activeScope} onChange={onScopeChange} className="" />
      )}

      {/* Toolbar */}
      <div
        className="relative overflow-hidden bg-white rounded-lg shadow-sm p-4 flex flex-wrap items-center gap-3"
        aria-busy={loading}
      >
        {loading && (
          <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden" aria-hidden="true">
            <div
              className="h-full w-1/3 bg-evs-green"
              style={{ animation: 'evhub-indeterminate 1.2s ease-in-out infinite' }}
            />
          </div>
        )}

        {windowed && (
          <div className="flex gap-1" role="group" aria-label="Lookback window">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => onWindowChange(opt)}
                aria-pressed={days === opt}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                  days === opt ? 'bg-evs-green text-white' : 'bg-surface text-ink-soft hover:bg-evs-green/10'
                }`}
              >
                {pendingDays === opt && <Spinner />}
                {opt} days
              </button>
            ))}
          </div>
        )}

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          aria-label="Search rows"
          className="w-56 text-sm border border-border rounded-md px-3 py-1.5"
        />

        <div className="ml-auto flex items-center gap-3">
          {data && <span className="text-xs text-ink-muted">Updated {gulfTime(data.generatedAt)}</span>}
          {revalidating && (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted" role="status">
              <Spinner />
              Updating…
            </span>
          )}
          <button
            type="button"
            onClick={() => void load({ refresh: true })}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold border border-border bg-white text-ink-soft hover:bg-surface disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {refreshing && <Spinner />}
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => void exportXlsx()}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold bg-evs-green text-white hover:bg-evs-green-dark disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {exporting && <Spinner />}
            {exporting ? 'Preparing…' : 'Export to Excel'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-white rounded-lg shadow-sm p-5 flex flex-wrap items-center gap-3">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md px-3 py-1.5 text-sm font-semibold border border-border bg-white text-ink-soft hover:bg-surface"
          >
            Try again
          </button>
        </div>
      )}

      {firstLoad && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[76px] rounded-lg bg-white shadow-sm animate-pulse" />
            ))}
          </div>
          <div className="bg-white rounded-lg shadow-sm p-8 text-center text-sm text-ink-muted">
            Reading Odoo… this report can take up to a minute.
          </div>
        </>
      )}

      {data && (
        <>
          {tiles.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {tiles.map((item) => {
                const tone = item.tone ?? 'neutral';
                return (
                  <div key={item.label} className={`bg-white rounded-lg p-3 shadow-sm border-t-2 ${TILE_BORDER_TONE[tone]}`}>
                    <div className={`text-2xl font-black tabular-nums leading-none ${VALUE_TONE[tone]}`}>{item.value}</div>
                    <div className="text-xs mt-1.5 leading-tight text-ink-muted">{item.label}</div>
                    {item.hint && <div className="text-xs mt-1 text-ink-muted">{item.hint}</div>}
                  </div>
                );
              })}
            </div>
          )}

          {badgeCol && chipCounts.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label={`Filter by ${badgeCol.label}`}>
              <button
                type="button"
                onClick={() => setChip(null)}
                aria-pressed={chip === null}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  chip === null ? 'bg-evs-green text-white' : BADGE_TONE.neutral
                }`}
              >
                All ({searched.length})
              </button>
              {chipCounts.map(([label, count]) => {
                const tone = data.badgeTones?.[badgeCol.key]?.[label] ?? 'neutral';
                const active = chip === label;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setChip(active ? null : label)}
                    aria-pressed={active}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      active ? CHIP_ACTIVE_TONE[tone] : BADGE_TONE[tone]
                    }`}
                  >
                    {label} ({count})
                  </button>
                );
              })}
            </div>
          )}

          <ReportTable
            columns={columns}
            rows={filtered}
            totalRows={scopedRows.length}
            badgeTones={data.badgeTones}
            dimmed={loading}
            resetKey={resetKey}
          />

          {(data.description || data.notes.length > 0) && (
            <div className="bg-white rounded-lg shadow-sm p-5">
              <h2 className="text-sm font-semibold text-ink">About this report</h2>
              {data.description && <p className="mt-1 text-sm text-ink-soft">{data.description}</p>}
              {data.notes.length > 0 && (
                <ul className="mt-3 space-y-1 list-disc pl-5 text-sm text-ink-soft">
                  {data.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
