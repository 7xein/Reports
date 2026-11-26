/**
 * The EVHUB report registry: slug → module, plus the cache and scope filter
 * every report gets for free.
 *
 * Modules build every row for every branch once; filtering by scope (branch or
 * station) happens here, on the cached build, so switching scope in the UI
 * never re-reads Odoo. The summary tiles for every reachable scope are computed
 * once per build and kept with it.
 */

import { BRANCHES, WORKSHOP_BRANCHES, GROUP_SCOPES, getSubBranches, isGroupScope, subKey } from '../types';
import { canSeeBranch, restrictNotes, visibleBranches, type BranchAccessView } from '../branch-scope';
import {
  BRANCH_KEY, reportMeta, rowInScope,
  type ReportBuild, type ReportModule, type ReportParams, type ReportResult, type ReportSlug,
  type ReportSummaryItem,
} from './types';
import { report as noRfq } from './no-rfq';
import { report as rfqToPo } from './rfq-to-po';
import { report as poToReceipt } from './po-to-receipt';
import { report as openParts, carInReport as openPartsCarIn } from './open-parts';
import { report as cost } from './cost';
import { report as attention } from './attention';
import { report as openJobs } from './open-jobs';
import { report as notInvoiced } from './not-invoiced';
import { report as unposted } from './unposted';
import { clearPartsChainMemo } from './parts-chain';
import { clearCeoDataMemo } from './ceo-core';

export const REPORT_MODULES: Record<ReportSlug, ReportModule> = {
  'no-rfq': noRfq,
  'rfq-to-po': rfqToPo,
  'po-to-receipt': poToReceipt,
  'open-parts': openParts,
  // A filtered view of open-parts, off the same shared chain load.
  'open-parts-car-in': openPartsCarIn,
  cost,
  // The CEO section. All four read one shared population (ceo-core.ts), so a
  // visit that opens every tab costs a single Odoo read.
  attention,
  'open-jobs': openJobs,
  'not-invoiced': notInvoiced,
  unposted,
};

// In memory, not Redis: a report can exceed a stored value's size limit, and
// Fluid Compute reuses instances, so a warm instance serves repeats from here.
const TTL_MS = 10 * 60 * 1000;

type Built = {
  build: ReportBuild;
  at: number;
  /** Summary tiles per valid scope, filled on first use. Same params as the build, which the cache key guarantees. */
  summaries?: Record<string, ReportSummaryItem[]>;
};
type Entry = { promise: Promise<Built>; settled?: Built };

const cache = new Map<string, Entry>();

/**
 * Drop every cached build and the shared population memos behind them, on this
 * instance. Called after an Admin company relink so a site that read zero does
 * not keep reading zero for the rest of the TTL. Other warm instances keep
 * theirs until it expires.
 */
export function clearReportCaches(): void {
  cache.clear();
  clearPartsChainMemo();
  clearCeoDataMemo();
}

/**
 * The cached build for a key, or a fresh one. The in-flight promise is cached
 * too, so two people opening the same report at once share one Odoo read; a
 * rejected build is dropped so the next request retries instead of replaying
 * the failure for ten minutes.
 */
function cachedBuild(key: string, run: () => Promise<ReportBuild>, refresh: boolean): Promise<Built> {
  const hit = cache.get(key);
  if (hit && !refresh && (!hit.settled || Date.now() - hit.settled.at < TTL_MS)) return hit.promise;

  const entry: Entry = {
    promise: run().then((build) => {
      const built = { build, at: Date.now() };
      entry.settled = built;
      return built;
    }),
  };
  entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  cache.set(key, entry);
  return entry.promise;
}

/** Every scope the picker can reach for a report: 'all', the groups, each branch, each station of those branches. */
function validScopes(branches: readonly string[]): string[] {
  const out = ['all'];
  // Group scopes only on a branch-scoped report — getReport falls back to 'all'
  // for a scope it does not list, which would silently undo the user's choice.
  if (branches.length > 0) out.push(...GROUP_SCOPES);
  for (const b of branches) {
    out.push(b);
    for (const s of getSubBranches(b)) out.push(subKey(b, s));
  }
  return out;
}

