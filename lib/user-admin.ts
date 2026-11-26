/**
 * Pure helpers for the admin Users screen (shared by the API and the page).
 */

import type { PublicUser } from './access';
import { rosterBranches, type SaRosterEntry } from './types';

/** One person the Users screen's KPI picker offers: a KPI roster entry. */
export interface KpiPersonOption {
  odooUserId: number;
  name: string;
  branches: string[];
}

/** The KPI roster as picker options: one per Odoo user id, sorted by name. */
export function kpiPersonOptions(roster: readonly SaRosterEntry[]): KpiPersonOption[] {
  const seen = new Set<number>();
  const out: KpiPersonOption[] = [];
  for (const r of roster) {
    if (!Number.isInteger(r.odooUserId) || seen.has(r.odooUserId)) continue;
    seen.add(r.odooUserId);
    out.push({ odooUserId: r.odooUserId, name: r.name || `User ${r.odooUserId}`, branches: rosterBranches(r) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.odooUserId - b.odooUserId);
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Owner first, then people with no tabs (newest first — they are waiting for
 * access), then everyone else by name.
 */
export function sortUsersForAdmin(users: readonly PublicUser[]): PublicUser[] {
  const rank = (u: PublicUser) => (u.isOwner ? 0 : u.tabs.length === 0 ? 1 : 2);
  return [...users].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) === 1) return time(b.createdAt) - time(a.createdAt);
    return a.name.localeCompare(b.name) || a.email.localeCompare(b.email);
  });
}
