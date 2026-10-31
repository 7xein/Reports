'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

const CRAWL_MS = 7000;     // 0 -> ~85% while waiting for the next page
const FINISH_MS = 200;     // jump to 100% and fade out
const SAFETY_MS = 20000;   // give up and hide if the route never changes

// Thin top-of-page bar that starts on an internal link click and completes
// when the URL (pathname or search) changes.
export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const barRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(false);
  const timers = useRef<number[]>([]);

  function clearTimers() {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }

  function hide() {
    const bar = barRef.current;
    activeRef.current = false;
    clearTimers();
    if (!bar) return;
    bar.style.transition = 'none';
    bar.style.opacity = '0';
    bar.style.width = '0%';
  }

  function finish() {
    const bar = barRef.current;
    if (!activeRef.current || !bar) return;
    activeRef.current = false;
    clearTimers();
    bar.style.transition = `width ${FINISH_MS}ms ease-out, opacity ${FINISH_MS}ms ease-out ${FINISH_MS}ms`;
    bar.style.width = '100%';
    bar.style.opacity = '0';
    timers.current.push(window.setTimeout(hide, FINISH_MS * 2 + 50));
  }

  function start() {
    const bar = barRef.current;
    if (!bar) return;
    clearTimers();
    activeRef.current = true;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    bar.style.opacity = '1';
    // Force a reflow so the 0% width is committed before the crawl starts.
    void bar.offsetWidth;
    bar.style.transition = `width ${CRAWL_MS}ms cubic-bezier(0.08, 0.7, 0.2, 1)`;
    bar.style.width = '85%';
    timers.current.push(window.setTimeout(hide, SAFETY_MS));
  }

  // Start on clicks to same-origin links that lead somewhere else.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const a = target?.closest?.('a');
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.hasAttribute('download')) return;
      const t = a.getAttribute('target');
      if (t && t !== '_self') return;
      const raw = a.getAttribute('href');
      if (!raw) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same path + search means a no-op or a hash-only change.
      if (url.pathname + url.search === window.location.pathname + window.location.search) return;
      start();
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Complete when the route changes.
  const search = searchParams.toString();
  useEffect(() => {
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => clearTimers, []);

  return (
    <div
      ref={barRef}
      aria-hidden="true"
      className="fixed top-0 left-0 z-[60] h-[3px] bg-evs-green pointer-events-none"
      style={{ width: '0%', opacity: 0, boxShadow: '0 0 8px rgba(120,196,26,.6)' }}
    />
  );
}
