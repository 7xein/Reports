'use client';

import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { TABS, normalizeEmail, type PublicUser, type TabId } from '@/lib/access';
import { ADMIN_SUB_TABS } from '../admin-sub-tabs';

const SHORT_LABEL: Record<TabId, string> = {
  wip: 'WIP',
  sales: 'Sales',
  kpi: 'KPI',
  evhub: 'EVHUB',
  ceo: 'CEO',
  admin: 'Admin',
};

const SELF_ADMIN_TITLE = "You can't remove your own Admin access";

function formatSignup(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    /* fall through */
  }
  return `Request failed (${res.status}).`;
}

function toggle(tabs: TabId[], tab: TabId, on: boolean): TabId[] {
  const set = new Set(tabs);
  if (on) set.add(tab);
  else set.delete(tab);
  return TABS.map((t) => t.id).filter((id) => set.has(id));
}

export function UsersAdmin({
  initialUsers,
  currentEmail,
  loadError,
}: {
  initialUsers: PublicUser[];
  currentEmail: string;
  loadError: string | null;
}) {
  const [users, setUsers] = useState<PublicUser[]>(initialUsers);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(loadError);
  const me = normalizeEmail(currentEmail);

  const setBusy = (key: string, busy: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });

  const applyTab = (email: string, tab: TabId, on: boolean) =>
    setUsers((prev) => prev.map((u) => (u.email === email ? { ...u, tabs: toggle(u.tabs, tab, on) } : u)));

  async function onToggle(user: PublicUser, tab: TabId, on: boolean) {
    const key = `${user.email}:${tab}`;
    const tabs = toggle(user.tabs, tab, on);
    setError(null);
    applyTab(user.email, tab, on);
    setBusy(key, true);
    try {
      const res = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, tabs }),
      });
      if (!res.ok) {
        applyTab(user.email, tab, !on);
        setError(await errorMessage(res));
      }
    } catch {
      applyTab(user.email, tab, !on);
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(key, false);
    }
  }

  async function onDelete(user: PublicUser) {
    if (!window.confirm(`Delete ${user.email}? They will be signed out and will need to sign up again.`)) return;
    const key = `${user.email}:delete`;
    setError(null);
    setBusy(key, true);
    try {
      const res = await fetch('/api/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });
      if (res.ok) setUsers((prev) => prev.filter((u) => u.email !== user.email));
      else setError(await errorMessage(res));
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(key, false);
    }
  }

  const onlyOwner = users.every((u) => u.isOwner);

  return (
    <Shell
      breadcrumbSection="Admin"
      breadcrumbPage="Users"
      subTabs={ADMIN_SUB_TABS}
      hero={{
        eyebrow: 'Admin Panel',
        title: 'User',
        titleEm: 'Access',
        sub: 'Tick the sections each person can open. Changes apply on their next click.',
      }}
    >
      <div className="bg-white rounded-lg shadow-sm p-6 mb-5">
        <h2 className="text-base font-bold uppercase tracking-wide text-ink mb-4">Users ({users.length})</h2>

        {error && <p className="text-rust text-sm mb-3" role="alert">{error}</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="py-2 pr-4 font-semibold">Name</th>
                <th className="py-2 pr-4 font-semibold whitespace-nowrap">Signed up</th>
                {TABS.map((t) => (
                  <th key={t.id} className="py-2 px-2 font-semibold text-center whitespace-nowrap" title={t.label}>
                    {SHORT_LABEL[t.id] ?? t.label}
                  </th>
                ))}
                <th className="py-2 pl-2 w-16" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isMe = normalizeEmail(u.email) === me;
                const waiting = !u.isOwner && u.tabs.length === 0;
                const deleting = pending.has(`${u.email}:delete`);
                return (
                  <tr key={u.email} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-ink">{u.name}</span>
                        {waiting && (
                          <span className="rounded-full bg-amber-100 text-amber-700 text-xs font-semibold px-2 py-0.5">
                            Waiting
                          </span>
                        )}
                      </div>
                      <div className="text-ink-muted">{u.email}</div>
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap text-ink-soft">{formatSignup(u.createdAt)}</td>
                    {TABS.map((t) => {
                      const selfAdmin = isMe && t.id === 'admin';
                      const busy = pending.has(`${u.email}:${t.id}`);
                      const disabled = u.isOwner || selfAdmin || busy || deleting;
                      return (
                        <td key={t.id} className="py-3 px-2 text-center">
                          <input
                            type="checkbox"
                            className="w-4 h-4 accent-evs-green cursor-pointer disabled:cursor-not-allowed"
                            checked={u.isOwner || u.tabs.includes(t.id)}
                            disabled={disabled}
                            title={selfAdmin && !u.isOwner ? SELF_ADMIN_TITLE : undefined}
                            aria-label={`${t.label} for ${u.name}`}
                            onChange={(e) => onToggle(u, t.id, e.target.checked)}
                          />
                        </td>
                      );
                    })}
                    <td className="py-3 pl-2 text-right whitespace-nowrap">
                      {u.isOwner ? (
                        <span className="rounded-full bg-evs-green/15 text-evs-green-dark text-xs font-semibold px-2 py-0.5">
                          Owner
                        </span>
                      ) : !isMe ? (
                        <button
                          type="button"
                          className="text-rust text-xs font-semibold hover:underline disabled:opacity-50"
                          disabled={deleting}
                          onClick={() => onDelete(u)}
                        >
                          Delete
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {onlyOwner && !loadError && (
          <p className="text-sm text-ink-muted mt-4">
            No one else has signed up yet. Share the site link — new people appear here after they create an account.
          </p>
        )}
      </div>
    </Shell>
  );
}
