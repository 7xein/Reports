/**
 * GET /api/kpi?week=YYYY-MM-DD[&refresh=1]
 *
 * Returns the whole Company → Branch → Service Advisor tree in one call so the
 * page can drill down instantly client-side.
 *
 * `week` is the Saturday the week starts on (omit for the current week).
 * Cached in Redis for 15 minutes under `kpi:{weekStart}`; `refresh=1` busts the
 * cache and requires admin auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { computeKpiTree, weekStartFor, summariseTree, KpiTree } from '@/lib/kpi';
import { readData, writeData } from '@/lib/data-store';
import { isAuthenticated, isAdminAuthenticated } from '@/lib/auth';
import { withKpiDefaults, KpiWeekSummary } from '@/lib/types';

export const maxDuration = 60;

const TTL_SECONDS = 15 * 60;
const useRedis = !!process.env.UPSTASH_REDIS_REST_URL;

async function redis() {
  const { Redis } = await import('@upstash/redis');
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}


const HISTORY_WEEKS = 8;

/** The last N stored week summaries up to `weekStart`, oldest first. */
function recentHistory(all: Record<string, KpiWeekSummary> | undefined, weekStart: string): KpiWeekSummary[] {
  if (!all) return [];
  return Object.values(all)
    .filter((h) => h.weekStart <= weekStart)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .slice(-HISTORY_WEEKS);
}

export async function GET(req: NextRequest) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'KPI load failed', detail: `Missing environment variables: ${missing.join(', ')}` },
      { status: 500 }
    );
  }

  const weekParam = req.nextUrl.searchParams.get('week') ?? undefined;
  const wantsRefresh = req.nextUrl.searchParams.get('refresh') === '1';
  // Only an admin may force a fresh (expensive) recompute.
  const refresh = wantsRefresh && isAdminAuthenticated();

  try {
    const data = await readData();
    const config = withKpiDefaults(data.kpiConfig);
    const weekStart = weekStartFor(
      weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? weekParam : undefined,
      config.weekStartDay,
    );
    // Config version is part of the key so saving new config busts the cache.
    const key = `kpi:${weekStart}:${config.updatedAt ?? 'v0'}`;

    if (useRedis && !refresh) {
      try {
        const cached = await (await redis()).get<KpiTree>(key);
        if (cached) {
          return NextResponse.json({ ...cached, cached: true, history: recentHistory(data.kpiHistory, weekStart) });
        }
      } catch { /* cache miss/unavailable — fall through to a live compute */ }
    }

    const tree = await computeKpiTree(config, weekStart);

    if (useRedis) {
      try { await (await redis()).set(key, tree, { ex: TTL_SECONDS }); } catch { /* non-fatal */ }
    }

    // Persist this week's summary so future loads can show deltas + sparklines.
    // Re-read first so we don't clobber writes made while the tree was computing.
    let history: KpiWeekSummary[] = [];
    try {
      const fresh = await readData();
      fresh.kpiHistory = { ...(fresh.kpiHistory ?? {}), [weekStart]: summariseTree(tree) };
      await writeData(fresh);
      history = recentHistory(fresh.kpiHistory, weekStart);
    } catch (e) {
      console.error('[api/kpi] could not persist week summary:', e);
      history = recentHistory(data.kpiHistory, weekStart);
    }

    return NextResponse.json({ ...tree, cached: false, history });
  } catch (error) {
    console.error('❌ [api/kpi] failed:', error);
    return NextResponse.json(
      { error: 'KPI load failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
