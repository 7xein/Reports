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
import { computeKpiTree, weekStartFor, KpiTree } from '@/lib/kpi';
import { readData } from '@/lib/data-store';
import { isAuthenticated, isAdminAuthenticated } from '@/lib/auth';
import { withKpiDefaults } from '@/lib/types';

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
    const key = `kpi:${weekStart}`;

    if (useRedis && !refresh) {
      try {
        const cached = await (await redis()).get<KpiTree>(key);
        if (cached) return NextResponse.json({ ...cached, cached: true });
      } catch { /* cache miss/unavailable — fall through to a live compute */ }
    }

    const tree = await computeKpiTree(config, weekStart);

    if (useRedis) {
      try { await (await redis()).set(key, tree, { ex: TTL_SECONDS }); } catch { /* non-fatal */ }
    }

    return NextResponse.json({ ...tree, cached: false });
  } catch (error) {
    console.error('❌ [api/kpi] failed:', error);
    return NextResponse.json(
      { error: 'KPI load failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
