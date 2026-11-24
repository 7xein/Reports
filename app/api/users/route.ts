/**
 * Admin user management.
 *   GET    → { users }             (owner, then waiting-for-access, then by name)
 *   PATCH  { email, tabs } → { user }
 *   DELETE { email }       → { ok: true }
 *
 * The middleware already limits /api/users to the Admin tab; every handler
 * re-checks it here as defence in depth.
 */

import { NextResponse } from 'next/server';
import { cleanTabs, isOwnerEmail, normalizeEmail } from '@/lib/access';
import { getCurrentUser, hasTab, type User } from '@/lib/auth';
import { deleteUser, listUsers, setUserTabs, OwnerProtectedError, UserStoreError } from '@/lib/users';
import { sortUsersForAdmin } from '@/lib/user-admin';

export const dynamic = 'force-dynamic';

const OWNER_MESSAGE = "The owner's account can't be changed or deleted.";

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

async function requireAdmin(): Promise<User | null> {
  const user = await getCurrentUser();
  return hasTab(user, 'admin') ? user : null;
}

function handleError(err: unknown) {
  if (err instanceof OwnerProtectedError) return fail(OWNER_MESSAGE, 400);
  if (err instanceof UserStoreError) return fail(err.message, err.status);
  console.error('[api/users]', err);
  return fail('Something went wrong. Please try again.', 500);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET() {
  if (!(await requireAdmin())) return fail('Forbidden', 403);
  try {
    return NextResponse.json({ users: sortUsersForAdmin(await listUsers()) });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request) {
  const me = await requireAdmin();
  if (!me) return fail('Forbidden', 403);
  const body = await readBody(req);
  if (!body || typeof body.email !== 'string' || !body.email.trim() || !Array.isArray(body.tabs)) {
    return fail('Send { email, tabs }.', 400);
  }
  const email = normalizeEmail(body.email);
  const tabs = cleanTabs(body.tabs);
  if (isOwnerEmail(email)) return fail(OWNER_MESSAGE, 400);
  if (email === normalizeEmail(me.email) && !tabs.includes('admin')) {
    return fail("You can't remove your own Admin access", 400);
  }
  try {
    const user = await setUserTabs(email, tabs);
    return NextResponse.json({ user });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request) {
  const me = await requireAdmin();
  if (!me) return fail('Forbidden', 403);
  const body = await readBody(req);
  if (!body || typeof body.email !== 'string' || !body.email.trim()) {
    return fail('Send { email }.', 400);
  }
  const email = normalizeEmail(body.email);
  if (isOwnerEmail(email)) return fail(OWNER_MESSAGE, 400);
  if (email === normalizeEmail(me.email)) return fail("You can't delete your own account.", 400);
  try {
    await deleteUser(email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
