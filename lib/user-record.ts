/**
 * Reading user records from Upstash Redis — the part of user storage that the
 * edge middleware needs, so it imports nothing Node-only. Writes and password
 * hashing live in lib/users.ts (Node runtime).
 *
 * Keys:
 *   evs_user:<lowercased email>  → UserRecord (JSON)
 *   evs_users                    → set of every user's email (for listing)
 */

import { Redis } from '@upstash/redis';
import { normalizeEmail, type UserRecord } from './access';

export const USERS_SET_KEY = 'evs_users';

export function userKey(email: string): string {
  return `evs_user:${normalizeEmail(email)}`;
}

let client: Redis | null | undefined;

/**
 * The shared Redis client, or null when UPSTASH_REDIS_REST_URL/TOKEN are unset
 * (local dev without Redis). With no Redis there are no accounts, so nobody is
 * signed in; only the public pages work.
 */
export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

/** The stored record for an email, or null if there is none (or no Redis). */
export async function loadUserRecord(email: string): Promise<UserRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  const rec = await redis.get<UserRecord>(userKey(email));
  return rec && typeof rec === 'object' ? rec : null;
}
