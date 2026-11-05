import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public paths
  if (
    pathname === '/login' ||
    pathname === '/admin/login' ||
    pathname.startsWith('/api/auth') ||
    // The cron hits this with a bearer token and no cookie. Without this line the
    // middleware redirects it to /login and the scheduled sync never runs; the
    // handler's CRON_SECRET check is the real guard.
    pathname === '/api/sync-odoo' ||
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

  // The EV Hub section requires a second password too. Both halves are gated:
  // the report pages fetch their rows from /api/evhub/[report], so gating the
  // pages alone would leave the data one request away for anyone who holds the
  // site password.
  const isEvhubPage = pathname === '/evhub' || pathname.startsWith('/evhub/');
  const isEvhubApi = pathname === '/api/evhub' || pathname.startsWith('/api/evhub/');

  // IMPORTANT: /evhub/login is deliberately NOT in the public-paths list above —
  // it sits behind the site password so the second password has no guessing
  // surface on the open internet. That means it reaches this gate, so it MUST be
  // skipped here; without this check the login page would redirect to itself
  // forever.
  if ((isEvhubPage || isEvhubApi) && pathname !== '/evhub/login') {
    const isEvhubAuth = request.cookies.get('evs_evhub_auth')?.value === 'authenticated';
    if (!isEvhubAuth) {
      // The data route answers with 401 rather than a redirect: a fetch that
      // follows a redirect to an HTML login page fails with a confusing JSON
      // parse error at the caller.
      if (isEvhubApi) {
        return NextResponse.json({ error: 'EVHUB authentication required' }, { status: 401 });
      }
      const evhubLoginUrl = new URL('/evhub/login', request.url);
      evhubLoginUrl.searchParams.set('from', pathname);
      return NextResponse.redirect(evhubLoginUrl);
    }
  }

  // The CEO section requires a second password too, pages and data alike, for
  // the same reason as EV Hub: the pages fetch their rows from /api/ceo/[report],
  // so gating the pages alone would leave the data one request away for anyone
  // who holds the site password.
  const isCeoPage = pathname === '/ceo' || pathname.startsWith('/ceo/');
  const isCeoApi = pathname === '/api/ceo' || pathname.startsWith('/api/ceo/');

  // IMPORTANT: /ceo/login is deliberately NOT in the public-paths list above —
  // it sits behind the site password so the second password has no guessing
  // surface on the open internet. That means it reaches this gate, so it MUST be
  // skipped here; without this check the login page would redirect to itself
  // forever.
  if ((isCeoPage || isCeoApi) && pathname !== '/ceo/login') {
    const isCeoAuth = request.cookies.get('evs_ceo_auth')?.value === 'authenticated';
    if (!isCeoAuth) {
      // The data route answers with 401 rather than a redirect: a fetch that
      // follows a redirect to an HTML login page fails with a confusing JSON
      // parse error at the caller.
      if (isCeoApi) {
        return NextResponse.json({ error: 'CEO authentication required' }, { status: 401 });
      }
      const ceoLoginUrl = new URL('/ceo/login', request.url);
      ceoLoginUrl.searchParams.set('from', pathname);
      return NextResponse.redirect(ceoLoginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  // icon.png is app/icon.png, the browser-tab icon Next serves for every page.
  // Without it here the gate redirects the favicon request to /login, so the
  // browser is handed HTML where it asked for an image and the login page shows
  // the default globe — the one place the icon has to work before signing in.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|evs-logo.png).*)'],
};
