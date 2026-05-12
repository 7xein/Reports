/**
 * /api/sync-odoo
 *
 * Two modes:
 *   GET  — Vercel Cron hits this daily. Fetches from Odoo and auto-saves.
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
import type { WipDailyEntry } from '@/lib/types';

export const maxDuration = 60;

// ── Cron entry point (auto-saves) ──────────────────────────────────
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('🔄 [cron] Starting Odoo WIP sync…');
    const snapshot = await fetchWipSnapshot();
    console.log(`✅ [cron] Fetched snapshot for ${snapshot.date}`);

    // Save directly to the data store (same logic as POST /api/data wip-daily)
    const data = await readData();
    const entry: WipDailyEntry = { date: snapshot.date, values: snapshot.values };

    if (!data.wipHistory) data.wipHistory = [];
    const idx = data.wipHistory.findIndex((e) => e.date === entry.date);
    if (idx >= 0) {
      data.wipHistory[idx] = entry;
    } else {
      data.wipHistory.push(entry);
    }
    data.wipHistory.sort((a, b) => a.date.localeCompare(b.date));

    await writeData(data);
    console.log(`💾 [cron] Snapshot saved for ${snapshot.date}`);

    return NextResponse.json({ success: true, date: snapshot.date });
  } catch (error) {
    console.error('❌ [cron] Odoo sync failed:', error);
    return NextResponse.json(
      { error: 'Sync failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
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
        sales: result.sales,
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
    console.log(`🔄 [manual] Starting Odoo WIP sync (autoSave: ${autoSave})…`);
    const snapshot = await fetchWipSnapshot();
    console.log(`✅ [manual] Fetched snapshot for ${snapshot.date}`);

    if (autoSave) {
      const data = await readData();
      const entry: WipDailyEntry = { date: snapshot.date, values: snapshot.values };
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
