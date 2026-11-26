/**
 * /api/companies — Admin only.
 *
 *   GET   → every configured site (grouped by branch, BRANCH_CLUSTERS order)
 *           with the Odoo company it resolves to and how — a stored link, a
 *           name match, or not found — plus every Odoo company, sorted by name.
 *   PATCH { label, odooCompanyId } → link that site to that Odoo company by id.
 *           Returns the same body as GET, freshly resolved.
 *
 * A relink drops what would keep serving the old figure: this instance's
 * company resolution, the report registry and the shared population memos
 * behind it, and every cached KPI tree in Redis. Other warm instances keep
 * their in-memory copies until those expire (5 minutes for the companies,
 * 10 for a report build).
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { configuredSites, invalidateCompanyIds, readOdooCompanies, resolveCompanies } from '@/lib/odoo';
import { CompanyLinkStoreError, setCompanyLink } from '@/lib/company-links-store';
import { cleanCompanyId, toCompaniesResponse } from '@/lib/company-links';
import { clearReportCaches } from '@/lib/reports';
import { getRedis } from '@/lib/user-record';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ODOO_ENV = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];

function missingOdooEnv(): NextResponse | null {
  const missing = ODOO_ENV.filter((k) => !process.env[k]);
  return missing.length
    ? NextResponse.json({ error: `Odoo is not configured (missing ${missing.join(', ')}).` }, { status: 500 })
    : null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Delete every cached KPI tree. app/api/kpi/route.ts caches each week under
 * `kpi:{weekStart}:{configVersion}` for 15 minutes, and a tree computed while a
 * site was unresolved would otherwise keep that site at zero until it expires.
 * Best effort: a failure here never fails the relink.
 */
async function clearKpiTreeCache(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    let cursor: string = '0';
    // Bounded: the keyspace is small, and a runaway scan must not hold the request.
    for (let i = 0; i < 50; i++) {
      const [next, keys] = await redis.scan(cursor, { match: 'kpi:*', count: 500 });
      if (keys.length) await redis.del(...keys);
      cursor = String(next);
      if (cursor === '0') break;
    }
  } catch (e) {
    console.warn('[api/companies] could not clear the KPI cache — it expires within 15 minutes:', e);
  }
}

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const envError = missingOdooEnv();
  if (envError) return envError;

  try {
    return NextResponse.json(toCompaniesResponse(await resolveCompanies({ fresh: true })));
  } catch (error) {
    console.error('❌ [api/companies] GET failed:', error);
    return NextResponse.json({ error: `Could not read the companies from Odoo: ${errText(error)}` }, { status: 502 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const envError = missingOdooEnv();
  if (envError) return envError;

  let body: { label?: unknown; odooCompanyId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const label = typeof body?.label === 'string' ? body.label : '';
  if (!configuredSites().some((s) => s.label === label)) {
    return NextResponse.json({ error: 'That site is not one of the configured sites.' }, { status: 400 });
  }
  const odooCompanyId = cleanCompanyId(body?.odooCompanyId);
  if (odooCompanyId == null) {
    return NextResponse.json({ error: 'Pick an Odoo company.' }, { status: 400 });
  }

  try {
    const companies = await readOdooCompanies();
    if (!companies.some((c) => c.id === odooCompanyId)) {
      return NextResponse.json({ error: `Company #${odooCompanyId} is not in Odoo. Refresh the page and pick again.` }, { status: 400 });
    }
  } catch (error) {
    console.error('❌ [api/companies] could not read Odoo companies:', error);
    return NextResponse.json({ error: `Could not read the companies from Odoo: ${errText(error)}` }, { status: 502 });
  }

  try {
    await setCompanyLink(label, odooCompanyId);
  } catch (error) {
    const status = error instanceof CompanyLinkStoreError && !getRedis() ? 503 : 500;
    return NextResponse.json({ error: error instanceof CompanyLinkStoreError ? error.message : 'Could not save the link.' }, { status });
  }

  invalidateCompanyIds();
  clearReportCaches();
  await clearKpiTreeCache();

  try {
    return NextResponse.json(toCompaniesResponse(await resolveCompanies({ fresh: true })));
  } catch (error) {
    console.error('❌ [api/companies] reload after save failed:', error);
    return NextResponse.json(
      { error: 'The link was saved, but the companies could not be reloaded from Odoo. Refresh the page.' },
      { status: 502 },
    );
  }
}
