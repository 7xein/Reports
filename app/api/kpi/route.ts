/**
 * GET /api/kpi?week=YYYY-MM-DD[&refresh=1]
 *
 * Returns the whole Company → Branch → Service Advisor tree in one call so the
 * page can drill down instantly client-side.
 *
 * `week` is the Saturday the week starts on (omit for the current week).
 * Cached in Redis for 15 minutes under `kpi:{weekStart}`; `refresh=1` busts the
 * cache and requires admin auth.
 *
 * Narrowed per user on the way out, in this order: branch access first
 * (restrictKpiTree), then — for a user limited to one KPI person — that
 * person's cards only (restrictKpiTreeToPerson). The response's `person` names
 * that person ({ odooUserId, name }), or is null for a user who sees all KPIs.
 *
 * `leaderboard` (kpiLeaderboard) is the one part every KPI user gets whole: the
 * top six of every KPI branch, name and overall score only. It is built from
 * the FULL tree, before either restriction, and attached after them, so neither
 * can strip or widen it. Every week the picker offers — past ones too — is a
 * full tree computed from Odoo (or its 15-minute cache), never the stored week
 * summaries, so per-person scores always exist and the board follows the week.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  computeKpiTree, weekStartFor, summariseTree, KpiTree, restrictKpiTree, restrictKpiTreeToPerson, kpiLeaderboard,
} from '@/lib/kpi';
import { readData, writeData } from '@/lib/data-store';
import { getCurrentUser, hasTab } from '@/lib/auth';
import { NO_BRANCH_ACCESS_MESSAGE, effectiveKpiPerson } from '@/lib/access';
import { branchAccessOf, restrictKpiHistory, type BranchAccessView } from '@/lib/branch-scope';
import { withKpiDefaults, KpiWeekSummary, KpiConfig } from '@/lib/types';

// 300, not 60: computing all 21 KPIs for every branch is the heaviest read in
// the app, and it outgrew a minute — production timed out on 9 Nov 2026. The
// EVHUB and CEO routes already run at 300 for the same reason. A timeout here is
// worse than merely slow: the result never reaches the Redis cache below, so
// every later visitor repeats the same doomed minute and the page stays broken
// for everyone rather than being slow once.
export const maxDuration = 300;

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

/**
 * The tree and its history as this user may see them. Branch access is applied
 * here, per request, on the way out — the cached tree and the stored week
 * summaries stay whole, so one user's view can never become another's.
 *
 * Branch access always applies first. A user limited to one KPI person is then
 * narrowed further to that person's cards in those branches. The stored week
 * summaries hold only company and branch figures — no per-person series — so
 * such a user gets no history at all rather than other people's numbers.
 */
function forUser(
  tree: KpiTree,
  history: KpiWeekSummary[],
  access: BranchAccessView,
  config: KpiConfig,
  personId: number | null,
) {
  // 1. Branch access — exactly what every user got before KPI people existed.
  let shown = tree;
  let shownHistory = history;
  if (!access.all) {
    shown = restrictKpiTree(tree, access, config);
    shownHistory = restrictKpiHistory(history, access, shown.branches.map((b) => b.name));
  }
  if (personId == null) return { tree: shown, history: shownHistory };
  // 2. One person, within the branches step 1 left.
  return { tree: restrictKpiTreeToPerson(shown, personId, config), history: [] as KpiWeekSummary[] };
}

/**
 * The response body: the tree and history narrowed for this user, plus the
 * leaderboard built from the full, unrestricted tree.
 */
function responseBody(
  full: KpiTree,
  history: KpiWeekSummary[],
  access: BranchAccessView,
  config: KpiConfig,
  personId: number | null,
  cached: boolean,
) {
  const out = forUser(full, history, access, config, personId);
  return {
    ...out.tree,
    cached,
    history: out.history,
    person: personOf(personId, config),
    leaderboard: kpiLeaderboard(full),
  };
}

/** Who a person-limited user's KPIs belong to, for the page's copy; null for all KPIs. */
function personOf(personId: number | null, config: KpiConfig): { odooUserId: number; name: string } | null {
  if (personId == null) return null;
  const entry = (config.saRoster ?? []).find((r) => r.odooUserId === personId);
  return { odooUserId: personId, name: entry?.name || `User ${personId}` };
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !hasTab(user, 'kpi')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const access = branchAccessOf(user);
  // Null for the owner, Admin and anyone on "All KPIs".
  const personId = effectiveKpiPerson(user);
  // No branch, nothing to show: refuse before the expensive compute.
  if (!access.all && access.branches.length === 0) {
    return NextResponse.json({ error: NO_BRANCH_ACCESS_MESSAGE }, { status: 403 });
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
  const refresh = wantsRefresh && hasTab(user, 'admin');

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
          return NextResponse.json(
            responseBody(cached, recentHistory(data.kpiHistory, weekStart), access, config, personId, true),
          );
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

    return NextResponse.json(responseBody(tree, history, access, config, personId, false));
  } catch (error) {
    console.error('❌ [api/kpi] failed:', error);
    return NextResponse.json(
      { error: 'KPI load failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
