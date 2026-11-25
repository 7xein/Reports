/**
 * User accounts — server only (Node runtime: uses node:crypto scrypt).
 *
 * Storage is Upstash Redis (see lib/user-record.ts for the keys). Every write
 * goes through here so the owner rules hold everywhere:
 *   - the owner (env OWNER_EMAIL, see lib/access.ts) always has every tab,
 *   - the owner can never be deleted, and their tabs can never be changed.
 * Breaking one of those throws an OwnerProtectedError.
 *
 * Errors: UserStoreError (with a `status` an API route can answer with) for
 * expected failures — bad input, duplicate email, missing user, no Redis.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import {
  cleanBranchAccess, cleanTabs, isOwnerEmail, normalizeEmail, toPublicUser,
  type BranchAccess, type PublicUser, type TabId, type UserRecord,
} from './access';
import { USERS_SET_KEY, getRedis, loadUserRecord, userKey } from './user-record';

export const MIN_PASSWORD_LENGTH = 8;
/** Bounds the hashing work one request can ask for. */
const MAX_PASSWORD_LENGTH = 1024;
const MAX_NAME_LENGTH = 100;

export class UserStoreError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'UserStoreError';
  }
}

export class OwnerProtectedError extends UserStoreError {
  constructor(message = "The owner's account can't be deleted or have its access changed.") {
    super(message, 403);
    this.name = 'OwnerProtectedError';
  }
}

function requireRedis() {
  const redis = getRedis();
  if (!redis) {
    throw new UserStoreError(
      'Accounts need Upstash Redis — UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set.',
      503,
    );
  }
  return redis;
}

// ── Passwords ─────────────────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS: ScryptOptions = { N: 16384, r: 8, p: 1 };

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_OPTS, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** `scrypt$<salt b64>$<hash b64>` with a random 16-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time check of a password against a stored hash. False for a malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = await scrypt(password, salt);
  return timingSafeEqual(actual, expected);
}

// A real hash of a random password, so a login for an unknown email costs the
// same scrypt work as one for a real account and timing does not reveal which
// emails exist.
let dummyHash: Promise<string> | null = null;
export function burnPasswordCheck(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash.then((h) => verifyPassword(password, h)).then(() => false);
}

// ── Validation ────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

/** A reason the password is unacceptable, or null if it is fine. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return 'Password is too long.';
  return null;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The full stored record (including the password hash), or null. Server use only. */
export async function getUser(email: string): Promise<UserRecord | null> {
  return loadUserRecord(email);
}

/** Every user, safe to send to the browser, sorted by name then email. */
export async function listUsers(): Promise<PublicUser[]> {
  const redis = requireRedis();
  const emails = await redis.smembers(USERS_SET_KEY);
  if (emails.length === 0) return [];
  const records = await redis.mget<(UserRecord | null)[]>(...emails.map(userKey));
  return records
    .filter((r): r is UserRecord => !!r && typeof r === 'object')
    .map(toPublicUser)
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Create an account with no tabs. Validates name, email and password; throws
 * UserStoreError 400 for bad input and 409 if the email is taken.
 */
export async function createUser(input: { name: string; email: string; password: string }): Promise<UserRecord> {
  const name = (input.name ?? '').trim();
  const email = normalizeEmail(input.email ?? '');
  if (!name) throw new UserStoreError('Name is required.', 400);
  if (name.length > MAX_NAME_LENGTH) throw new UserStoreError('Name is too long.', 400);
  if (!isValidEmail(email)) throw new UserStoreError('Enter a valid email address.', 400);
  const pwProblem = passwordProblem(input.password);
  if (pwProblem) throw new UserStoreError(pwProblem, 400);

  const redis = requireRedis();
  const user: UserRecord = {
    email,
    name,
    passwordHash: await hashPassword(input.password),
    tabs: [],
    createdAt: new Date().toISOString(),
    sessionVersion: 1,
    branches: 'all',
  };
  // NX: two signups racing for one email cannot both win.
  const created = await redis.set(userKey(email), user, { nx: true });
  if (created === null) throw new UserStoreError('An account with this email already exists.', 409);
  await redis.sadd(USERS_SET_KEY, email);
  return user;
}

/**
 * Replace a user's tabs (unknown ids are dropped). Takes effect on their next
 * request — the middleware reads the record every time. Throws 404 for an
 * unknown user and OwnerProtectedError for the owner.
 */
export async function setUserTabs(email: string, tabs: readonly TabId[]): Promise<PublicUser> {
  if (isOwnerEmail(email)) throw new OwnerProtectedError();
  const redis = requireRedis();
  const user = await getUser(email);
  if (!user) throw new UserStoreError('No such user.', 404);
  const updated: UserRecord = { ...user, tabs: cleanTabs(tabs) };
  await redis.set(userKey(user.email), updated);
  return toPublicUser(updated);
}

/**
 * Replace a user's branch access: 'all' or a list (unknown names are dropped).
 * Takes effect on their next request. Throws 404 for an unknown user and
 * OwnerProtectedError for the owner.
 */
export async function setUserBranches(email: string, access: BranchAccess): Promise<PublicUser> {
  if (isOwnerEmail(email)) throw new OwnerProtectedError();
  const redis = requireRedis();
  const user = await getUser(email);
  if (!user) throw new UserStoreError('No such user.', 404);
  const updated: UserRecord = { ...user, branches: cleanBranchAccess(access) };
  await redis.set(userKey(user.email), updated);
  return toPublicUser(updated);
}

/**
 * Delete an account. Its sessions stop working at once (no record → no
 * session). Throws 404 for an unknown user and OwnerProtectedError for the owner.
 */
export async function deleteUser(email: string): Promise<void> {
  if (isOwnerEmail(email)) throw new OwnerProtectedError();
  const redis = requireRedis();
  const key = userKey(email);
  const removed = await redis.del(key);
  await redis.srem(USERS_SET_KEY, normalizeEmail(email));
  if (removed === 0) throw new UserStoreError('No such user.', 404);
}

/** Sign a user out on every device by bumping their sessionVersion. */
export async function revokeSessions(email: string): Promise<void> {
  const redis = requireRedis();
  const user = await getUser(email);
  if (!user) throw new UserStoreError('No such user.', 404);
  await redis.set(userKey(user.email), { ...user, sessionVersion: user.sessionVersion + 1 });
}

// ── Login throttle ────────────────────────────────────────────────────────────

export const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

function failKey(email: string): string {
  return `evs_login_fail:${normalizeEmail(email)}`;
}

/** True when this email has had LOGIN_MAX_FAILURES failed logins in the window. */
export async function isLoginLocked(email: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const n = await redis.get<number>(failKey(email));
  return Number(n ?? 0) >= LOGIN_MAX_FAILURES;
}

/** Count a failed login; the window starts at the first failure. */
export async function recordLoginFailure(email: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = failKey(email);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, LOGIN_WINDOW_SECONDS);
}

export async function clearLoginFailures(email: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(failKey(email));
}
