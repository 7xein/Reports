'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get('from') || '/';
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      router.push(from);
      router.refresh();
    } else {
      setError('Incorrect password');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label htmlFor="password" className="block smallcaps text-[10px] text-ink-muted mb-2">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="w-full px-4 py-3 bg-white border border-rule focus:border-ink focus:outline-none font-sans text-ink transition-colors"
          placeholder="••••••••"
        />
      </div>

      {error && <div className="text-rust text-sm">{error}</div>}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 bg-ink text-paper hover:bg-ink-soft transition-colors smallcaps text-xs disabled:opacity-50"
      >
        {loading ? 'Signing in…' : 'Continue'}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-12">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/evs-logo-nobg.png"
            alt="EVS"
            style={{ height: '64px', width: 'auto', margin: '0 auto 24px' }}
          />
          <div className="smallcaps text-xs text-ink-muted mb-4">Electric Vehicle Services</div>
          <h1 className="font-display text-5xl font-light tracking-tight text-ink leading-none">
            Reports
          </h1>
          <div className="mt-6 mx-auto w-12 h-px bg-rule" />
          <p className="mt-6 text-ink-muted text-sm">Internal access only</p>
        </div>

        <Suspense fallback={<div className="text-ink-muted text-sm text-center">Loading…</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
