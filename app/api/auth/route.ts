import { NextRequest, NextResponse } from 'next/server';
import {
  getSitePassword,
  getAdminPassword,
  setAuthCookie,
  setAdminAuthCookie,
  clearAuthCookies,
} from '@/lib/auth';

export async function POST(req: NextRequest) {
  const { password, type } = await req.json();

  if (type === 'admin') {
    if (password === getAdminPassword()) {
      setAdminAuthCookie();
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: 'Invalid password' }, { status: 401 });
  }

  // Default: site login
  if (password === getSitePassword()) {
    setAuthCookie();
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Invalid password' }, { status: 401 });
}

export async function DELETE() {
  clearAuthCookies();
  return NextResponse.json({ success: true });
}
