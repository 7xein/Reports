/**
 * Per-branch access, applied to the data a page or API is about to hand out.
 *
 * One rule everywhere: a user restricted to some branches is served the data
 * as if the network were only those branches. Rows, pills, cards and options
 * outside them are dropped, and every total or regional figure is recomputed
 * over what is left. A figure that cannot be recomputed for a subset is hidden
 * rather than shown at its network value.
 *
 * Every helper takes a BranchAccessView and returns its input untouched when
 * `all` is set, so a user who sees every branch gets exactly what they got
 * before branch access existed. Shared caches (the KPI tree in Redis, the
 * report builds in memory) stay unfiltered: these run per request, on read.
 *
 * Pure — no session, no Redis, no Odoo calls — so it can be tested on its own.
 * Server-side only in practice (it reads BRANCH_CLUSTERS from lib/odoo); the
 * one string a client needs, NO_BRANCH_ACCESS_MESSAGE, lives in lib/access.
 */

import { effectiveBranches, seesAllBranches, type UserRecord } from './access';
import { BRANCH_CLUSTERS } from './odoo';
import {
  BRANCHES, MAIN_STATION, getSubBranches, isGroupScope, parseScope,
  type Branch, type KpiWeekSummary, type RegionalData, type ReportData,
} from './types';

// ── Who sees what ─────────────────────────────────────────────────────────────

export interface BranchAccessView {
  /** Sees every branch: nothing is filtered and every output is exactly as before. */
  all: boolean;
  /** The branches the user may see, in BRANCHES order. Every branch when `all`. */
  branches: Branch[];
}

/** Every branch — the view for the owner, Admin, and anyone granted 'all'. */
export const ALL_BRANCHES_VIEW: BranchAccessView = { all: true, branches: [...BRANCHES] };

/**
 * The access view for a user. No user (signed out, or the session could not be
 * resolved) sees nothing: the middleware already keeps such requests out, so
 * reaching here without one is a failure and fails closed.
 */
export function branchAccessOf(user: Pick<UserRecord, 'email' | 'tabs' | 'branches'> | null | undefined): BranchAccessView {
  if (!user) return { all: false, branches: [] };
  if (seesAllBranches(user)) return { all: true, branches: [...BRANCHES] };
  return { all: false, branches: effectiveBranches(user) };
}

/** True when the user may see this branch name (any string — unknown names are not allowed). */
export function canSeeBranch(access: BranchAccessView, branch: unknown): boolean {
  if (access.all) return true;
  return typeof branch === 'string' && (access.branches as readonly string[]).includes(branch);
}

/** The members of `list` the user may see, in `list`'s own order. `list` itself when `all`. */
export function visibleBranches<T extends string>(access: BranchAccessView, list: readonly T[]): readonly T[] {
  if (access.all) return list;
  return list.filter((b) => canSeeBranch(access, b));
}

/**
 * Whether a picker scope stays inside the user's branches. 'all' and the group
 * scopes ('branches', 'stations') always do — for a restricted user they mean
 * "all of MY branches" and are computed that way. A branch or station scope is
 * allowed only when its branch is; an unknown name is not.
 */
export function scopeAllowed(access: BranchAccessView, scope: string): boolean {
  if (access.all) return true;
  if (scope === 'all' || isGroupScope(scope)) return true;
  return canSeeBranch(access, parseScope(scope).branch);
}

// ── WIP & sales blob ─────────────────────────────────────────────────────────

/** `values[metric][branch]` with only the visible branches left. */
function pickBranchKeys<T extends Record<string, Record<string, number>>>(values: T, access: BranchAccessView): T {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([metric, byBranch]) => [
      metric,
      Object.fromEntries(Object.entries(byBranch ?? {}).filter(([b]) => canSeeBranch(access, b))),
    ]),
  ) as T;
}

/** `subValues[metric]['Branch__Station']` with only the visible branches' stations left. */
function pickSubKeys<T extends Record<string, Record<string, number>>>(subValues: T, access: BranchAccessView): T {
  return Object.fromEntries(
    Object.entries(subValues ?? {}).map(([metric, byKey]) => [
      metric,
      Object.fromEntries(Object.entries(byKey ?? {}).filter(([key]) => canSeeBranch(access, parseScope(key).branch))),
    ]),
  ) as T;
}

/** WIP snapshots (daily or weekly) carrying only the visible branches and their stations. */
export function restrictWipEntries<E extends { values: Record<string, Record<string, number>>; subValues?: Record<string, Record<string, number>> }>(
  entries: readonly E[],
  access: BranchAccessView,
): E[] {
  if (access.all) return entries as E[];
  return entries.map((e) => ({
    ...e,
    values: pickBranchKeys(e.values, access),
    ...(e.subValues ? { subValues: pickSubKeys(e.subValues, access) } : {}),
  }));
}

