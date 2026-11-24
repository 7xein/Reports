import { redirect } from 'next/navigation';
import { effectiveTabs, landingHref } from '@/lib/access';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// The middleware answers `/` before this runs; this is the same rule as a
// fallback in case it ever does not.
export default async function RootPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirect(landingHref(effectiveTabs(user)));
}
