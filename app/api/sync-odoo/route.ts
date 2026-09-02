/**
 * /api/sync-odoo
 *
 * Two modes:
 *   GET  — Vercel Cron hits this daily at 20:00 Gulf. Fetches the WIP snapshot
 *          AND the day's sales from Odoo, and auto-saves both.
 *   POST — Admin "Sync from Odoo" button. Fetches and returns data for
 *          preview in the form (does NOT auto-save; the user clicks Save).
 *          If body includes { autoSave: true }, it saves immediately.
 *
 * Auth:
 *   Cron  → Vercel sends Authorization: Bearer <CRON_SECRET>
 *   Admin → Uses the same session cookie auth as /api/data
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchWipSnapshot, fetchWipWeeklySnapshot, fetchDailySales } from '@/lib/odoo';
import { isAuthenticated, isAdminAuthenticated } from '@/lib/auth';
import { readData, writeData } from '@/lib/data-store';
import { BRANCHES, type WipDailyEntry, type RegionalSalesEntry } from '@/lib/types';

export const maxDuration = 60;

// ── Cron entry point (auto-saves) ──────────────────────────────────
/** Today's date in Gulf time (UTC+4) as YYYY-MM-DD. */
function gulfToday(): string {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
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
  const date = gulfToday();
  console.log(`🔄 [cron] Odoo sync for ${date}…`);
  const [wipRes, salesRes] = await Promise.allSettled([
    fetchWipSnapshot(date),
    fetchDailySales(date),
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

    let salesRows = 0;
    if (salesRes.status === 'fulfilled') {
      const sales = salesRes.value;
      // Same shape the admin form writes, so a manual edit afterwards behaves
      // identically to one made on top of a hand-entered row.
      const rows: RegionalSalesEntry[] = BRANCHES
        .map((b) => {
          const total = sales.salesTotal[b] ?? 0;
          const without = sales.salesWithout[b] ?? 0;
          return {
            date: sales.date,
            branch: b,
            actualSales: total,
            salesWithoutWarranty: Math.min(without, total),
            notes: 'Synced from Odoo',
          };
        })
        .filter((r) => r.actualSales > 0);

      if (!data.regional.salesLog) data.regional.salesLog = [];
      // Replace only this date's rows for the branches we actually got figures
      // for. A branch with no sales keeps whatever was entered by hand.
      data.regional.salesLog = [
        ...data.regional.salesLog.filter(
          (e) => !(e.date === sales.date && rows.some((r) => r.branch === e.branch)),
        ),
        ...rows,
      ];
      salesRows = rows.length;
    }

    await writeData(data);
    console.log(`💾 [cron] Saved ${date} — WIP ${wipRes.status}, ${salesRows} sales rows`);

    return NextResponse.json({
      success: true,
      date,
      wip: wipRes.status === 'fulfilled' ? 'saved' : 'failed',
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
