/**
 * POST /api/auth/signup { name, email, password } — create an account (with no
 * tabs until the owner grants some) and sign it in. 400 bad input, 409 the
 * email is taken, 503 no user storage / no AUTH_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { setSessionCookie } from '@/lib/auth';
import { getAuthSecret } from '@/lib/session';
import { UserStoreError, createUser } from '@/lib/users';

export async function POST(req: NextRequest) {
  let body: { name?: unknown; email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Check before creating, so a missing secret never leaves an account behind
  // that the person then cannot sign in to.
  if (!getAuthSecret()) {
    return NextResponse.json({ error: 'Sign-in is not configured on the server.' }, { status: 503 });
  }

  try {
    const user = await createUser({
      name: typeof body.name === 'string' ? body.name : '',
      email: typeof body.email === 'string' ? body.email : '',
      password: typeof body.password === 'string' ? body.password : '',
    });
    await setSessionCookie(user);
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof UserStoreError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[api/auth/signup] failed:', err);
    return NextResponse.json({ error: 'Could not create the account.' }, { status: 500 });
  }
}
