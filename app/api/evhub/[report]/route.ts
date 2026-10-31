/**
 * GET /api/evhub/{report}?days=30|60|90[&scope=Dubai|Dubai__Emarat - Altwar][&refresh=1][&format=xlsx]
 *
 * One EVHUB report — columns, rows, summary tiles and notes in the shared
 * ReportResult shape (lib/reports/types.ts).
 *
 * `report`  one of the REPORTS slugs; anything else is a 404.
 * `days`    lookback for windowed reports; anything not in WINDOW_OPTIONS falls
 *           back to DEFAULT_WINDOW_DAYS. Unwindowed reports ignore it.
 * `scope`   filters rows and summary to a branch or a station
 *           (`${branch}__${station}`, lib/types.ts subKey) — branch-scoped
 *           reports only. Anything the report does not cover means 'all'
 *           (validated in getReport). Every reachable scope's summary tiles
 *           come back in `summaries` regardless.
 * `refresh` 1 rebuilds from Odoo instead of serving the 10-minute in-memory
 *           cache (lib/reports/index.ts).
 * `format`  xlsx downloads the same result as a workbook.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { readData } from '@/lib/data-store';
import { withKpiDefaults } from '@/lib/types';
import { selectorDomainNot } from '@/lib/kpi';
import { getReport } from '@/lib/reports';
import { reportWorkbook } from '@/lib/reports/xlsx';
import { gulfDate } from '@/lib/reports/common';
import { isReportSlug, WINDOW_OPTIONS, DEFAULT_WINDOW_DAYS, type ReportParams, type ReportResult } from '@/lib/reports/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Vercel rejects a function response over 4.5 MB. A big backlog would otherwise
// fail outright, so the page gets as many rows as fit and is told so; the Excel
// export is compressed and always carries every row.
const MAX_JSON_BYTES = 4_000_000;

function fitResponse(result: ReportResult): ReportResult {
  const size = Buffer.byteLength(JSON.stringify(result));
  if (size <= MAX_JSON_BYTES) return result;
  const keep = Math.floor(result.rows.length * (MAX_JSON_BYTES / size) * 0.9);
  return {
    ...result,
    rows: result.rows.slice(0, keep),
    notes: [
      `Showing the first ${keep.toLocaleString('en-US')} of ${result.rows.length.toLocaleString('en-US')} rows — the page cannot carry more. Export to Excel for every row.`,
      ...result.notes,
    ],
  };
}

export async function GET(req: NextRequest, { params: route }: { params: { report: string } }) {
  // The middleware guards /api too; this keeps the route safe if that changes.
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const slug = route.report;
  if (!isReportSlug(slug)) {
    return NextResponse.json({ error: `Unknown report: ${slug}` }, { status: 404 });
  }

  const q = req.nextUrl.searchParams;
  const daysRaw = Number(q.get('days'));
  const days = (WINDOW_OPTIONS as readonly number[]).includes(daysRaw) ? daysRaw : DEFAULT_WINDOW_DAYS;
  const scope = q.get('scope') || 'all';
  const refresh = q.get('refresh') === '1';
  const asXlsx = q.get('format') === 'xlsx';

  try {
    const config = withKpiDefaults((await readData()).kpiConfig);
    const params: ReportParams = {
      days,
      thresholds: {
        rfqAfterApprovalDays: config.thresholds.rfqAfterApprovalDays ?? 1,
        rfqConfirmDays: config.thresholds.rfqConfirmDays ?? 1,
        partsPlacedDays: config.thresholds.partsPlacedDays ?? 21,
      },
      // "Open" means exactly what it means on the KPI page.
      openRoDomain: selectorDomainNot(config.stageMap.closed),
    };

    const result = await getReport(slug, params, { scope, refresh });

    if (asXlsx) {
      const buffer = reportWorkbook(result);
      // Branch and station both: 'Main branch' alone would name three different files the same.
      const scopePart = result.scope === 'all' ? 'All' : result.scope.split('__').join(' ').replace(/\s+/g, '-');
      const filename = `EVHUB-${slug}-${scopePart}-${gulfDate(Date.now())}.xlsx`;
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return NextResponse.json(fitResponse(result), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error(`[api/evhub/${slug}] failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
