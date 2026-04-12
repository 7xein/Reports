import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public paths
  if (
    pathname === '/login' ||
    pathname === '/admin/login' ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next();
  }

  const isSiteAuth = request.cookies.get('evs_auth')?.value === 'authenticated';

  if (!isSiteAuth) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Admin routes require a second password
  if (pathname.startsWith('/admin')) {
    const isAdminAuth = request.cookies.get('evs_admin_auth')?.value === 'authenticated';
    if (!isAdminAuth) {
      const adminLoginUrl = new URL('/admin/login', request.url);
      return NextResponse.redirect(adminLoginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|evs-logo.png).*)'],
};
