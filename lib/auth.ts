import { cookies } from 'next/headers';

const SITE_COOKIE = 'evs_auth';
const ADMIN_COOKIE = 'evs_admin_auth';
const COOKIE_VALUE = 'authenticated';

export function getSitePassword(): string {
  return 'evs2026';
}

export function getAdminPassword(): string {
  return 'H1u$$230';
}

export function isAuthenticated(): boolean {
  const cookieStore = cookies();
  return cookieStore.get(SITE_COOKIE)?.value === COOKIE_VALUE;
}

export function isAdminAuthenticated(): boolean {
  const cookieStore = cookies();
  return cookieStore.get(ADMIN_COOKIE)?.value === COOKIE_VALUE;
}

export function setAuthCookie(): void {
  cookies().set(SITE_COOKIE, COOKIE_VALUE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
}

export function setAdminAuthCookie(): void {
  cookies().set(ADMIN_COOKIE, COOKIE_VALUE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
}

export function clearAuthCookies(): void {
  cookies().delete(SITE_COOKIE);
  cookies().delete(ADMIN_COOKIE);
}
