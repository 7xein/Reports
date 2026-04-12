'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { BRANCHES, WIP_METRICS, WipMetricKey, ReportData, RegionalSalesEntry } from '@/lib/types';

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

  // ── WIP state ──────────────────────────────────────────────────────────────
  const [wipDate, setWipDate] = useState(today());
  const [wipValues, setWipValues] = useState<Record<WipMetricKey, Record<string, number>>>(
    emptyWipValues()
  );

  // ── Sales state ────────────────────────────────────────────────────────────
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

  async function saveWip() {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'wip-daily', payload: { date: wipDate, values: wipValues } }),
      });
      if (!res.ok) throw new Error('Save failed');
      const total = (initialData.wipHistory?.length ?? 0) + 1;
      setMessage(`✓ WIP snapshot saved for ${wipDate} (${total} total data points)`);
    } catch {
      setMessage('Error saving WIP snapshot');
    } finally {
      setSaving(false);
    }
  }

  async function saveSales() {
    setSaving(true);
    setMessage('');
    try {
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
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'regional-log', payload: updated }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSalesLog(updated);
      setMessage(`✓ Sales entries saved for ${newDate}`);
    } catch {
      setMessage('Error saving sales');
    } finally {
      setSaving(false);
    }
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
      {/* ── WIP Section ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-ink">WIP Snapshot — Today&apos;s Numbers</h2>
          <div className="flex items-center gap-2">
            <label className="text-[9px] text-ink-muted">Date:</label>
            <input
              type="date"
              value={wipDate}
              onChange={(e) => setWipDate(e.target.value)}
              className="text-[9px] border border-border rounded px-2 py-1 text-ink"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[9px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-[8px] min-w-[180px]">Metric</th>
                {BRANCHES.map((b) => (
                  <th key={b} className="text-center py-2 px-2 font-semibold uppercase tracking-wide text-ink-muted text-[8px] min-w-[80px]">{b}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WIP_METRICS.map((m, rowIdx) => (
                <tr key={m.key} className={`border-b border-border ${rowIdx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="py-2 pr-4 text-ink font-medium leading-tight">{m.label}</td>
                  {BRANCHES.map((b) => (
                    <td key={b} className="py-1 px-1">
                      <input
                        type="number"
                        min="0"
                        value={wipValues[m.key as WipMetricKey][b] || ''}
                        onChange={(e) => setWip(m.key as WipMetricKey, b, e.target.value)}
                        className="w-full px-2 py-1 border border-border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-[9px]"
                        placeholder="0"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={saveWip}
            disabled={saving}
            className="px-5 py-2 bg-evs-green text-white text-[10px] font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save WIP Snapshot →'}
          </button>
          <span className="text-[8.5px] text-ink-muted">Each save appends to the Daily Trends chart</span>
        </div>
      </div>

      {/* ── Sales Section ────────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-ink">Sales Log — Add Today&apos;s Sales</h2>
          <div className="flex items-center gap-2">
            <label className="text-[9px] text-ink-muted">Date:</label>
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="text-[9px] border border-border rounded px-2 py-1 text-ink"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[9px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">Branch</th>
                <th className="text-left py-2 px-2 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">Actual Sales (AED)</th>
                <th className="text-left py-2 px-2 font-semibold uppercase tracking-wide text-ink-muted text-[8px]">Notes</th>
              </tr>
            </thead>
            <tbody>
              {BRANCHES.map((b, idx) => (
                <tr key={b} className={`border-b border-border ${idx % 2 === 1 ? 'bg-surface/60' : ''}`}>
                  <td className="py-2 pr-4 font-semibold text-ink">{b}</td>
                  <td className="py-1 px-1">
                    <input
                      type="number"
                      min="0"
                      value={newEntries[b]?.sales ?? ''}
                      onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], sales: e.target.value } }))}
                      className="w-full px-2 py-1 border border-border rounded text-right tabular-nums text-ink focus:border-evs-green focus:outline-none text-[9px]"
                      placeholder="0"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      value={newEntries[b]?.notes ?? ''}
                      onChange={(e) => setNewEntries((p) => ({ ...p, [b]: { ...p[b], notes: e.target.value } }))}
                      className="w-full px-2 py-1 border border-border rounded text-ink focus:border-evs-green focus:outline-none text-[9px]"
                      placeholder="Optional notes"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={saveSales}
            disabled={saving}
            className="px-5 py-2 bg-evs-green text-white text-[10px] font-bold rounded-md hover:bg-evs-green-dark transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Sales Entry →'}
          </button>
          <button onClick={handleLogout} className="text-[9px] text-ink-muted hover:text-ink">
            Sign out
          </button>
        </div>
      </div>

      {message && (
        <div className={`mt-3 text-[10px] font-semibold ${message.startsWith('✓') ? 'text-evs-green-dark' : 'text-danger'}`}>
          {message}
        </div>
      )}
    </Shell>
  );
}
