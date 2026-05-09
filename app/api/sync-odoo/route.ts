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
import { fetchWipSnapshot } from '@/lib/odoo';
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

  try {
    let autoSave = false;
    try {
      const body = await request.json();
      autoSave = body?.autoSave === true;
    } catch {
      // No body or invalid JSON — that's fine, default to preview mode
    }

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
