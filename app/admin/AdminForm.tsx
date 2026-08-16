'use client';

import { Fragment, useState } from 'react';
import { Shell } from '@/components/Shell';
import {
  BRANCHES, WIP_METRICS, WipMetricKey, ReportData, RegionalSalesEntry,
  getSubBranches, hasSubBranches, subKey, WipSubValues,
} from '@/lib/types';
import { getWeekStart } from '@/lib/sales-utils';
import { formatNumber } from '@/lib/format';
import { KpiConfigCard } from './KpiConfigCard';

const BRANCH_COLORS: Record<string, string> = {
  Dubai:       '#78C41A',
  Ajman:       '#3B82F6',
  Sharjah:     '#F59E0B',
  'Abu Dhabi': '#8B5CF6',
  'Al Ain':    '#EF4444',
  Qatar:       '#06B6D4',
};

/** Enumerate editable input locations: branch name (single) or `${branch}__${sub}`. */
function wipLocationKeys(): string[] {
  const keys: string[] = [];
  for (const b of BRANCHES) {
    const subs = getSubBranches(b);
    if (subs.length) subs.forEach((s) => keys.push(subKey(b, s)));
    else keys.push(b);
  }
  return keys;
}

/** Live branch total for a metric = sum of its sub-inputs, or the single input. */
function branchTotalOf(
  values: Record<WipMetricKey, Record<string, number>>,
  metric: WipMetricKey,
  branch: string,
): number {
  const subs = getSubBranches(branch);
  if (subs.length) return subs.reduce((s, sub) => s + (values[metric]?.[subKey(branch, sub)] ?? 0), 0);
  return values[metric]?.[branch] ?? 0;
}

