'use client';

import { useEffect, useRef, useState } from 'react';
import { Shell } from '@/components/Shell';
import { TABS, normalizeEmail, type BranchAccess, type PublicUser, type TabId } from '@/lib/access';
import { BRANCHES, type Branch } from '@/lib/types';
import type { KpiPersonOption } from '@/lib/user-admin';
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

const ADMIN_BRANCHES_TITLE = 'Admin access includes every branch';
const NO_BRANCHES_TITLE = 'They will see empty pages until you pick a branch';
const POPOVER_MIN_WIDTH = 200;

function branchLabel(access: BranchAccess): string {
  if (access === 'all') return 'All branches';
  if (access.length === 0) return 'No branches';
  if (access.length <= 2) return access.join(', ');
  return `${access.length} branches`;
}

function toggleBranch(access: BranchAccess, branch: Branch, on: boolean): Branch[] {
  const set = new Set<Branch>(access === 'all' ? BRANCHES : access);
  if (on) set.add(branch);
  else set.delete(branch);
  return BRANCHES.filter((b) => set.has(b));
}

function Chevron() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A cell's button-and-popover mechanics, shared by the Branches and KPIs
 * cells. The popover is position: fixed (from the button's rect) so the
 * table's overflow-x-auto wrapper cannot clip it; it closes on outside click,
 * Escape, scroll or resize, since a fixed popover would otherwise drift.
 */
function useCellPopover(locked: boolean) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const open = pos !== null && !locked;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        buttonRef.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (popoverRef.current && e.target instanceof Node && popoverRef.current.contains(e.target)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  function toggleOpen() {
    if (open) {
      setPos(null);
      return;
    }
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const maxLeft = Math.max(8, window.innerWidth - POPOVER_MIN_WIDTH - 24);
    setPos({ top: r.bottom + 4, left: Math.min(r.left, maxLeft) });
  }

  return { pos, open, buttonRef, popoverRef, toggleOpen };
}

/** The locked button an owner or Admin row shows in place of a picker. */
function AdminLockedButton({ title }: { title: string }) {
  return (
    <button
      type="button"
      disabled
      title={title}
      className="inline-flex items-center gap-1 border border-border rounded text-sm px-2 py-1 whitespace-nowrap text-ink-muted cursor-not-allowed"
    >
      All (Admin)
      <Chevron />
    </button>
  );
}

/** The Branches cell: a button showing the access, opening a popover of checkboxes. */
function BranchPicker({
  user,
  adminLocked,
  busy,
  disabled,
  onChange,
}: {
  user: PublicUser;
  adminLocked: boolean;
  busy: boolean;
  disabled: boolean;
  onChange: (access: BranchAccess) => void;
}) {
  const { pos, open, buttonRef, popoverRef, toggleOpen } = useCellPopover(adminLocked);

  if (adminLocked) {
    return <AdminLockedButton title={ADMIN_BRANCHES_TITLE} />;
  }

  const access = user.branches;
  const none = access !== 'all' && access.length === 0;
  const title =
    access === 'all' ? 'Every branch, including ones added in future' : none ? NO_BRANCHES_TITLE : access.join(', ');
  const ticked = (b: Branch) => access === 'all' || access.includes(b);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Branches for ${user.name}: ${branchLabel(access)}`}
        disabled={disabled}
        onClick={toggleOpen}
        className={`inline-flex items-center gap-1 border rounded text-sm px-2 py-1 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
          none ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-border text-ink'
        }`}
      >
        {branchLabel(access)}
        <Chevron />
      </button>
      {open && pos && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`Branches for ${user.name}`}
          className="fixed z-20 bg-white shadow-lg rounded-lg p-3 min-w-[200px] text-left"
          style={{ top: pos.top, left: pos.left }}
        >
          <label className="flex items-center gap-2 py-1 font-bold text-ink cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-evs-green cursor-pointer disabled:cursor-not-allowed"
              checked={access === 'all'}
              disabled={busy}
              onChange={(e) => onChange(e.target.checked ? 'all' : [...BRANCHES])}
            />
            All branches
          </label>
          <div className="border-t border-border my-2" />
          <p className="text-xs text-ink-muted mb-1">All includes branches added in future</p>
          {BRANCHES.map((b) => (
            <label key={b} className="flex items-center gap-2 py-1 text-ink cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-evs-green cursor-pointer disabled:cursor-not-allowed"
                checked={ticked(b)}
                disabled={busy}
                onChange={(e) => onChange(toggleBranch(access, b, e.target.checked))}
              />
              {b}
            </label>
          ))}
        </div>
      )}
    </>
  );
}

const ADMIN_KPIS_TITLE = 'Admin access includes every KPI';
const UNKNOWN_PERSON_TITLE = 'No longer on the KPI roster — they will see no KPIs until you pick someone';

/**
 * The KPIs cell: whose KPIs the user sees on the KPI tab — "All KPIs" or one
 * person from the KPI roster. Same button and popover as the Branches cell,
 * with radios and a name search in place of checkboxes.
 */
function KpiPersonPicker({
  user,
  people,
  adminLocked,
  busy,
  disabled,
  onChange,
}: {
  user: PublicUser;
  people: KpiPersonOption[];
  adminLocked: boolean;
  busy: boolean;
  disabled: boolean;
  onChange: (odooUserId: number | null) => void;
}) {
  const { pos, open, buttonRef, popoverRef, toggleOpen } = useCellPopover(adminLocked);
  const [query, setQuery] = useState('');

  // A fresh search each time the popover opens.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (adminLocked) {
    return <AdminLockedButton title={ADMIN_KPIS_TITLE} />;
  }

  const selected = user.kpiPerson;
  const person = selected === null ? null : people.find((p) => p.odooUserId === selected) ?? null;
  const unknown = selected !== null && !person;
  const label = selected === null ? 'All KPIs' : person ? person.name : 'Unknown person';
  const title =
    selected === null
      ? "Every person's KPIs, in the branches they can see"
      : person
        ? `Only ${person.name}'s KPIs${person.branches.length ? ` · ${person.branches.join(', ')}` : ''}`
        : UNKNOWN_PERSON_TITLE;
  const q = query.trim().toLowerCase();
  const shown = q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
  const group = `kpi-person-${user.email}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`KPIs for ${user.name}: ${label}`}
        disabled={disabled}
        onClick={toggleOpen}
        className={`inline-flex items-center gap-1 border rounded text-sm px-2 py-1 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
          unknown ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-border text-ink'
        }`}
      >
        {label}
        <Chevron />
      </button>
      {open && pos && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`KPIs for ${user.name}`}
          className="fixed z-20 bg-white shadow-lg rounded-lg p-3 min-w-[200px] text-left"
          style={{ top: pos.top, left: pos.left }}
        >
          <label className="flex items-center gap-2 py-1 font-bold text-ink cursor-pointer">
            <input
              type="radio"
              name={group}
              className="w-4 h-4 accent-evs-green cursor-pointer disabled:cursor-not-allowed"
              checked={selected === null}
              disabled={busy}
              onChange={() => onChange(null)}
            />
            All KPIs
          </label>
          <div className="border-t border-border my-2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name"
            aria-label="Search people by name"
            className="w-full border border-border rounded text-sm px-2 py-1 mb-1 text-ink"
          />
          <div className="max-h-64 overflow-y-auto">
            {shown.map((p) => (
              <label key={p.odooUserId} className="flex items-center gap-2 py-1 text-ink cursor-pointer">
                <input
                  type="radio"
                  name={group}
                  className="w-4 h-4 accent-evs-green cursor-pointer disabled:cursor-not-allowed"
                  checked={selected === p.odooUserId}
                  disabled={busy}
                  onChange={() => onChange(p.odooUserId)}
                />
                <span className="whitespace-nowrap">{p.name}</span>
                {p.branches.length > 0 && (
                  <span className="text-xs text-ink-muted whitespace-nowrap">{p.branches.join(', ')}</span>
                )}
              </label>
            ))}
            {shown.length === 0 && (
              <p className="text-xs text-ink-muted py-1">
                {people.length === 0 ? 'No one is on the KPI roster yet.' : 'No one matches.'}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function UsersAdmin({
  initialUsers,
  kpiPeople,
  currentEmail,
  loadError,
}: {
  initialUsers: PublicUser[];
  kpiPeople: KpiPersonOption[];
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

  const applyBranches = (email: string, branches: BranchAccess) =>
    setUsers((prev) => prev.map((u) => (u.email === email ? { ...u, branches } : u)));

  async function onBranches(user: PublicUser, branches: BranchAccess) {
    const key = `${user.email}:branches`;
    const previous = user.branches;
    setError(null);
    applyBranches(user.email, branches);
    setBusy(key, true);
    try {
      const res = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, branches }),
      });
      if (!res.ok) {
        applyBranches(user.email, previous);
        setError(await errorMessage(res));
      }
    } catch {
      applyBranches(user.email, previous);
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(key, false);
    }
  }

  const applyKpiPerson = (email: string, kpiPerson: number | null) =>
    setUsers((prev) => prev.map((u) => (u.email === email ? { ...u, kpiPerson } : u)));

  async function onKpiPerson(user: PublicUser, kpiPerson: number | null) {
    const key = `${user.email}:kpiPerson`;
    const previous = user.kpiPerson;
    setError(null);
    applyKpiPerson(user.email, kpiPerson);
    setBusy(key, true);
    try {
      const res = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, kpiPerson }),
      });
      if (!res.ok) {
        applyKpiPerson(user.email, previous);
        setError(await errorMessage(res));
      }
    } catch {
      applyKpiPerson(user.email, previous);
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
        sub: 'Tick the sections and branches each person can open. Changes apply on their next click.',
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
                <th className="py-2 px-2 font-semibold whitespace-nowrap">Branches</th>
                <th className="py-2 px-2 font-semibold whitespace-nowrap">KPIs</th>
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
                    <td className="py-3 px-2">
                      <BranchPicker
                        user={u}
                        adminLocked={u.isOwner || u.tabs.includes('admin')}
                        busy={pending.has(`${u.email}:branches`)}
                        disabled={deleting}
                        onChange={(b) => onBranches(u, b)}
                      />
                    </td>
                    <td className="py-3 px-2">
                      <KpiPersonPicker
                        user={u}
                        people={kpiPeople}
                        adminLocked={u.isOwner || u.tabs.includes('admin')}
                        busy={pending.has(`${u.email}:kpiPerson`)}
                        disabled={deleting}
                        onChange={(id) => onKpiPerson(u, id)}
                      />
                    </td>
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
