/**
 * Session helpers for server components and route handlers (Node runtime).
 *
 * The middleware already gates every page and API by tab (middleware.ts); route
 * handlers still check here as defence in depth, so a change to the middleware
 * cannot silently open a route.
 */

import { cookies } from 'next/headers';
import { effectiveTabs, type TabId, type UserRecord } from './access';
import {
  SESSION_COOKIE, getAuthSecret, newSessionPayload, resolveSession, sessionCookieOptions, signSession,
} from './session';
import { getUser } from './users';

export type User = UserRecord;

/** The signed-in user (full record — never send it to the browser as is), or null. */
export async function getCurrentUser(): Promise<User | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await resolveSession(token, getUser);
  } catch (err) {
    // Redis down or similar: fail closed.
    console.error('[auth] could not resolve session:', err);
    return null;
  }
}

/** Whether the user may open a tab (the owner may open every tab). */
export function hasTab(user: Pick<User, 'email' | 'tabs'> | null | undefined, tab: TabId): boolean {
  return !!user && effectiveTabs(user).includes(tab);
}

/** Whether the user may open at least one of the given tabs. */
export function hasAnyTab(user: Pick<User, 'email' | 'tabs'> | null | undefined, tabs: readonly TabId[]): boolean {
  return !!user && tabs.some((t) => hasTab(user, t));
}

/** Signed in at all. */
export async function isAuthenticated(): Promise<boolean> {
  return (await getCurrentUser()) !== null;
}

/** Signed in with the Admin tab. */
export async function isAdminAuthenticated(): Promise<boolean> {
  return hasTab(await getCurrentUser(), 'admin');
}

/** Sign a user in on this response. Throws if AUTH_SECRET is unset. */
export async function setSessionCookie(user: Pick<User, 'email' | 'sessionVersion'>): Promise<void> {
  const secret = getAuthSecret();
  if (!secret) throw new Error('AUTH_SECRET environment variable is not set');
  const token = await signSession(newSessionPayload(user), secret);
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(): void {
  cookies().delete(SESSION_COOKIE);
}
