'use client';

import { useEffect, useRef, useState } from 'react';
import { getSubBranches, subKey, parseScope, scopeLabel, isGroupScope } from '@/lib/types';

export const BRANCH_COLORS: Record<string, string> = {
  'All Branches': '#78C41A',
  Dubai:    '#78C41A',
  Ajman:    '#3B82F6',
  Sharjah:  '#F59E0B',
  'Abu Dhabi': '#8B5CF6',
  'Al Ain': '#EF4444',
  Qatar:    '#06B6D4',
  'EV Hub': '#EC4899',
};

/** The "All Branches" pill's menu, offered only when `groupScopes` is on. */
const GROUP_OPTIONS: readonly { scope: string; label: string }[] = [
  { scope: 'all',      label: 'All branches and stations' },
  { scope: 'branches', label: 'Branches only' },
  { scope: 'stations', label: 'Stations only' },
];

/**
 * "Branch:" pill row. One scope: 'all', a branch name, or a `${branch}__${station}` key.
 * Branches with stations split into pill + chevron that opens a station menu.
 */
export function BranchScopePicker({
  branches,
  scope,
  onChange,
  className = 'mb-4',
  groupScopes = false,
}: {
  branches: readonly string[];
  scope: string;
  onChange: (scope: string) => void;
  /** Outer spacing; the WIP page keeps its mb-4, stacked layouts pass ''. */
  className?: string;
  /**
   * Offer 'branches' / 'stations' on the "All Branches" pill. Off by default:
   * the WIP page resolves a scope against its own per-branch values and has no
   * reading for a scope that names no branch.
   */
  groupScopes?: boolean;
}) {
  // Branch whose station menu is open — a single slot, so only one menu is ever open.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const pillRowRef = useRef<HTMLDivElement>(null);

  // The station menu is a popover: a mousedown outside the pill row, or Escape, dismisses it.
  useEffect(() => {
    if (!openMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!pillRowRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  const { branch: scopeBranch, sub: scopeSub } = parseScope(scope);

  return (
    <div ref={pillRowRef} className={`flex flex-wrap items-center gap-2${className ? ` ${className}` : ''}`}>
      <span className="text-sm font-semibold text-ink-muted mr-1">Branch:</span>
      {['all', ...branches].map((b) => {
        const isAll    = b === 'all';
        // A branch stays "active" while any of its stations is the scope, and the
        // "All Branches" pill while either group is.
        const active   = isAll ? scope === 'all' || isGroupScope(scope) : scopeBranch === b;
        const color    = BRANCH_COLORS[isAll ? 'All Branches' : b] ?? '#78C41A';
        const stations = isAll ? [] : getSubBranches(b);
        const hasMenu  = isAll ? groupScopes : stations.length > 0;
        const menuOpen = openMenu === b;
        // The pill names the live scope, so a drilled-in station or group replaces the branch name on it.
        const pillLabel = isAll
          ? (isGroupScope(scope) ? scopeLabel(scope) : 'All Branches')
          : (active && scopeSub ? scopeSub : b);

        return (
          <div key={b} className="relative inline-flex">
            <button
              onClick={() => { onChange(b); setOpenMenu(null); }}
              className={`text-sm font-semibold px-4 py-1.5 ${hasMenu ? 'rounded-l-full pr-3' : 'rounded-full'} border transition-all ${
                active
                  ? 'text-white border-transparent shadow-sm'
                  : 'bg-white text-ink-muted border-border hover:border-gray-400'
              }`}
              style={active ? { backgroundColor: color, borderColor: color } : {}}
            >
              {pillLabel}
            </button>

            {hasMenu && (
              <button
                onClick={() => setOpenMenu(menuOpen ? null : b)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={isAll ? 'Choose which branches to include' : `Choose a station in ${b}`}
                className={`rounded-r-full pl-1.5 pr-2.5 py-1.5 border border-l-0 transition-all ${
                  active
                    ? 'text-white border-transparent shadow-sm'
                    : 'bg-white text-ink-muted border-border hover:border-gray-400'
                }`}
                style={active ? { backgroundColor: color, borderColor: color } : {}}
              >
                <svg
                  className={`h-3 w-3 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
                  viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8"
                >
                  <path d="M2.5 4.5L6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}

            {menuOpen && (
              <div className="absolute z-20 top-full mt-1 left-0 min-w-[210px] bg-white border border-border rounded-lg shadow-lg py-1">
                {isAll ? (
                  GROUP_OPTIONS.map((opt) => (
                    <button
                      key={opt.scope}
                      onClick={() => { onChange(opt.scope); setOpenMenu(null); }}
                      className={`w-full text-left px-3 py-1.5 text-sm whitespace-nowrap hover:bg-surface cursor-pointer ${
                        scope === opt.scope ? 'font-semibold text-evs-green-dark' : ''
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))
                ) : (
                  <>
                    {/* Header keeps the branch name, which the pill gives up while a station is scoped */}
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-muted border-b border-border">
                      {b}
                    </div>
                    <button
                      onClick={() => { onChange(b); setOpenMenu(null); }}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface cursor-pointer ${
                        scope === b ? 'font-semibold text-evs-green-dark' : ''
                      }`}
                    >
                      Whole branch
                    </button>
                    {stations.map((s) => {
                      const stationScope = subKey(b, s);
                      return (
                        <button
                          key={s}
                          onClick={() => { onChange(stationScope); setOpenMenu(null); }}
                          className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface cursor-pointer ${
                            scope === stationScope ? 'font-semibold text-evs-green-dark' : ''
                          }`}
                        >
                          {s}
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
