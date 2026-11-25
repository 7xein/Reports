/**
 * GET /api/auth/me — the signed-in user: { email, name, tabs, isOwner, branches }.
 * `tabs` are the effective ones (the owner's are all of them); `branches` are
 * the branches whose data the user may see (every branch for the owner and
 * Admin). Informational only — every page and API enforces branch access on
 * the server. 401 if signed out.
 */

import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { effectiveBranches, toPublicUser } from '@/lib/access';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  const { email, name, tabs, isOwner } = toPublicUser(user);
  return NextResponse.json(
    { email, name, tabs, isOwner, branches: effectiveBranches(user) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
