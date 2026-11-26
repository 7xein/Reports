/**
 * Redis storage for the site → Odoo company links (see lib/company-links.ts).
 *
 * Stored as one hash, COMPANY_LINKS_KEY: field = configured label, value = Odoo
 * company id. A hash so the read path's learning and an Admin relink each write
 * only their own fields and can never clobber each other.
 *
 * Reads and learning never throw: a missing or unreachable Redis means the
 * dashboards resolve by name alone, exactly as before links existed.
 */

import { getRedis } from './user-record';
import { COMPANY_LINKS_KEY, cleanCompanyLinks } from './company-links';

/** The stored links, or null when there is no Redis or the read failed. */
export async function readCompanyLinks(): Promise<Record<string, number> | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return cleanCompanyLinks(await redis.hgetall<Record<string, unknown>>(COMPANY_LINKS_KEY));
  } catch (e) {
    console.warn('[company-links] could not read the stored links — resolving by name only:', e);
    return null;
  }
}

/** Store links learned from a name match. True when written; false (never a throw) otherwise. */
export async function learnCompanyLinks(links: Record<string, number>): Promise<boolean> {
  if (!Object.keys(links).length) return true;
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.hset(COMPANY_LINKS_KEY, links);
    console.log(`[company-links] learned ${Object.entries(links).map(([l, id]) => `"${l}" → #${id}`).join(', ')}`);
    return true;
  } catch (e) {
    console.warn('[company-links] could not store learned links:', e);
    return false;
  }
}

export class CompanyLinkStoreError extends Error {}

/** Store one link chosen by an admin. Throws CompanyLinkStoreError so the route can say why. */
export async function setCompanyLink(label: string, odooCompanyId: number): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new CompanyLinkStoreError('Redis is not configured, so the link cannot be saved.');
  try {
    await redis.hset(COMPANY_LINKS_KEY, { [label]: odooCompanyId });
  } catch (e) {
    console.error('[company-links] could not save a link:', e);
    throw new CompanyLinkStoreError('Could not save the link. Please try again.');
  }
}
