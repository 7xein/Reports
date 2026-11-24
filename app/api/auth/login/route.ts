/**
 * POST /api/auth/login { email, password } — sign in.
 *
 * One generic error for a wrong email or a wrong password, so the form does not
 * reveal which emails have accounts. After LOGIN_MAX_FAILURES failures for an
 * email within 15 minutes, further attempts get 429 until the window passes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { setSessionCookie } from '@/lib/auth';
import { normalizeEmail } from '@/lib/access';
import { getAuthSecret } from '@/lib/session';
import {
  burnPasswordCheck, clearLoginFailures, getUser, isLoginLocked, recordLoginFailure, verifyPassword,
} from '@/lib/users';
import { getRedis } from '@/lib/user-record';

const BAD_LOGIN = 'Incorrect email or password';

export async function POST(req: NextRequest) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: BAD_LOGIN }, { status: 401 });
  }

  if (!getAuthSecret() || !getRedis()) {
    return NextResponse.json({ error: 'Sign-in is not configured on the server.' }, { status: 503 });
  }

  try {
    if (await isLoginLocked(email)) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Try again in 15 minutes.' },
        { status: 429 },
      );
    }

    const user = await getUser(email);
    const ok = user && password.length <= 1024
      ? await verifyPassword(password, user.passwordHash)
      : await burnPasswordCheck(password.slice(0, 1024));

    if (!user || !ok) {
      await recordLoginFailure(email);
      return NextResponse.json({ error: BAD_LOGIN }, { status: 401 });
    }

    await clearLoginFailures(email);
    await setSessionCookie(user);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[api/auth/login] failed:', err);
    return NextResponse.json({ error: 'Could not sign in. Try again.' }, { status: 500 });
  }
}
