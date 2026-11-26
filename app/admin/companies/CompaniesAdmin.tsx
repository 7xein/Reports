'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import type { CompaniesResponse, CompanyLinkHow, CompanySiteRow } from '@/lib/company-links';
import { ADMIN_SUB_TABS } from '../admin-sub-tabs';

const STATUS: Record<CompanyLinkHow, { label: string; cls: string }> = {
  link:    { label: 'Linked',            cls: 'bg-evs-green/15 text-evs-green-dark' },
  name:    { label: 'Matched by name',   cls: 'bg-amber-100 text-amber-700' },
  missing: { label: 'Not found in Odoo', cls: 'bg-danger/10 text-danger-dark' },
};

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    /* fall through */
  }
  return `Request failed (${res.status}).`;
}

export function CompaniesAdmin() {
  const [data, setData] = useState<CompaniesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The relink in flight: which site, and the company picked for it. */
  const [saving, setSaving] = useState<{ label: string; id: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/companies', { cache: 'no-store' });
        if (!res.ok) throw new Error(await errorMessage(res));
        const body = (await res.json()) as CompaniesResponse;
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function relink(site: CompanySiteRow, odooCompanyId: number) {
    setSaving({ label: site.label, id: odooCompanyId });
    setMessage(null);
    try {
      const res = await fetch('/api/companies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: site.label, odooCompanyId }),
      });
      if (!res.ok) {
        setMessage(await errorMessage(res));
        return;
      }
      const body = (await res.json()) as CompaniesResponse;
      setData(body);
      const company = body.companies.find((c) => c.id === odooCompanyId);
      setMessage(`✓ Saved — ${site.label} is linked to ${company?.name ?? 'Odoo company'} (#${odooCompanyId}).`);
    } catch {
      setMessage('Could not reach the server. Please try again.');
    } finally {
      setSaving(null);
    }
  }

  const missing = data?.sites.filter((s) => s.how === 'missing').length ?? 0;

  return (
    <Shell
      breadcrumbSection="Admin"
      breadcrumbPage="Companies"
      subTabs={ADMIN_SUB_TABS}
      hero={{
        eyebrow: 'Admin Panel',
        title: 'Odoo',
        titleEm: 'Companies',
        sub: 'Link each dashboard site to its company in Odoo.',
      }}
    >
      <div className="bg-white rounded-lg shadow-sm p-6 mb-5">
        <h2 className="text-base font-bold uppercase tracking-wide text-ink">Odoo companies</h2>
        <p className="text-sm text-ink-muted mt-1 mb-5">
          Each site is linked to its Odoo company by ID, so renaming a company in Odoo no longer breaks the
          dashboards. If a site shows Not found, pick its company here.
        </p>

        {loading && <div className="text-sm text-ink-muted mb-4">Loading companies from Odoo…</div>}
        {loadError && (
          <div className="mb-4 px-4 py-2.5 bg-danger/5 border border-danger/20 rounded-md text-sm text-danger" role="alert">
            Could not load the companies: {loadError}
          </div>
        )}
        {missing > 0 && (
          <div className="mb-4 px-4 py-2.5 bg-danger/5 border border-danger/20 rounded-md text-sm text-danger" role="alert">
            These sites show no data until linked
          </div>
        )}

        {data && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th className="py-2 pr-4 font-semibold">Branch</th>
                  <th className="py-2 pr-4 font-semibold">Site</th>
                  <th className="py-2 pr-4 font-semibold">Odoo company</th>
                  <th className="py-2 pr-4 font-semibold">Status</th>
                  <th className="py-2 font-semibold">Relink</th>
                </tr>
              </thead>
              <tbody>
                {data.sites.map((s) => {
                  const pending = saving?.label === s.label;
                  const status = STATUS[s.how];
                  return (
                    <tr key={`${s.branch}:${s.label}`} className="border-b border-border last:border-0">
                      <td className="py-3 pr-4 whitespace-nowrap text-ink-soft">{s.branch}</td>
                      <td className="py-3 pr-4">
                        <span className="font-bold text-ink">{s.label}</span>
                        {s.main && <span className="ml-2 text-[11px] text-ink-muted whitespace-nowrap">main site</span>}
                      </td>
                      <td className="py-3 pr-4">
                        {s.odooName != null ? (
                          <>
                            <span className="text-ink">{s.odooName}</span>{' '}
                            <span className="text-ink-muted">#{s.linkedId}</span>
                          </>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap">
                        <span className={`rounded-full text-xs font-semibold px-2 py-0.5 ${status.cls}`}>{status.label}</span>
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <select
                            value={pending ? saving.id : s.linkedId ?? ''}
                            disabled={saving !== null}
                            aria-label={`Odoo company for ${s.label}`}
                            onChange={(e) => {
                              const id = Number(e.target.value);
                              if (Number.isInteger(id) && id > 0 && id !== s.linkedId) relink(s, id);
                            }}
                            className="text-sm border border-border rounded px-2 py-1 text-ink bg-white disabled:opacity-40 max-w-[18rem]"
                          >
                            {s.linkedId == null && !pending && <option value="" disabled>Pick a company…</option>}
                            {data.companies.map((c) => (
                              <option key={c.id} value={c.id}>{c.name} (#{c.id})</option>
                            ))}
                          </select>
                          {pending && <span className="text-xs text-ink-muted whitespace-nowrap">Saving…</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {message && (
          <div className={`mt-4 text-sm font-semibold ${message.startsWith('✓') ? 'text-evs-green-dark' : 'text-danger'}`}>
            {message}
          </div>
        )}
      </div>
    </Shell>
  );
}
