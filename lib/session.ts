/**
 * The signed session cookie.
 *
 * Value: `base64url(JSON payload) . base64url(HMAC-SHA256(payload part))`,
 * signed with env AUTH_SECRET. Payload: `{ e: email, v: sessionVersion, exp }`
 * (exp in Unix seconds).
 *
 * Web Crypto only, so the same code runs in the edge middleware and in Node
 * route handlers. A token that verifies is still only HALF the check — the
 * caller must also load the user and compare `v` with `user.sessionVersion`
 * (see resolveSession), which is what lets deleting a user, or bumping the
 * version, revoke a cookie that has not expired yet.
 */

import type { UserRecord } from './access';

export const SESSION_COOKIE = 'evs_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface SessionPayload {
  /** Normalized email. */
  e: string;
  /** The user's sessionVersion when the session was issued. */
  v: number;
  /** Expiry, Unix seconds. */
  exp: number;
}

/** Cookie options for the session cookie (Next's cookies().set / response.cookies.set). */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  };
}

let warnedMissingSecret = false;

/**
 * env AUTH_SECRET, or null when unset. Missing means fail closed: nobody can be
 * signed in or sign in. Logged once per runtime instance, not per request.
 */
export function getAuthSecret(): string | null {
  const s = process.env.AUTH_SECRET;
  if (s && s.length > 0) return s;
  if (!warnedMissingSecret) {
    warnedMissingSecret = true;
    console.error('[auth] AUTH_SECRET is not set — every request is treated as signed out.');
  }
  return null;
}

// ── base64url ─────────────────────────────────────────────────────────────────

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ── HMAC ──────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Sign a payload into a cookie value. */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = bytesToB64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** A fresh payload for a user, valid for SESSION_MAX_AGE_SECONDS from `nowMs`. */
export function newSessionPayload(user: Pick<UserRecord, 'email' | 'sessionVersion'>, nowMs = Date.now()): SessionPayload {
  return {
    e: user.email,
    v: user.sessionVersion,
    exp: Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * The payload of a correctly signed, unexpired token, else null. Does NOT check
 * the user record — use resolveSession for that.
 */
export async function verifySession(
  token: string | undefined | null,
  secret: string,
  nowMs = Date.now(),
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = b64urlToBytes(token.slice(dot + 1));
  if (!sig) return null;

  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, encoder.encode(body));
  if (!ok) return null;

  const raw = b64urlToBytes(body);
  if (!raw) return null;
  let p: unknown;
  try {
    p = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object') return null;
  const { e, v, exp } = p as Record<string, unknown>;
  if (typeof e !== 'string' || typeof v !== 'number' || typeof exp !== 'number') return null;
  if (exp * 1000 <= nowMs) return null;
  return { e, v, exp };
}

/**
 * The signed-in user for a cookie value, or null. Valid only if the signature
 * is good, it has not expired, the user still exists, and the version matches.
 * `loadUser` is injected so this works with the edge reader and the Node one.
 */
export async function resolveSession(
  token: string | undefined | null,
  loadUser: (email: string) => Promise<UserRecord | null>,
  nowMs = Date.now(),
): Promise<UserRecord | null> {
  const secret = getAuthSecret();
  if (!secret || !token) return null;
  const payload = await verifySession(token, secret, nowMs);
  if (!payload) return null;
  const user = await loadUser(payload.e);
  if (!user || user.sessionVersion !== payload.v) return null;
  return user;
}
