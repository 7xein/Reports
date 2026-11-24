/**
 * DELETE /api/auth — sign out. Kept for the Admin page's sign-out button
 * (app/admin/AdminForm.tsx); new code should POST /api/auth/logout.
 *
 * The old shared-password POST is gone: sign in with /api/auth/login.
 */

import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth';

export async function DELETE() {
  clearSessionCookie();
  return NextResponse.json({ success: true });
}