/** Build the { values, subValues } save payload from per-location inputs. */
function buildWipPayload(values: Record<WipMetricKey, Record<string, number>>) {
  const outValues = {} as Record<WipMetricKey, Record<string, number>>;
  const outSub = {} as WipSubValues;
  for (const m of WIP_METRICS) {
    outValues[m.key] = {};
    outSub[m.key] = {};
    for (const b of BRANCHES) {
      outValues[m.key][b] = branchTotalOf(values, m.key, b);
      if (hasSubBranches(b)) {
        for (const sub of getSubBranches(b)) {
          outSub[m.key][subKey(b, sub)] = values[m.key]?.[subKey(b, sub)] ?? 0;
        }
      }
    }
  }
  return { values: outValues, subValues: outSub };
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function weekStartOf(weekEnding: string) {
  const d = new Date(weekEnding + 'T00:00:00');
  d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function lastThursday() {
  const d = new Date();
  const day = d.getDay();
  const diff = (day + 3) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

const ADMIN_SUB_TABS = [
  { href: '/admin', label: 'Update Data' },
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function emptyWipValues(): Record<WipMetricKey, Record<string, number>> {
  const locs = wipLocationKeys();
  return Object.fromEntries(
    WIP_METRICS.map((m) => [m.key, Object.fromEntries(locs.map((k) => [k, 0]))])
  ) as Record<WipMetricKey, Record<string, number>>;
}

const inputCls = (highlighted: boolean) =>
  `w-full px-3 py-1.5 border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-sm ${
    highlighted ? 'border-evs-green/40 bg-evs-green/5' : 'border-border'
  }`;

/**
 * Transposed WIP entry table — rows are locations (branch / sub-branch),
 * columns are the 7 metric short-labels. Multi-site branches show a bold
 * header row that auto-sums its sub-branch inputs live, then one input row
 * per sub-branch. Single-location branches are a single input row.
 */
function WipEntryTable({
  values,
  setVal,
  highlight,
}: {
  values: Record<WipMetricKey, Record<string, number>>;
  setVal: (metric: WipMetricKey, locKey: string, val: string) => void;
  highlight: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2.5 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-xs min-w-[190px]">
              Branch / Site
            </th>
            {WIP_METRICS.map((m) => (
              <th key={m.key} className="text-right py-2.5 px-2 font-semibold uppercase tracking-wide text-ink-muted text-xs min-w-[92px]">
                {m.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BRANCHES.map((b) => {
            const subs = getSubBranches(b);
            const color = BRANCH_COLORS[b] ?? '#78C41A';

            // Single-location branch → one input row
            if (!subs.length) {
              return (
                <tr key={b} className="border-b border-border">
                  <td className="py-2.5 pr-4 font-semibold text-ink whitespace-nowrap">
                    <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: color }} />
                    {b}
                  </td>
                  {WIP_METRICS.map((m) => {
                    const v = values[m.key]?.[b] ?? 0;
                    return (
                      <td key={m.key} className="py-1.5 px-1.5">
                        <input
                          type="number" min="0"
                          value={v || ''}
                          onChange={(e) => setVal(m.key, b, e.target.value)}
                          className={inputCls(highlight && v > 0)}
                          placeholder="0"
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            }

            // Multi-site branch → bold auto-sum header + one input row per sub-branch
            return (
              <Fragment key={b}>
                <tr className="border-b border-border bg-surface/70">
                  <td className="py-2.5 pr-4 font-bold text-ink whitespace-nowrap">
                    <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: color }} />
                    {b}
                    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted border border-border rounded-full px-2 py-0.5">
                      {subs.length} sites
                    </span>
                  </td>
                  {WIP_METRICS.map((m) => (
                    <td key={m.key} className="py-2.5 px-2 text-right tabular-nums font-bold text-ink">
                      {formatNumber(branchTotalOf(values, m.key, b))}
                    </td>
                  ))}
                </tr>
                {subs.map((s) => {
                  const key = subKey(b, s);
                  return (
                    <tr key={s} className="border-b border-border">
                      <td className="py-1.5 pr-4 pl-7 text-ink-soft whitespace-nowrap">↳ {s}</td>
                      {WIP_METRICS.map((m) => {
                        const v = values[m.key]?.[key] ?? 0;
                        return (
                          <td key={m.key} className="py-1.5 px-1.5">
                            <input
                              type="number" min="0"
                              value={v || ''}
                              onChange={(e) => setVal(m.key, key, e.target.value)}
                              className={inputCls(highlight && v > 0)}
                              placeholder="0"
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AdminForm({ initialData }: { initialData: ReportData }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // ── Odoo Excel export state
  const [exportDate, setExportDate] = useState(yesterday());
  const [exporting, setExporting] = useState<'wip' | 'wip-todate' | 'received' | null>(null);

  // ── Odoo WIP sync state
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // ── Odoo Weekly WIP sync state
  const [syncingWeekly, setSyncingWeekly] = useState(false);
  const [syncWeeklyStatus, setSyncWeeklyStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // ── Odoo Sales sync state
  const [syncingSales, setSyncingSales] = useState(false);
  const [syncSalesStatus, setSyncSalesStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // ── WIP Daily state
  const [wipDate, setWipDate] = useState(today());
  const [wipValues, setWipValues] = useState<Record<WipMetricKey, Record<string, number>>>(emptyWipValues());

  // ── WIP Weekly state
  const [wipWeekEnding, setWipWeekEnding] = useState(lastThursday());
  const [wipWeeklyValues, setWipWeeklyValues] = useState<Record<WipMetricKey, Record<string, number>>>(emptyWipValues());

  const [salesLog, setSalesLog] = useState<RegionalSalesEntry[]>(initialData.regional.salesLog);
  const [newDate, setNewDate] = useState(today());
  const [newEntries, setNewEntries] = useState<Record<string, { total: string; withoutW: string; notes: string }>>(
    Object.fromEntries(BRANCHES.map((b) => [b, { total: '', withoutW: '', notes: '' }]))
  );

  function setWip(metric: WipMetricKey, branch: string, val: string) {
    setWipValues((prev) => ({
      ...prev,
      [metric]: { ...prev[metric], [branch]: parseFloat(val) || 0 },
    }));
  }

  function setWipWeekly(metric: WipMetricKey, branch: string, val: string) {
    setWipWeeklyValues((prev) => ({
      ...prev,
      [metric]: { ...prev[metric], [branch]: parseFloat(val) || 0 },
    }));
  }

  async function apiPost(type: string, payload: unknown): Promise<string | null> {
    const res = await fetch('/api/data', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body?.detail ? ` — ${body.detail}` : '';
      const kvStatus = body?.usingKV !== undefined ? ` (KV: ${body.usingKV ? 'yes' : 'NO'})` : '';
      return `Error ${res.status}: ${body?.error ?? res.statusText}${detail}${kvStatus}`;
    }
    return null;
  }

  // ── Odoo sync handler ─────────────────────────────────────────
  async function syncFromOdoo() {
    setSyncing(true);
    setSyncStatus('idle');
    setMessage('');

    try {
      const res = await fetch('/api/sync-odoo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: wipDate, autoSave: false }), // preview mode
      });

      const data = await res.json();

      if (!res.ok) {
        const detail = data?.detail || data?.error || 'Unknown error';
        setMessage(`Odoo sync failed: ${detail}`);
        setSyncStatus('error');
        setSyncing(false);
        return;
      }

      // Populate the form fields with Odoo data (keep the user-selected date).
      // Multi-site branches fill from per-sub-branch values; single-location
      // branches fill from the branch total.
      if (data.values) {
        if (data.date) setWipDate(data.date);
        setWipValues((prev) => {
          const next: Record<WipMetricKey, Record<string, number>> = JSON.parse(JSON.stringify(prev));
          for (const m of WIP_METRICS) {
            for (const b of BRANCHES) {
              if (hasSubBranches(b)) {
                for (const sub of getSubBranches(b)) {
                  const k = subKey(b, sub);
                  next[m.key][k] = data.subValues?.[m.key]?.[k] ?? 0;
                }
              } else {
                next[m.key][b] = data.values[m.key]?.[b] ?? 0;
              }
            }
          }
          return next;
        });
      }

      setSyncStatus('success');
      setMessage(`✓ Odoo data loaded for ${data.date} — review the numbers below, then click Save`);
    } catch (err) {
      setMessage(`Odoo sync failed: ${err instanceof Error ? err.message : String(err)}`);
      setSyncStatus('error');
    } finally {
      setSyncing(false);
    }
  }

  async function syncWeeklyFromOdoo() {
    setSyncingWeekly(true);
    setSyncWeeklyStatus('idle');
    setMessage('');

    try {
      const endDate = wipWeekEnding;
      const startDate = addDays(endDate, -7);

      const res = await fetch('/api/sync-odoo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'weekly', startDate, endDate, autoSave: false }),
      });

      const data = await res.json();

      if (!res.ok) {
        const detail = data?.detail || data?.error || 'Unknown error';
        setMessage(`Weekly sync failed: ${detail}`);
        setSyncWeeklyStatus('error');
        setSyncingWeekly(false);
        return;
      }

      if (data.values) {
        setWipWeeklyValues((prev) => {
          const next: Record<WipMetricKey, Record<string, number>> = JSON.parse(JSON.stringify(prev));
          for (const m of WIP_METRICS) {
            for (const b of BRANCHES) {
              if (hasSubBranches(b)) {
                for (const sub of getSubBranches(b)) {
                  const k = subKey(b, sub);
                  next[m.key][k] = data.subValues?.[m.key]?.[k] ?? 0;
                }
              } else {
                next[m.key][b] = data.values[m.key]?.[b] ?? 0;
              }
            }
          }
          return next;
        });
      }

      setSyncWeeklyStatus('success');
      setMessage(`✓ Weekly WIP data loaded for ${startDate} → ${endDate} — review the numbers below, then click Save`);
    } catch (err) {
      setMessage(`Weekly sync failed: ${err instanceof Error ? err.message : String(err)}`);
      setSyncWeeklyStatus('error');
    } finally {
      setSyncingWeekly(false);
    }
  }

  async function syncSalesFromOdoo() {
    setSyncingSales(true);
    setSyncSalesStatus('idle');
    setMessage('');

    try {
      const res = await fetch('/api/sync-odoo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'sales', date: newDate, autoSave: false }),
      });

      const data = await res.json();

      if (!res.ok) {
        const detail = data?.detail || data?.error || 'Unknown error';
        setMessage(`Sales sync failed: ${detail}`);
        setSyncSalesStatus('error');
        setSyncingSales(false);
        return;
      }

      // Odoo returns total sales and the without-warranty subset. Fill both inputs.
      if (data.salesTotal || data.salesWithout) {
        const updated: Record<string, { total: string; withoutW: string; notes: string }> = {};
        for (const branch of BRANCHES) {
          const totalAmt   = data.salesTotal?.[branch] ?? 0;
          const withoutAmt = data.salesWithout?.[branch] ?? 0;
          updated[branch] = {
            total: totalAmt > 0 ? totalAmt.toFixed(2) : '',
            withoutW: withoutAmt > 0 ? withoutAmt.toFixed(2) : '',
            notes: newEntries[branch]?.notes || '',
          };
        }
        setNewEntries(updated);
        if (data.date) setNewDate(data.date);
      }

      setSyncSalesStatus('success');
      setMessage(`✓ Sales data loaded for ${data.date} — total and without-warranty from Odoo. Review, then Save`);
    } catch (err) {
      setMessage(`Sales sync failed: ${err instanceof Error ? err.message : String(err)}`);
      setSyncSalesStatus('error');
    } finally {
      setSyncingSales(false);
    }
  }

  async function saveWip() {
    setSaving(true);
    setMessage('');
    const { values, subValues } = buildWipPayload(wipValues);
    const err = await apiPost('wip-daily', { date: wipDate, values, subValues });
    if (err) { setMessage(err); setSaving(false); return; }
    const total = (initialData.wipHistory?.length ?? 0) + 1;
    setMessage(`✓ WIP snapshot saved for ${wipDate} (${total} total data points)`);
    setSyncStatus('idle');
    setSaving(false);
  }

  async function saveWipWeekly() {
    setSaving(true);
    setMessage('');
    const { values, subValues } = buildWipPayload(wipWeeklyValues);
    const err = await apiPost('wip-weekly', { weekEnding: wipWeekEnding, values, subValues });
    if (err) { setMessage(err); setSaving(false); return; }
    setMessage(`✓ Weekly WIP snapshot saved for week ending ${wipWeekEnding}`);
    setSyncWeeklyStatus('idle');
    setSaving(false);
  }

  async function saveSales() {
    setSaving(true);
    setMessage('');
    const newRows: RegionalSalesEntry[] = BRANCHES
      .map((b) => {
        const total    = parseFloat(newEntries[b]?.total || '0') || 0;
        const withoutW = parseFloat(newEntries[b]?.withoutW || '0') || 0;
        return {
          date: newDate,
          branch: b,
          actualSales: total,
          salesWithoutWarranty: Math.min(withoutW, total),
          notes: newEntries[b]?.notes || '',
        };
      })
      .filter((r) => r.actualSales > 0);
    const updated = [
      ...salesLog.filter((e) => !(e.date === newDate && newRows.some((r) => r.branch === e.branch))),
      ...newRows,
    ];
    const err = await apiPost('regional-log', updated);
    if (err) { setMessage(err); setSaving(false); return; }
    setSalesLog(updated);
    setMessage(`✓ Sales entries saved for ${newDate}`);
    setSaving(false);
  }

  async function handleLogout() {
    await fetch('/api/auth', { method: 'DELETE' }).catch(() => {});
    window.location.href = '/login';
  }

  async function exportFromOdoo(type: 'wip' | 'wip-todate' | 'received') {
    setExporting(type);
    setMessage('');
    const fallbackName =
      type === 'received'   ? `Received_JCs_${exportDate}.xlsx` :
      type === 'wip-todate' ? `WIP_SinceApr01_${exportDate}.xlsx` :
                              `WIP_Export_${exportDate}.xlsx`;
    const okLabel =
      type === 'received'   ? 'Received JCs' :
      type === 'wip-todate' ? 'WIP since Apr 1' : "Day's WIP";
    try {
      const res = await fetch('/api/export-odoo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, date: exportDate }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMessage(`Export failed: ${body?.detail || body?.error || res.statusText}`);
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      const cd = res.headers.get('Content-Disposition') || '';
      const fn = cd.match(/filename="(.+?)"/);
      a.href = url;
      a.download = fn ? fn[1] : fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setMessage(`✓ ${okLabel} Excel exported for ${exportDate}`);
    } catch (err) {
      setMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(null);
    }
  }

  return (
    <Shell
      breadcrumbSection="Admin"
      breadcrumbPage="Update Data"
      subTabs={ADMIN_SUB_TABS}
      hero={{
        eyebrow: 'Admin Panel',
        title: 'Update',
        titleEm: 'Data',
        sub: "Enter today's WIP snapshot and sales figures",
      }}
    >
      {/* WIP Daily Section */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-5">
        <div className="flex items-start justify-between mb-5 gap-4">
          <div>
            <h2 className="text-base font-bold uppercase tracking-wide text-ink">WIP Snapshot — Today&apos;s Numbers</h2>
            <p className="text-sm text-ink-muted mt-1">Branches with multiple sites are entered <strong>per sub-branch</strong> — each branch row auto-sums its sites for every metric.</p>
          </div>
          <div className="flex items-center gap-3">
            {/* ── Odoo Sync Button ── */}
            <button
              onClick={syncFromOdoo}
              disabled={syncing || saving}
              className={`
                inline-flex items-center gap-2 px-4 py-1.5 text-sm font-semibold rounded-md
                border-2 transition-all duration-200
                ${syncing
                  ? 'border-amber-400 bg-amber-50 text-amber-700 cursor-wait'
                  : syncStatus === 'success'
                    ? 'border-evs-green bg-evs-green/5 text-evs-green-dark'
                    : syncStatus === 'error'
                      ? 'border-danger/50 bg-danger/5 text-danger'
                      : 'border-ink/20 bg-white text-ink hover:border-evs-green hover:text-evs-green-dark'
                }
                disabled:opacity-50
              `}
            >
              {syncing ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Syncing from Odoo…
                </>
              ) : syncStatus === 'success' ? (
                <>
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Synced — Review Below
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4 10a6 6 0 0110.472-4M16 10a6 6 0 01-10.472 4" strokeLinecap="round" />
                    <path d="M15 3v4h-4M5 17v-4h4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Sync from Odoo
                </>
              )}
            </button>

            <div className="w-px h-6 bg-border" />

            <label className="text-sm text-ink-muted">Date:</label>
            <input
              type="date"
              value={wipDate}
              onChange={(e) => { setWipDate(e.target.value); setSyncStatus('idle'); }}
              className="text-sm border border-border rounded px-3 py-1.5 text-ink"
            />
          </div>
        </div>

        {/* Sync status banner */}
        {syncStatus === 'success' && (
          <div className="mb-4 px-4 py-2.5 bg-evs-green/5 border border-evs-green/20 rounded-md flex items-center gap-2">
            <svg className="h-4 w-4 text-evs-green shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <span className="text-sm text-evs-green-dark">
              Data pulled from Odoo — review the numbers below and click <strong>Save WIP Snapshot</strong> when ready.
              You can edit any cell before saving.
            </span>
          </div>
        )}

        <WipEntryTable values={wipValues} setVal={setWip} highlight={syncStatus === 'success'} />
        <div className="mt-5 flex items-center gap-4">
          <button onClick={saveWip} disabled={saving}
            className="px-6 py-2.5 bg-evs-green text-white text-sm font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : 'Save WIP Snapshot →'}
          </button>
          <span className="text-sm text-ink-muted">Each save appends to the Daily Trends chart</span>
        </div>
      </div>

      {/* WIP Weekly Section */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-5">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-bold uppercase tracking-wide text-ink">WIP Weekly Snapshot — This Week's Counts</h2>
            <p className="text-sm text-ink-muted mt-1">Enter the number of each item that occurred <strong>this week only</strong> — not cumulative since July.</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-3">
              {/* ── Odoo Weekly Sync Button ── */}
              <button
                onClick={syncWeeklyFromOdoo}
                disabled={syncingWeekly || saving}
                className={`
                  inline-flex items-center gap-2 px-4 py-1.5 text-sm font-semibold rounded-md
                  border-2 transition-all duration-200
                  ${syncingWeekly
                    ? 'border-amber-400 bg-amber-50 text-amber-700 cursor-wait'
                    : syncWeeklyStatus === 'success'
                      ? 'border-evs-green bg-evs-green/5 text-evs-green-dark'
                      : syncWeeklyStatus === 'error'
                        ? 'border-danger/50 bg-danger/5 text-danger'
                        : 'border-ink/20 bg-white text-ink hover:border-evs-green hover:text-evs-green-dark'
                  }
                  disabled:opacity-50
                `}
              >
                {syncingWeekly ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Syncing from Odoo…
                  </>
                ) : syncWeeklyStatus === 'success' ? (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Synced — Review Below
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 10a6 6 0 0110.472-4M16 10a6 6 0 01-10.472 4" strokeLinecap="round" />
                      <path d="M15 3v4h-4M5 17v-4h4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Sync from Odoo
                  </>
                )}
              </button>

              <div className="w-px h-6 bg-border" />

              <label className="text-sm text-ink-muted">Week ending (Thursday):</label>
              <input type="date" value={wipWeekEnding}
                onChange={(e) => { setWipWeekEnding(e.target.value); setSyncWeeklyStatus('idle'); }}
                className="text-sm border border-border rounded px-3 py-1.5 text-ink" />
            </div>
            <span className="text-xs text-ink-muted">
              Covers: <strong>{fmtDate(weekStartOf(wipWeekEnding))}</strong> – <strong>{fmtDate(wipWeekEnding)}</strong>
            </span>
          </div>
        </div>

        {/* Weekly sync status banner */}
        {syncWeeklyStatus === 'success' && (
          <div className="mb-4 px-4 py-2.5 bg-evs-green/5 border border-evs-green/20 rounded-md flex items-center gap-2">
            <svg className="h-4 w-4 text-evs-green shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <span className="text-sm text-evs-green-dark">
              Data pulled from Odoo — review the numbers below and click <strong>Save Weekly Snapshot</strong> when ready.
              You can edit any cell before saving.
            </span>
          </div>
        )}

        <WipEntryTable values={wipWeeklyValues} setVal={setWipWeekly} highlight={syncWeeklyStatus === 'success'} />
        <div className="mt-5 flex items-center gap-4">
          <button onClick={saveWipWeekly} disabled={saving}
            className="px-6 py-2.5 bg-evs-green text-white text-sm font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Weekly Snapshot →'}
          </button>
          <span className="text-sm text-ink-muted">Enter every Thursday — shows on the Weekly Snapshot dashboard</span>
        </div>
      </div>

      {/* Sales Section */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-bold uppercase tracking-wide text-ink">Sales Log — Add Today's Sales</h2>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-3">
              {/* ── Odoo Sales Sync Button ── */}
              <button
                onClick={syncSalesFromOdoo}
                disabled={syncingSales || saving}
                className={`
                  inline-flex items-center gap-2 px-4 py-1.5 text-sm font-semibold rounded-md
                  border-2 transition-all duration-200
                  ${syncingSales
                    ? 'border-amber-400 bg-amber-50 text-amber-700 cursor-wait'
                    : syncSalesStatus === 'success'
                      ? 'border-evs-green bg-evs-green/5 text-evs-green-dark'
                      : syncSalesStatus === 'error'
                        ? 'border-danger/50 bg-danger/5 text-danger'
                        : 'border-ink/20 bg-white text-ink hover:border-evs-green hover:text-evs-green-dark'
                  }
                  disabled:opacity-50
                `}
              >
                {syncingSales ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Syncing Sales…
                  </>
                ) : syncSalesStatus === 'success' ? (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Synced — Review Below
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 10a6 6 0 0110.472-4M16 10a6 6 0 01-10.472 4" strokeLinecap="round" />
                      <path d="M15 3v4h-4M5 17v-4h4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Sync from Odoo
                  </>
                )}
              </button>

              <div className="w-px h-6 bg-border" />

              <label className="text-sm text-ink-muted">Date:</label>
              <input type="date" value={newDate} onChange={(e) => { setNewDate(e.target.value); setSyncSalesStatus('idle'); }}
                className="text-sm border border-border rounded px-3 py-1.5 text-ink" />
            </div>
            {initialData.regional.weekStart && (
              <span className="text-xs text-ink-muted">
                Week: <strong>{fmtDate(getWeekStart(newDate, initialData.regional.weekStart))}</strong> – <strong>{fmtDate(addDays(getWeekStart(newDate, initialData.regional.weekStart), 6))}</strong>
              </span>
            )}
          </div>
        </div>
        <p className="text-sm text-ink-muted mb-4 -mt-2">Enter <strong>total sales</strong> and <strong>sales without warranty</strong> per branch.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2.5 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-xs">Branch</th>
                <th className="text-right py-2.5 px-2 font-semibold uppercase tracking-wide text-ink-muted text-xs">Total Sales (AED)</th>
                <th className="text-right py-2.5 px-2 font-semibold uppercase tracking-wide text-ink-muted text-xs">Without Warranty (AED)</th>
                <th className="text-left py-2.5 px-2 font-semibold uppercase tracking-wide text-ink-muted text-xs">Notes</th>
              </tr>
            </thead>
            <tbody>
              {BRANCHES.map((b, idx) => {
                const total    = parseFloat(newEntries[b]?.total || '0') || 0;
                const withoutW = parseFloat(newEntries[b]?.withoutW || '0') || 0;
                const synced   = syncSalesStatus === 'success';
                return (
                  <tr key={b} className={`border-b border-border ${idx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                    <td className="py-2.5 pr-4 font-semibold text-ink">{b}</td>
                    <td className="py-1.5 px-1.5">
                      <input type="number" min="0" value={newEntries[b]?.total ?? ''}
                        onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], total: e.target.value } }))}
                        className={`w-full px-3 py-1.5 border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-sm ${
                          synced && total > 0 ? 'border-evs-green/40 bg-evs-green/5' : 'border-border'
                        }`}
                        placeholder="0" />
                    </td>
                    <td className="py-1.5 px-1.5">
                      <input type="number" min="0" value={newEntries[b]?.withoutW ?? ''}
                        onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], withoutW: e.target.value } }))}
                        className={`w-full px-3 py-1.5 border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-sm ${
                          synced && withoutW > 0 ? 'border-evs-green/40 bg-evs-green/5' : 'border-border'
                        }`}
                        placeholder="0" />
                    </td>
                    <td className="py-1.5 px-1.5">
                      <input type="text" value={newEntries[b]?.notes ?? ''}
                        onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], notes: e.target.value } }))}
                        className="w-full px-3 py-1.5 border border-border rounded text-ink focus:border-evs-green focus:outline-none text-sm"
                        placeholder="Optional notes" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-5 flex items-center justify-between">
          <button onClick={saveSales} disabled={saving}
            className="px-6 py-2.5 bg-evs-green text-white text-sm font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Sales Entry →'}
          </button>
          <button onClick={handleLogout} className="text-sm text-ink-muted hover:text-ink">Sign out</button>
        </div>
      </div>

      {/* Odoo Exports Section */}
      <div className="bg-white rounded-lg shadow-sm p-6 mt-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-bold uppercase tracking-wide text-ink">Odoo Exports</h2>
          <div className="flex items-center gap-2">
            <label className="text-sm text-ink-muted">Date:</label>
            <input
              type="date"
              value={exportDate}
              onChange={(e) => setExportDate(e.target.value)}
              className="text-sm border border-border rounded px-3 py-1.5 text-ink"
            />
          </div>
        </div>
        <p className="text-sm text-ink-muted mb-5">Downloads an Excel file with one tab per branch, pulled live from Odoo for the selected day.</p>
        <div className="flex flex-wrap items-center gap-3">
          {([
            { type: 'wip' as const, label: "Export Day's WIP", hint: 'Open ROs (priority ≠ X) for the selected day' },
            { type: 'wip-todate' as const, label: 'Export WIP Since Apr 1', hint: 'Open ROs (priority ≠ X) created from 1 Apr to the selected date' },
            { type: 'received' as const, label: 'Export Received JCs', hint: 'All ROs created + closed/unclosed totals + invoice sales' },
          ]).map(({ type, label, hint }) => (
            <button
              key={type}
              onClick={() => exportFromOdoo(type)}
              disabled={exporting !== null}
              title={hint}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-evs-green text-white text-sm font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50"
            >
              {exporting === type ? (
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M10 3v9m0 0l-3.5-3.5M10 12l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 14v2a1 1 0 001 1h10a1 1 0 001-1v-2" strokeLinecap="round" />
                </svg>
              )}
              {exporting === type ? 'Exporting…' : label}
            </button>
          ))}
        </div>
      </div>

      <KpiConfigCard initialConfig={initialData.kpiConfig} />

      {message && (
        <div className={`mt-4 text-sm font-semibold ${message.startsWith('✓') ? 'text-evs-green-dark' : 'text-danger'}`}>
          {message}
        </div>
      )}
    </Shell>
  );
}
