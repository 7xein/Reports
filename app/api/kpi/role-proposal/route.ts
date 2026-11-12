/**
 * /api/kpi/role-proposal — KPI ownership refresh.
 *
 * (The path is kept from the old role proposal it replaces.)
 *
 *   GET  — the last refresh's report (owners with the counts behind them), read
 *          from the store without touching Odoo. `report` is null when none is
 *          stored yet.
 *   POST — refresh now: derive per-KPI, per-branch owners from the last 30 days
 *          of Odoo activity and write them straight into the stored KPI config.
 *          No approval step — the owner's decision. Returns the owners, the
 *          counts behind each, and any action that could not be read (whose
 *          KPIs keep their previous owners).
 *
 * The same refresh runs nightly from /api/sync-odoo.
 */

import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { refreshKpiOwners, lastKpiOwnersReport } from '@/lib/kpi-owners-refresh';

export const dynamic = 'force-dynamic';

// 300, not 60: the activity map is 30-odd Odoo calls, several of them chatter
// reads over tens of thousands of rows. It stops itself well inside this and
// reports which actions it never reached.
export const maxDuration = 300;

export async function GET() {
  if (!isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ report: await lastKpiOwnersReport() });
}

export async function POST() {
  if (!isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Ownership refresh failed', detail: `Missing environment variables: ${missing.join(', ')}` },
      { status: 500 },
    );
  }

  try {
    const result = await refreshKpiOwners();
    if (result.fatal) {
      return NextResponse.json(
        { ...result, error: 'Ownership refresh failed', detail: `${result.fatal} — the stored owners were left unchanged.` },
        { status: 502 },
      );
    }
    if (!result.saved) {
      return NextResponse.json(
        { ...result, error: 'Ownership refresh failed', detail: `Odoo was read, but the owners could not be saved: ${result.saveError ?? 'unknown error'}` },
        { status: 500 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('❌ [kpi/role-proposal] ownership refresh failed:', error);
    return NextResponse.json(
      { error: 'Ownership refresh failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
