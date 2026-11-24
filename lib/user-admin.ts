/**
 * Pure helpers for the admin Users screen (shared by the API and the page).
 */

import type { PublicUser } from './access';

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