/** Regional sales: only the visible branches' log entries and targets. */
export function restrictRegional(regional: RegionalData, access: BranchAccessView): RegionalData {
  if (access.all) return regional;
  return {
    ...regional,
    salesLog: (regional.salesLog ?? []).filter((e) => canSeeBranch(access, e.branch)),
    branchConfig: Object.fromEntries(
      Object.entries(regional.branchConfig ?? {}).filter(([b]) => canSeeBranch(access, b)),
    ),
  };
}

/**
 * The data blob as the WIP and Sales pages may read it: every per-branch
 * figure outside the user's branches removed. The KPI config and history are
 * dropped outright — they carry people and verdicts per branch, no page here
 * reads them, and leaving them in would make this a blob that still leaks if a
 * later caller hands it out whole.
 */
export function restrictData(data: ReportData, access: BranchAccessView): ReportData {
  if (access.all) return data;
  const legacy = <S extends { values: Record<string, Record<string, number>> }>(s: S): S =>
    s ? { ...s, values: pickBranchKeys(s.values, access) } : s;
  return {
    ...data,
    weekly: data.weekly && {
      ...data.weekly,
      targets: pickBranchKeys(data.weekly.targets, access),
      current: legacy(data.weekly.current),
      previous: legacy(data.weekly.previous),
      history: (data.weekly.history ?? []).map(legacy),
    },
    daily: data.daily && {
      ...data.daily,
      targets: pickBranchKeys(data.daily.targets, access),
      current: legacy(data.daily.current),
      previous: legacy(data.daily.previous),
      history: (data.daily.history ?? []).map(legacy),
    },
    regional: restrictRegional(data.regional, access),
    wipHistory: restrictWipEntries(data.wipHistory ?? [], access),
    wipWeeklyHistory: restrictWipEntries(data.wipWeeklyHistory ?? [], access),
    kpiConfig: undefined,
    kpiHistory: undefined,
  };
}

// ── Free-text caveats ────────────────────────────────────────────────────────

/**
 * Words that identify a branch the user may NOT see: its name, its stations
 * (not 'Main branch', which every branch has) and its Odoo companies.
 */
export function foreignBranchTerms(access: BranchAccessView): string[] {
  if (access.all) return [];
  return BRANCHES.filter((b) => !canSeeBranch(access, b)).flatMap((b) => [
    b,
    ...getSubBranches(b).filter((s) => s !== MAIN_STATION),
    ...(BRANCH_CLUSTERS[b] ?? []),
  ]);
}

/**
 * The engine's and the reports' caveats, for a restricted user.
 *
 * A caveat is written once for the whole network, so a number in it is a
 * network count or amount ("12 repair orders left unjudged", "AED 40,000 of
 * warranty work") that cannot be recomputed for a subset, and a branch,
 * station, company or person named in it may be one the user cannot see. A
 * restricted user keeps only the caveats that carry no figure at all and name
 * nothing in `forbiddenTerms` (plus every foreign branch, station and
 * company); the rest are dropped rather than shown at their network value.
 * Terms match case-insensitively as whole words, so a false match only ever
 * drops a caveat — it never lets one through.
 */
export function restrictNotes(notes: readonly string[], access: BranchAccessView, forbiddenTerms: readonly string[] = []): string[] {
  if (access.all) return notes as string[];
  const patterns = [...foreignBranchTerms(access), ...forbiddenTerms]
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu'));
  return notes.filter((n) => !/\d/.test(n) && !patterns.some((p) => p.test(n)));
}

// ── KPI week history ─────────────────────────────────────────────────────────

/**
 * Stored KPI week summaries narrowed to the branches the user's tree shows.
 *
 * A summary keeps only per-KPI percentages per branch, not the counts behind
 * them, so a company figure over a subset of branches cannot be rebuilt from
 * it — except for one branch, where the subset's figure IS that branch's. With
 * one branch the company line is that branch's line; with several it is
 * blanked, so the page shows no week-on-week delta rather than one measured
 * against the whole network.
 */
export function restrictKpiHistory(
  history: readonly KpiWeekSummary[],
  access: BranchAccessView,
  treeBranches: readonly string[],
): KpiWeekSummary[] {
  if (access.all) return history as KpiWeekSummary[];
  const shown = treeBranches.filter((b) => canSeeBranch(access, b));
  return history.map((h) => {
    const branches = Object.fromEntries(Object.entries(h.branches ?? {}).filter(([b]) => shown.includes(b)));
    const only = shown.length === 1 ? branches[shown[0]] : undefined;
    return {
      ...h,
      company: only ? { ...only } : { achievement: null, kpis: {} },
      branches,
    };
  });
}

/**
 * Stored KPI week summaries with every company-level figure removed, for a user
 * who may not see company-wide KPIs (seesCompanyKpis false). The company entry
 * keeps its shape but is empty — no achievement, no per-KPI figures, no
 * sections — so the page shows no company trend or delta. The per-branch series
 * are kept exactly as given; narrow them first (restrictKpiHistory).
 */
export function hideCompanyHistory(history: readonly KpiWeekSummary[]): KpiWeekSummary[] {
  return history.map((h) => ({ ...h, company: { achievement: null, kpis: {} } }));
}
