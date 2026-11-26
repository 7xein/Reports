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
 * Company-wide figures go to the owner and Admin only: any other "All KPIs"
 * user gets the company level emptied and `companyHidden: true` (see forUser).
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
  computeKpiTree, weekStartFor, summariseTree, KpiTree, restrictKpiTree, restrictKpiTreeToPerson, kpiLeaderboard, hideCompanyKpis,
} from '@/lib/kpi';
import { readData, writeData } from '@/lib/data-store';
import { getCurrentUser, hasTab } from '@/lib/auth';
import { NO_BRANCH_ACCESS_MESSAGE, effectiveKpiPerson, seesCompanyKpis } from '@/lib/access';
import { branchAccessOf, restrictKpiHistory, hideCompanyHistory, type BranchAccessView } from '@/lib/branch-scope';
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
 *
 * Company-wide figures are the owner's and Admin's only (seesCompanyKpis). Any
 * other user on "All KPIs" gets the branches and people of their branches and
 * NO company level: not the network figure and not one rebuilt from their
 * branches. Their tree always takes the restricted path (restrictKpiTree), even
 * when they may see every branch, because that path is what narrows the
 * caveats — a caveat is written once for the whole network, so any number in
 * it is a company-level count, and restrictNotes drops every caveat carrying a
 * figure. The company line is then emptied (hideCompanyKpis) and the history
 * keeps only its per-branch series (hideCompanyHistory). A one-person user is
 * left as before: their "company" line is their own cards combined.
 */
function forUser(
  tree: KpiTree,
  history: KpiWeekSummary[],
  access: BranchAccessView,
  config: KpiConfig,
  personId: number | null,
  companyVisible: boolean,
): { tree: KpiTree; history: KpiWeekSummary[]; companyHidden: boolean } {
  // One person, within the branches they may see — unchanged by the company rule.
  if (personId != null) {
    const shown = access.all ? tree : restrictKpiTree(tree, access, config);
    return { tree: restrictKpiTreeToPerson(shown, personId, config), history: [], companyHidden: false };
  }
  // Owner and Admin: the whole tree (they always see every branch).
  if (companyVisible) {
    if (access.all) return { tree, history, companyHidden: false };
    const shown = restrictKpiTree(tree, access, config);
    return { tree: shown, history: restrictKpiHistory(history, access, shown.branches.map((b) => b.name)), companyHidden: false };
  }
  // Everyone else on "All KPIs": their branches, no company level.
  const restricted: BranchAccessView = { all: false, branches: access.branches };
  const shown = restrictKpiTree(tree, restricted, config);
  const shownHistory = restrictKpiHistory(history, restricted, shown.branches.map((b) => b.name));
  return { tree: hideCompanyKpis(shown), history: hideCompanyHistory(shownHistory), companyHidden: true };
}

/**
 * The response body: the tree and history narrowed for this user, plus the
 * leaderboard built from the full, unrestricted tree. `companyHidden` tells the
 * page the company level was withheld, so it shows no company hero, lines or
 * deltas rather than empty ones.
 */
function responseBody(
  full: KpiTree,
  history: KpiWeekSummary[],
  access: BranchAccessView,
  config: KpiConfig,
  personId: number | null,
  companyVisible: boolean,
  cached: boolean,
) {
  const out = forUser(full, history, access, config, personId, companyVisible);
  return {
    ...out.tree,
    cached,
    history: out.history,
    person: personOf(personId, config),
    companyHidden: out.companyHidden,
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
  // Company-wide figures: the owner and Admin only.
  const companyVisible = seesCompanyKpis(user);
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
            responseBody(cached, recentHistory(data.kpiHistory, weekStart), access, config, personId, companyVisible, true),
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

    return NextResponse.json(responseBody(tree, history, access, config, personId, companyVisible, false));
  } catch (error) {
    console.error('❌ [api/kpi] failed:', error);
    return NextResponse.json(
      { error: 'KPI load failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
