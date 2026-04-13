'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

export default function AdminLoginPage() {
  const router = useRouter();
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
      body: JSON.stringify({ password, type: 'admin' }),
    });

    if (res.ok) {
      router.push('/admin');
      router.refresh();
    } else {
      setError('Incorrect admin password');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-12">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/evs-logo-nobg.png" alt="EVS" style={{ height: '64px', width: 'auto', margin: '0 auto 24px' }} />
          <div className="smallcaps text-xs text-ink-muted mb-4">Admin Access</div>
          <h1 className="font-display text-5xl font-light tracking-tight text-ink leading-none">
            Restricted
          </h1>
          <div className="mt-6 mx-auto w-12 h-px bg-evs-green" />
          <p className="mt-6 text-ink-muted text-sm">Admin password required</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="password" className="block smallcaps text-[10px] text-ink-muted mb-2">
              Admin Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              className="w-full px-4 py-3 bg-white border border-rule focus:border-evs-green focus:outline-none font-sans text-ink transition-colors"
              placeholder="••••••••"
            />
          </div>

          {error && <div className="text-rust text-sm">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-evs-green text-white hover:bg-evs-green-dark transition-colors smallcaps text-xs disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Enter Admin'}
          </button>
        </form>
      </div>
    </div>
  );
}
