'use client';

import { useState } from 'react';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.assign('/login');
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="smallcaps text-xs text-ink-muted hover:text-ink underline underline-offset-4 transition-colors disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
