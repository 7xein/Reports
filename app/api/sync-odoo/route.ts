/**
 * /api/sync-odoo
 *
 * Two modes:
 *   GET  — Vercel Cron hits this daily at 08:00 Gulf and reports on YESTERDAY.
 *          Fetches the WIP snapshot and re-reads the WHOLE month's sales, so an
 *          invoice posted late but dated earlier still lands. Auto-saves both.
 *   POST — Admin "Sync from Odoo" button. Fetches and returns data for
 *          preview in the form (does NOT auto-save; the user clicks Save).
 *          If body includes { autoSave: true }, it saves immediately.
 *
 * Auth:
 *   Cron  → Vercel sends Authorization: Bearer <CRON_SECRET>
 *   Admin → Uses the same session cookie auth as /api/data
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchWipSnapshot, fetchWipWeeklySnapshot, fetchDailySales, fetchSalesRange } from '@/lib/odoo';
import { isAuthenticated, isAdminAuthenticated } from '@/lib/auth';
import { readData, writeData } from '@/lib/data-store';
import { BRANCHES, type WipDailyEntry, type RegionalSalesEntry } from '@/lib/types';

export const maxDuration = 60;

// ── Cron entry point (auto-saves) ──────────────────────────────────
/**
 * Yesterday's date in Gulf time (UTC+4) as YYYY-MM-DD.
 *
 * The cron runs at 08:00 Gulf and reports on the day that just finished, so the
 * sales figure covers a complete day rather than a few hours of one.
 */
