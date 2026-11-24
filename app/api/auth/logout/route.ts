/** POST /api/auth/logout — clear the session cookie. */

import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth';

export async function POST() {
  clearSessionCookie();
  return NextResponse.json({ success: true });
}
