/**
 * Client-side helper: download the actual records behind a WIP metric
 * (optionally one branch, optionally a date range for weekly) as a CSV,
 * fetched live from Odoo via /api/export-odoo.
 */
export async function downloadMetricCsv(
  metric: string,
  branch: string | undefined,
  setExportingKey: (k: string | null) => void,
  range?: { start: string; end: string },
) {
  setExportingKey(branch ?? '__all__');
  try {
    const res = await fetch('/api/export-odoo', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metric, branch, ...(range ?? {}) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Export failed: ${body?.detail || body?.error || res.statusText}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const cd = res.headers.get('Content-Disposition') || '';
    const fn = cd.match(/filename="(.+?)"/);
    a.href = url;
    a.download = fn ? fn[1] : `${metric}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setExportingKey(null);
  }
}
