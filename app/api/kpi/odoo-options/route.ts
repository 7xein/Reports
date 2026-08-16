/**
 * GET /api/kpi/odoo-options
 *
 * Live option lists for the admin KPI config dropdowns: priority-matrix values,
 * repair stages, tags, and SA-roster candidates — plus a fields_get report so the
 * admin can see which repair.order fields this instance actually has.
 */

import { NextResponse } from 'next/server';
import { fetchKpiOdooOptions } from '@/lib/odoo';
import { isAdminAuthenticated } from '@/lib/auth';

export const maxDuration = 60;

export async function GET() {
  if (!isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Failed to load options', detail: `Missing environment variables: ${missing.join(', ')}` },
      { status: 500 }
    );
  }

  try {
    return NextResponse.json(await fetchKpiOdooOptions());
  } catch (error) {
    console.error('❌ [kpi/odoo-options] failed:', error);
    return NextResponse.json(
      { error: 'Failed to load options', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
