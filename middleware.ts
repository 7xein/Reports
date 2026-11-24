import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { effectiveTabs, landingHref, tabForPage, tabsForApi } from '@/lib/access';
import { SESSION_COOKIE, resolveSession } from '@/lib/session';
import { loadUserRecord } from '@/lib/user-record';

// Files in public/ that the sign-in pages show before anyone is signed in.
const PUBLIC_FILES = new Set(['/evs-logo.png', '/evs-logo-nobg.png', '/evs-logo-new.png']);

// The shared-password login pages are gone; old bookmarks land on `/`.
const LEGACY_LOGIN_PATHS = new Set(['/admin/login', '/ceo/login', '/evhub/login']);

function isPublic(pathname: string, method: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/api/auth' ||
    pathname.startsWith('/api/auth/') ||
    // The cron hits this with a bearer token and no cookie. Without this line the
    // middleware redirects it to /login and the scheduled sync never runs; the
    // handler's CRON_SECRET check is the real guard. Only GET — the manual
    // POST sync is Admin's and is gated below.
    (pathname === '/api/sync-odoo' && method === 'GET') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname === '/icon.png' ||
    PUBLIC_FILES.has(pathname)
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  if (isPublic(pathname, method)) return NextResponse.next();

  if (LEGACY_LOGIN_PATHS.has(pathname)) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const isApi = pathname === '/api' || pathname.startsWith('/api/');

  // Signature, expiry, the user record and its session version are all checked
  // here, on every request, so revoking access takes effect immediately. Any
  // failure (no AUTH_SECRET, no Redis, Redis down) means signed out.
  let user = null;
  try {
    user = await resolveSession(request.cookies.get(SESSION_COOKIE)?.value, loadUserRecord);
  } catch (err) {
    console.error('[middleware] session check failed:', err);
  }

  if (!user) {
    // APIs answer 401 rather than redirect: a fetch that follows a redirect to
    // an HTML login page fails with a confusing JSON parse error at the caller.
    if (isApi) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  const tabs = effectiveTabs(user);

  if (isApi) {
    const needs = tabsForApi(pathname, method);
    // An API that maps to no tab is shut: new routes must be added to lib/access.ts.
    if (!needs || !needs.some((t) => tabs.includes(t))) {
      return NextResponse.json({ error: 'You do not have access to this' }, { status: 403 });
    }
    return NextResponse.next();
  }

  if (pathname === '/') {
    return NextResponse.redirect(new URL(landingHref(tabs), request.url));
  }

  const tab = tabForPage(pathname);
  if (tab && !tabs.includes(tab)) {
    // `/` then lands them on a tab they do have, or on /welcome.
    return NextResponse.redirect(new URL('/', request.url));
  }

  // /welcome and any page outside every tab: signed in is enough.
  return NextResponse.next();
}

export const config = {
  // icon.png is app/icon.png, the browser-tab icon Next serves for every page.
  // Without it here the gate redirects the favicon request to /login, so the
  // browser is handed HTML where it asked for an image and the login page shows
  // the default globe — the one place the icon has to work before signing in.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|evs-logo.png).*)'],
};
