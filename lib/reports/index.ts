/**
 * The EVHUB report registry: slug → module, plus the cache and scope filter
 * every report gets for free.
 *
 * Modules build every row for every branch once; filtering by scope (branch or
 * station) happens here, on the cached build, so switching scope in the UI
 * never re-reads Odoo. The summary tiles for every reachable scope are computed
 * once per build and kept with it.
 */

import { BRANCHES, WORKSHOP_BRANCHES, GROUP_SCOPES, getSubBranches, subKey } from '../types';
import {
  reportMeta, rowInScope,
  type ReportBuild, type ReportModule, type ReportParams, type ReportResult, type ReportSlug,
  type ReportSummaryItem,
} from './types';
import { report as noRfq } from './no-rfq';
import { report as rfqToPo } from './rfq-to-po';
import { report as poToReceipt } from './po-to-receipt';
import { report as openParts } from './open-parts';
import { report as cost } from './cost';
import { report as attention } from './attention';
import { report as openJobs } from './open-jobs';
import { report as notInvoiced } from './not-invoiced';
import { report as unposted } from './unposted';

export const REPORT_MODULES: Record<ReportSlug, ReportModule> = {
  'no-rfq': noRfq,
  'rfq-to-po': rfqToPo,
  'po-to-receipt': poToReceipt,
  'open-parts': openParts,
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
  opts: { scope: string; refresh: boolean },
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
