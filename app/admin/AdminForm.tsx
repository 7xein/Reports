'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { BRANCHES, WIP_METRICS, WipMetricKey, ReportData, RegionalSalesEntry } from '@/lib/types';
import { getWeekStart } from '@/lib/sales-utils';

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

function emptyWipValues(): Record<WipMetricKey, Record<string, number>> {
  return Object.fromEntries(
    WIP_METRICS.map((m) => [m.key, Object.fromEntries(BRANCHES.map((b) => [b, 0]))])
  ) as Record<WipMetricKey, Record<string, number>>;
}

export function AdminForm({ initialData }: { initialData: ReportData }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // ── Odoo sync state
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // ── WIP Daily state
  const [wipDate, setWipDate] = useState(today());
  const [wipValues, setWipValues] = useState<Record<WipMetricKey, Record<string, number>>>(emptyWipValues());

  // ── WIP Weekly state
  const [wipWeekEnding, setWipWeekEnding] = useState(lastThursday());
  const [wipWeeklyValues, setWipWeeklyValues] = useState<Record<WipMetricKey, Record<string, number>>>(emptyWipValues());

  const [salesLog, setSalesLog] = useState<RegionalSalesEntry[]>(initialData.regional.salesLog);
  const [newDate, setNewDate] = useState(today());
  const [newEntries, setNewEntries] = useState<Record<string, { sales: string; notes: string }>>(
    Object.fromEntries(BRANCHES.map((b) => [b, { sales: '', notes: '' }]))
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
        body: JSON.stringify({ autoSave: false }), // preview mode
      });

      const data = await res.json();

      if (!res.ok) {
        const detail = data?.detail || data?.error || 'Unknown error';
        setMessage(`Odoo sync failed: ${detail}`);
        setSyncStatus('error');
        setSyncing(false);
        return;
      }

      // Populate the form fields with Odoo data
      if (data.values) {
        setWipDate(data.date || today());
        const newValues = emptyWipValues();
        for (const metricKey of Object.keys(newValues) as WipMetricKey[]) {
          if (data.values[metricKey]) {
            for (const branch of BRANCHES) {
              newValues[metricKey][branch] = data.values[metricKey][branch] ?? 0;
            }
          }
        }
        setWipValues(newValues);
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

  async function saveWip() {
    setSaving(true);
    setMessage('');
    const err = await apiPost('wip-daily', { date: wipDate, values: wipValues });
    if (err) { setMessage(err); setSaving(false); return; }
    const total = (initialData.wipHistory?.length ?? 0) + 1;
    setMessage(`✓ WIP snapshot saved for ${wipDate} (${total} total data points)`);
    setSyncStatus('idle');
    setSaving(false);
  }

  async function saveWipWeekly() {
    setSaving(true);
    setMessage('');
    const err = await apiPost('wip-weekly', { weekEnding: wipWeekEnding, values: wipWeeklyValues });
    if (err) { setMessage(err); setSaving(false); return; }
    setMessage(`✓ Weekly WIP snapshot saved for week ending ${wipWeekEnding}`);
    setSaving(false);
  }

  async function saveSales() {
    setSaving(true);
    setMessage('');
    const newRows: RegionalSalesEntry[] = BRANCHES
      .map((b) => ({
        date: newDate,
        branch: b,
        actualSales: parseFloat(newEntries[b]?.sales || '0') || 0,
        notes: newEntries[b]?.notes || '',
      }))
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
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-bold uppercase tracking-wide text-ink">WIP Snapshot — Today's Numbers</h2>
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
              onChange={(e) => setWipDate(e.target.value)}
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

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2.5 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-xs min-w-[200px]">Metric</th>
                {BRANCHES.map((b) => (
                  <th key={b} className="text-center py-2.5 px-2 font-semibold uppercase tracking-wide text-ink-muted text-xs min-w-[90px]">{b}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WIP_METRICS.map((m, rowIdx) => (
                <tr key={m.key} className={`border-b border-border ${rowIdx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="py-2.5 pr-4 text-ink font-medium leading-tight">{m.label}</td>
                  {BRANCHES.map((b) => (
                    <td key={b} className="py-1.5 px-1.5">
                      <input
                        type="number"
                        min="0"
                        value={wipValues[m.key as WipMetricKey][b] || ''}
                        onChange={(e) => setWip(m.key as WipMetricKey, b, e.target.value)}
                        className={`
                          w-full px-3 py-1.5 border rounded text-right tabular-nums text-ink
                          focus:border-evs-green focus:outline-none text-sm
                          ${syncStatus === 'success' && wipValues[m.key as WipMetricKey][b] > 0
                            ? 'border-evs-green/40 bg-evs-green/5'
                            : 'border-border'
                          }
                        `}
                        placeholder="0"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            <div className="flex items-center gap-2">
              <label className="text-sm text-ink-muted">Week ending (Thursday):</label>
              <input type="date" value={wipWeekEnding}
                onChange={(e) => setWipWeekEnding(e.target.value)}
                className="text-sm border border-border rounded px-3 py-1.5 text-ink" />
            </div>
            <span className="text-xs text-ink-muted">
              Covers: <strong>{fmtDate(weekStartOf(wipWeekEnding))}</strong> – <strong>{fmtDate(wipWeekEnding)}</strong>
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2.5 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-xs min-w-[200px]">Metric</th>
                {BRANCHES.map((b) => (
                  <th key={b} className="text-center py-2.5 px-2 font-semibold uppercase tracking-wide text-ink-muted text-xs min-w-[90px]">{b}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WIP_METRICS.map((m, rowIdx) => (
                <tr key={m.key} className={`border-b border-border ${rowIdx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="py-2.5 pr-4 text-ink font-medium leading-tight">{m.label}</td>
                  {BRANCHES.map((b) => (
                    <td key={b} className="py-1.5 px-1.5">
                      <input type="number" min="0"
                        value={wipWeeklyValues[m.key as WipMetricKey][b] || ''}
                        onChange={(e) => setWipWeekly(m.key as WipMetricKey, b, e.target.value)}
                        className="w-full px-3 py-1.5 border border-border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-sm"
                        placeholder="0" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            <div className="flex items-center gap-2">
              <label className="text-sm text-ink-muted">Date:</label>
              <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)}
                className="text-sm border border-border rounded px-3 py-1.5 text-ink" />
            </div>
            {initialData.regional.weekStart && (
              <span className="text-xs text-ink-muted">
                Week: <strong>{fmtDate(getWeekStart(newDate, initialData.regional.weekStart))}</strong> – <strong>{fmtDate(addDays(getWeekStart(newDate, initialData.regional.weekStart), 6))}</strong>
              </span>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2.5 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-xs">Branch</th>
                <th className="text-left py-2.5 px-2 font-semibold uppercase tracking-wide text-ink-muted text-xs">Actual Sales (AED)</th>
                <th className="text-left py-2.5 px-2 font-semibold uppercase tracking-wide text-ink-muted text-xs">Notes</th>
              </tr>
            </thead>
            <tbody>
              {BRANCHES.map((b, idx) => (
                <tr key={b} className={`border-b border-border ${idx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="py-2.5 pr-4 font-semibold text-ink">{b}</td>
                  <td className="py-1.5 px-1.5">
                    <input type="number" min="0" value={newEntries[b]?.sales ?? ''}
                      onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], sales: e.target.value } }))}
                      className="w-full px-3 py-1.5 border border-border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-sm"
                      placeholder="0" />
                  </td>
                  <td className="py-1.5 px-1.5">
                    <input type="text" value={newEntries[b]?.notes ?? ''}
                      onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], notes: e.target.value } }))}
                      className="w-full px-3 py-1.5 border border-border rounded text-ink focus:border-evs-green focus:outline-none text-sm"
                      placeholder="Optional notes" />
                  </td>
                </tr>
              ))}
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

      {message && (
        <div className={`mt-4 text-sm font-semibold ${message.startsWith('✓') ? 'text-evs-green-dark' : 'text-danger'}`}>
          {message}
        </div>
      )}
    </Shell>
  );
}
