'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthField, AuthFrame, safeFrom } from '@/components/auth/AuthFrame';

function LoginForm() {
  const params = useSearchParams();
  const from = safeFrom(params.get('from'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).catch(() => null);

    if (res?.ok) {
      // A document navigation, not router.push: this page is reached BY a
      // middleware redirect, so the router's cached entry for the target IS
      // that redirect — pushing to it lands straight back here and the cookie
      // just set goes unused. A full load re-runs the middleware with it.
      window.location.assign(from);
    } else {
      const body = res ? await res.json().catch(() => ({})) : {};
      setError(body?.error || 'Incorrect email or password');
      setLoading(false);
    }
  }

  const signupHref = from === '/' ? '/signup' : `/signup?from=${encodeURIComponent(from)}`;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <AuthField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
        required
      />
      <AuthField
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="••••••••"
        required
      />

      {error && <div className="text-rust text-sm">{error}</div>}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 bg-ink text-paper hover:bg-ink-soft transition-colors smallcaps text-xs disabled:opacity-50"
      >
        {loading ? 'Signing in…' : 'Sign in'}
      </button>

      <p className="text-center text-ink-muted text-sm">
        No account?{' '}
        <Link href={signupHref} className="underline underline-offset-4 hover:text-ink">
          Create one
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthFrame heading="Reports" subtitle="Internal access only">
      <Suspense fallback={<div className="text-ink-muted text-sm text-center">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </AuthFrame>
  );
}