export async function getReport(
  slug: ReportSlug,
  params: ReportParams,
  opts: {
    scope: string;
    refresh: boolean;
    /**
     * The user's branch access. Omitted, or `all`, returns the report exactly
     * as before. Applied after the cache, per request — the cached build and
     * its summaries stay whole and shared.
     */
    access?: BranchAccessView;
  },
): Promise<ReportResult> {
  const mod = REPORT_MODULES[slug];
  const meta = reportMeta(slug);
  // Unwindowed reports ignore `days`, so every window shares one entry. The
  // thresholds and the open-RO rule are in the key so an Admin change shows at
  // once instead of after the TTL.
  const key = `${slug}:${meta.windowed ? params.days : '-'}:${JSON.stringify([params.thresholds, params.openRoDomain])}`;
  const built = await cachedBuild(key, () => mod.build(params, { refresh: opts.refresh }), opts.refresh);
  const { build, at } = built;

  // Every branch the report covers, rows or not, so the picker's pills stay put.
  const branches: string[] = build.branchScoped
    ? [...(meta.branchSet === 'workshop' ? WORKSHOP_BRANCHES : BRANCHES)]
    : [];
  const scopes = validScopes(branches);

  if (!built.summaries) {
    const summaries: Record<string, ReportSummaryItem[]> = {};
    for (const s of scopes) {
      summaries[s] = mod.summarise(s === 'all' ? build.rows : build.rows.filter((r) => rowInScope(r, s)), params);
    }
    built.summaries = summaries;
  }

  // A branch-restricted user on a branch-scoped report. A report that is not
  // branch-scoped (EV Hub cost analysis) has no branch to narrow by: its tab
  // decides who reads it, so it falls through to the unrestricted path below.
  const access = opts.access;
  if (access && !access.all && build.branchScoped) {
    return restrictedView(mod, params, build, built.summaries, at, branches, opts.scope, access);
  }

  const scope = scopes.includes(opts.scope) ? opts.scope : 'all';
  const rows = scope === 'all' ? build.rows : build.rows.filter((r) => rowInScope(r, scope));

  return {
    ...build,
    rows,
    generatedAt: new Date(at).toISOString(),
    scope,
    branches,
    summary: built.summaries[scope],
    summaries: built.summaries,
  };
}

/**
 * A branch-scoped report as a restricted user may see it: only rows booked to
 * their branches, only their branches' pills, and summaries for exactly the
 * scopes they can reach.
 *
 * A branch's or a station's tiles depend on that branch's rows alone, so the
 * cached ones are reused. 'All' and the two groups span branches, so their
 * tiles are summarised again over the user's rows — never the network's. A row
 * with no branch, or one outside the user's set, is dropped: it belongs to no
 * branch they were given. The caveats go through restrictNotes, since they are
 * written once for the whole network.
 */
function restrictedView(
  mod: ReportModule,
  params: ReportParams,
  build: ReportBuild,
  cached: Record<string, ReportSummaryItem[]>,
  at: number,
  allBranches: readonly string[],
  requestedScope: string,
  access: BranchAccessView,
): ReportResult {
  const branches = [...visibleBranches(access, allBranches)];
  const visibleRows = build.rows.filter((r) => canSeeBranch(access, r[BRANCH_KEY]));
  const scopes = validScopes(branches);

  const summaries: Record<string, ReportSummaryItem[]> = {};
  for (const s of scopes) {
    summaries[s] = s === 'all' || isGroupScope(s)
      ? mod.summarise(s === 'all' ? visibleRows : visibleRows.filter((r) => rowInScope(r, s)), params)
      : cached[s];
  }

  const scope = scopes.includes(requestedScope) ? requestedScope : 'all';
  const rows = scope === 'all' ? visibleRows : visibleRows.filter((r) => rowInScope(r, scope));

  return {
    ...build,
    rows,
    notes: restrictNotes(build.notes, access),
    generatedAt: new Date(at).toISOString(),
    scope,
    branches,
    summary: summaries[scope],
    summaries,
  };
}
