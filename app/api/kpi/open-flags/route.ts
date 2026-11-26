/**
 * GET /api/kpi/open-flags — Admin only.
 *
 * Every KPI verdict failing in the CURRENT week, uncapped, as an .xlsx
 * (kpi-open-flags-<YYYY-MM-DD>.xlsx). Computed with the KPI start date ignored,
 * so it captures the carry-over from before the date even when downloaded after
 * the date has been set. Never cached: it is a one-off snapshot for the reset.
 * See lib/kpi-open-flags.ts.
 */

import { NextResponse } from 'next/server';
import { getCurrentUser, hasAnyTab } from '@/lib/auth';
import { readData } from '@/lib/data-store';
import { withKpiDefaults } from '@/lib/types';
import { computeOpenFlags, openFlagsWorkbook, gulfDate } from '@/lib/kpi-open-flags';

export const dynamic = 'force-dynamic';

// Same budget as /api/kpi: this is a full KPI compute plus one repair-order read.
export const maxDuration = 300;

export async function GET() {
  // Same rule as the middleware (lib/access.ts tabsForApi).
  const user = await getCurrentUser();
  if (!hasAnyTab(user, ['admin'])) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Open flags export failed', detail: `Missing environment variables: ${missing.join(', ')}` },
      { status: 500 },
    );
  }

  try {
    const data = await readData();
    const config = withKpiDefaults(data.kpiConfig);
    const flags = await computeOpenFlags(config);
    const buffer = openFlagsWorkbook(flags);
    const filename = `kpi-open-flags-${gulfDate(flags.generatedAt)}.xlsx`;
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('❌ [api/kpi/open-flags] failed:', error);
    return NextResponse.json(
      { error: 'Open flags export failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
