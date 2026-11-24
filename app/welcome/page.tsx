import { redirect } from 'next/navigation';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { effectiveTabs } from '@/lib/access';
import { getCurrentUser } from '@/lib/auth';
import { SignOutButton } from './SignOutButton';

export const dynamic = 'force-dynamic';

/** Where a signed-in account with no tabs lands (see middleware `/`). */
export default async function WelcomePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login?from=/welcome');

  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  const hasAccess = effectiveTabs(user).length > 0;

  return (
    <AuthFrame heading={`Welcome, ${firstName}`}>
      <div className="space-y-5 text-center">
        {hasAccess ? (
          // A plain link, not next/link: `/` is decided by the middleware, so it
          // needs a real request.
          <a
            href="/"
            className="block w-full py-3 bg-ink text-paper hover:bg-ink-soft transition-colors smallcaps text-xs"
          >
            Go to dashboard
          </a>
        ) : (
          <>
            <p className="text-ink text-sm">
              Your account ({user.email}) is set up, but you don&apos;t have access to any section yet.
            </p>
            <p className="text-ink-muted text-sm">
              Contact Hussein and he will give you access to what you need.
            </p>
          </>
        )}
        <div className="pt-2">
          <SignOutButton />
        </div>
      </div>
    </AuthFrame>
  );
}
