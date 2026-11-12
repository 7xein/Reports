/**
 * Refresh KPI ownership from Odoo and write it straight into the stored KPI
 * config. Shared by the Admin "Refresh ownership now" route and the nightly
 * sync cron, so both do exactly the same thing.
 *
 * Odoo is only read. The store write re-reads just before writing, so an Admin
 * save made while Odoo was being read is not clobbered — only `kpiOwners` (and
 * `updatedAt`, when the owners changed) is replaced.
 */

import { fetchKpiOwners, type KpiOwnersResult } from './odoo';
import { readData, writeData } from './data-store';
import { withKpiDefaults, type KpiOwners } from './types';

/** Redis key for the last refresh's evidence (names and counts), shown in Admin. */
const REPORT_KEY = 'kpi_owner_report';
const useRedis = !!process.env.UPSTASH_REDIS_REST_URL;

async function redis() {
  const { Redis } = await import('@upstash/redis');
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

/** Order-insensitive comparison, so a re-ordered but identical set is not a change. */
function canonical(o: KpiOwners | undefined): string {
  const out: Record<string, Record<string, number[]>> = {};
  for (const b of Object.keys(o ?? {}).sort()) {
    const byKpi = o![b] ?? {};
    for (const k of Object.keys(byKpi).sort((x, y) => Number(x) - Number(y))) {
      const ids = [...(byKpi[k] ?? [])].sort((x, y) => x - y);
      if (ids.length) (out[b] ??= {})[k] = ids;
    }
  }
  return JSON.stringify(out);
}

export interface KpiOwnersRefresh extends KpiOwnersResult {
  /** True when kpiOwners was written to the store. False on a fatal read or a failed write. */
  saved: boolean;
  /** True when the stored owners differ from what was there before. */
  changed: boolean;
  /** Non-null when the store write failed. */
  saveError: string | null;
}

export async function refreshKpiOwners(opts: { budgetMs?: number } = {}): Promise<KpiOwnersRefresh> {
  // The SAVED config: the map needs the live stage mapping, and the previous
  // owners are what an unreadable action falls back to. A store that cannot be
  // read throws — refreshing against an empty "previous" would let one failed
  // Odoo read strip owners it had no evidence against.
  const config = withKpiDefaults((await readData()).kpiConfig);
  const result = await fetchKpiOwners(config, config.kpiOwners, opts.budgetMs);
  if (result.fatal) {
    return { ...result, saved: false, changed: false, saveError: null };
  }

  let saved = false;
  let changed = false;
  let saveError: string | null = null;
  try {
    // Re-read right before the write, same pattern as app/api/kpi/route.ts.
    const fresh = await readData();
    const current = fresh.kpiConfig ?? withKpiDefaults(undefined);
    changed = canonical(current.kpiOwners) !== canonical(result.owners);
    fresh.kpiConfig = {
      ...current,
      kpiOwners: result.owners,
      // updatedAt is part of the KPI cache key: bump it only when ownership
      // moved, so scores re-compute against the new owners.
      ...(changed ? { updatedAt: new Date().toISOString() } : {}),
    };
    await writeData(fresh);
    saved = true;
  } catch (e) {
    saveError = e instanceof Error ? e.message : String(e);
    console.error('❌ [kpi-owners] could not save the refreshed owners:', e);
  }

  const out: KpiOwnersRefresh = { ...result, saved, changed, saveError };
  if (useRedis) {
    try { await (await redis()).set(REPORT_KEY, out); } catch (e) { console.error('[kpi-owners] could not store the refresh report:', e); }
  }
  return out;
}

/** The last refresh's report, or null when none is stored (or Redis is not in use). */
export async function lastKpiOwnersReport(): Promise<KpiOwnersRefresh | null> {
  if (!useRedis) return null;
  try { return (await (await redis()).get<KpiOwnersRefresh>(REPORT_KEY)) ?? null; } catch { return null; }
}