function gulfYesterday(): string {
  const d = new Date(Date.now() + 4 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  // Fail closed. This route writes to the data store and is exempt from the
  // middleware's cookie check, so a missing secret must block it rather than
  // leave it open.
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Both halves target the same Gulf day, and neither is allowed to sink the
  // other — a WIP failure should not cost us the day's sales.
  //
  // They are not the same kind of measurement. Sales are genuinely filtered to
  // that date. WIP metrics are live counts with no date filter, so the date is
  // only the label they are filed under — and at 08:00, before the day's work
  // starts, that reading is yesterday's closing backlog.
  const date = gulfYesterday();
  const monthStart = `${date.slice(0, 7)}-01`;
  console.log(`🔄 [cron] Odoo sync for ${date}…`);
  // Sales are re-read for the whole month, not just the target day. A day that
  // was already synced is synced again, which is the only way an invoice entered
  // late under an earlier date ever reaches the monthly figure.
  const [wipRes, salesRes] = await Promise.allSettled([
    fetchWipSnapshot(date),
    fetchSalesRange(monthStart, date),
  ]);

  const errors: string[] = [];
  if (wipRes.status === 'rejected') errors.push(`WIP: ${String(wipRes.reason)}`);
  if (salesRes.status === 'rejected') errors.push(`Sales: ${String(salesRes.reason)}`);
  if (wipRes.status === 'rejected' && salesRes.status === 'rejected') {
    console.error('❌ [cron] both halves failed:', errors);
    return NextResponse.json({ error: 'Sync failed', detail: errors.join(' | ') }, { status: 500 });
  }

  // One read, both patches, one write.
  try {
    const data = await readData();

    if (wipRes.status === 'fulfilled') {
      const snap = wipRes.value;
      const entry: WipDailyEntry = { date: snap.date, values: snap.values, subValues: snap.subValues };
      if (!data.wipHistory) data.wipHistory = [];
      const idx = data.wipHistory.findIndex((e) => e.date === entry.date);
      if (idx >= 0) data.wipHistory[idx] = entry;
      else data.wipHistory.push(entry);
      data.wipHistory.sort((a, b) => a.date.localeCompare(b.date));
    }

    let salesRows = 0, salesDays = 0;
    if (salesRes.status === 'fulfilled') {
      const sales = salesRes.value;
      // Same shape the admin form writes, so a manual edit afterwards behaves
      // identically to one made on top of a hand-entered row.
      const rows: RegionalSalesEntry[] = [];
      for (const [day, byBranch] of Object.entries(sales.totals)) {
        for (const b of BRANCHES) {
          const total = byBranch[b] ?? 0;
          if (total <= 0) continue;
          const without = sales.without[day]?.[b] ?? 0;
          rows.push({
            date: day,
            branch: b,
            actualSales: total,
            salesWithoutWarranty: Math.min(without, total),
            notes: 'Synced from Odoo',
          });
        }
      }
      salesDays = Object.keys(sales.totals).length;

      if (!data.regional.salesLog) data.regional.salesLog = [];
      // Replace only the (date, branch) pairs Odoo actually returned figures for.
      // A branch with no sales that day keeps whatever was entered by hand.
      const replacing = new Set(rows.map((r) => `${r.date}|${r.branch}`));
      data.regional.salesLog = [
        ...data.regional.salesLog.filter((e) => !replacing.has(`${e.date}|${e.branch}`)),
        ...rows,
      ];
      salesRows = rows.length;
    }

    await writeData(data);
    console.log(`💾 [cron] Saved ${date} — WIP ${wipRes.status}, ${salesRows} sales rows over ${salesDays} days`);

    return NextResponse.json({
      success: true,
      date,
      wip: wipRes.status === 'fulfilled' ? 'saved' : 'failed',
      salesFrom: monthStart,
      salesDays,
      salesRows,
      ...(errors.length ? { warnings: errors } : {}),
    });
  } catch (error) {
    console.error('❌ [cron] save failed:', error);
    return NextResponse.json(
      { error: 'Sync failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

// ── Manual entry point (returns data for preview) ──────────────────
export async function POST(request: NextRequest) {
  // Admin session auth (same as /api/data)
  if (!isAuthenticated() || !isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check env vars up-front and return a clear error if any are missing
  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Sync failed', detail: `Missing environment variables: ${missing.join(', ')} — add them in Vercel → Settings → Environment Variables, then redeploy.` },
      { status: 500 }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // No body or invalid JSON — fine, use defaults
  }

  // ── Month-to-date sales re-sync (saves immediately) ───────────────
  // The same work the cron does nightly, on demand. Useful when an invoice is
  // entered late under an earlier date, or after fixing a company name.
  if (body?.mode === 'sales-month') {
    try {
      const ref = typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
      const monthStart = `${ref.slice(0, 7)}-01`;
      console.log(`🔄 [manual] Re-reading sales ${monthStart} → ${ref}…`);
      const sales = await fetchSalesRange(monthStart, ref);

      const rows: RegionalSalesEntry[] = [];
      for (const [day, byBranch] of Object.entries(sales.totals)) {
        for (const b of BRANCHES) {
          const total = byBranch[b] ?? 0;
          if (total <= 0) continue;
          rows.push({
            date: day,
            branch: b,
            actualSales: total,
            salesWithoutWarranty: Math.min(sales.without[day]?.[b] ?? 0, total),
            notes: 'Synced from Odoo',
          });
        }
      }

      const data = await readData();
      if (!data.regional.salesLog) data.regional.salesLog = [];
      const replacing = new Set(rows.map((r) => `${r.date}|${r.branch}`));
      data.regional.salesLog = [
        ...data.regional.salesLog.filter((e) => !replacing.has(`${e.date}|${e.branch}`)),
        ...rows,
      ];
      await writeData(data);

      return NextResponse.json({
        success: true,
        mode: 'sales-month',
        from: monthStart,
        to: ref,
        days: Object.keys(sales.totals).length,
        rows: rows.length,
        invoices: sales.invoiceCount,
        unresolved: sales.unresolved,
        saved: true,
      });
    } catch (error) {
      console.error('❌ [manual] month sales re-sync failed:', error);
      return NextResponse.json(
        { error: 'Sync failed', detail: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  // ── Sales sync mode ───────────────────────────────────────────────
  if (body?.mode === 'sales') {
    try {
      const dateStr = typeof body?.date === 'string' ? body.date : undefined;
      console.log(`🔄 [manual] Starting Odoo sales sync for ${dateStr ?? 'yesterday'}…`);
      const result = await fetchDailySales(dateStr);
      console.log(`✅ [manual] Fetched sales for ${result.date}`);
      return NextResponse.json({
        success: true,
        mode: 'sales',
        date: result.date,
        salesTotal: result.salesTotal,
        salesWithout: result.salesWithout,
        unresolved: result.unresolved,
        saved: false,
      });
    } catch (error) {
      console.error('❌ [manual] Odoo sales sync failed:', error);
      return NextResponse.json(
        { error: 'Sync failed', detail: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  // ── Weekly WIP sync mode ───────────────────────────────────────────
  if (body?.mode === 'weekly') {
    try {
      const startDate = typeof body?.startDate === 'string' ? body.startDate : undefined;
      const endDate = typeof body?.endDate === 'string' ? body.endDate : undefined;
      if (!startDate || !endDate) {
        return NextResponse.json(
          { error: 'Sync failed', detail: 'startDate and endDate are required for weekly mode' },
          { status: 400 }
        );
      }
      console.log(`🔄 [manual] Starting Odoo weekly WIP sync for ${startDate} → ${endDate}…`);
      const snapshot = await fetchWipWeeklySnapshot(startDate, endDate);
      console.log(`✅ [manual] Fetched weekly snapshot for ${snapshot.date}`);
      return NextResponse.json({
        success: true,
        mode: 'weekly',
        date: snapshot.date,
        values: snapshot.values,
        subValues: snapshot.subValues,
        saved: false,
      });
    } catch (error) {
      console.error('❌ [manual] Odoo weekly WIP sync failed:', error);
      return NextResponse.json(
        { error: 'Sync failed', detail: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  // ── WIP sync mode (default) ───────────────────────────────────────
  try {
    const autoSave = body?.autoSave === true;
    const dateStr = typeof body?.date === 'string' ? body.date : undefined;
    console.log(`🔄 [manual] Starting Odoo WIP sync for ${dateStr ?? 'today'} (autoSave: ${autoSave})…`);
    const snapshot = await fetchWipSnapshot(dateStr);
    console.log(`✅ [manual] Fetched snapshot for ${snapshot.date}`);

    if (autoSave) {
      const data = await readData();
      const entry: WipDailyEntry = { date: snapshot.date, values: snapshot.values, subValues: snapshot.subValues };
      if (!data.wipHistory) data.wipHistory = [];
      const idx = data.wipHistory.findIndex((e) => e.date === entry.date);
      if (idx >= 0) data.wipHistory[idx] = entry;
      else data.wipHistory.push(entry);
      data.wipHistory.sort((a, b) => a.date.localeCompare(b.date));
      await writeData(data);
      console.log(`💾 [manual] Auto-saved snapshot for ${snapshot.date}`);
    }

    return NextResponse.json({
      success: true,
      date: snapshot.date,
      values: snapshot.values,
      subValues: snapshot.subValues,
      saved: autoSave,
    });
  } catch (error) {
    console.error('❌ [manual] Odoo sync failed:', error);
    return NextResponse.json(
      { error: 'Sync failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
