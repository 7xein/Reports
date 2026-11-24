'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthField, AuthFrame, safeFrom } from '@/components/auth/AuthFrame';

const MIN_PASSWORD_LENGTH = 8;

function SignupForm() {
  const params = useSearchParams();
  const from = safeFrom(params.get('from'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // The server checks these too; checking here saves a round trip.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    }).catch(() => null);

    if (res?.ok) {
      // A document navigation, not router.push: this page is reached BY a
      // middleware redirect, so the router's cached entry for the target IS
      // that redirect — pushing to it lands straight back here and the cookie
      // just set goes unused. A full load re-runs the middleware with it.
      window.location.assign(from);
    } else {
      const body = res ? await res.json().catch(() => ({})) : {};
      setError(body?.error || 'Could not create the account.');
      setLoading(false);
    }
  }

  const loginHref = from === '/' ? '/login' : `/login?from=${encodeURIComponent(from)}`;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <AuthField
        id="name"
        label="Name"
        type="text"
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        required
      />
      <AuthField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <AuthField
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 8 characters"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <AuthField
        id="confirm"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />

      {error && <div className="text-rust text-sm">{error}</div>}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 bg-ink text-paper hover:bg-ink-soft transition-colors smallcaps text-xs disabled:opacity-50"
      >
        {loading ? 'Creating account…' : 'Create account'}
      </button>

      <p className="text-center text-ink-muted text-sm">
        Already have an account?{' '}
        <Link href={loginHref} className="underline underline-offset-4 hover:text-ink">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function SignupPage() {
  return (
    <AuthFrame heading="Create account" subtitle="Internal access only">
      <Suspense fallback={<div className="text-ink-muted text-sm text-center">Loading…</div>}>
        <SignupForm />
      </Suspense>
    </AuthFrame>
  );
}
