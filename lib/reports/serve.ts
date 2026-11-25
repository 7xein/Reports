/**
 * The one handler behind every report route — EVHUB and CEO alike.
 *
 * Both sections answer the same questions in the same shape, so the route files
 * are wrappers that name their section and nothing else: a change to caching,
 * validation or the export lands on both at once instead of being fixed in one
 * and forgotten in the other.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, hasTab } from '@/lib/auth';
import { NO_BRANCH_ACCESS_MESSAGE } from '@/lib/access';
import { branchAccessOf, scopeAllowed } from '@/lib/branch-scope';
import { readData } from '@/lib/data-store';
import { withKpiDefaults } from '@/lib/types';
import { selectorDomainNot } from '@/lib/kpi';
import { getReport } from '@/lib/reports';
import { reportWorkbook } from '@/lib/reports/xlsx';
import { gulfDate } from '@/lib/reports/common';
import {
  isReportSlug, reportSection, WINDOW_OPTIONS, DEFAULT_WINDOW_DAYS,
  type ReportParams, type ReportResult, type ReportSection,
} from '@/lib/reports/types';

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

export async function serveReport(req: NextRequest, slug: string, section: ReportSection): Promise<NextResponse> {
  // The middleware guards /api too; these keep the route safe if that changes.
  // The section's OWN tab has to be checked, not just being signed in: with a
  // sign-in check alone, a change to the middleware would hand a section's data
  // to every account.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasTab(user, section)) {
    return NextResponse.json({ error: `No access to ${section.toUpperCase()}` }, { status: 403 });
  }

  if (!isReportSlug(slug)) {
    return NextResponse.json({ error: `Unknown report: ${slug}` }, { status: 404 });
  }

  // A report of another section does not exist at this prefix. This is the only
  // thing stopping someone with only the EVHUB tab from reading CEO data
  // through /api/evhub/attention, so it has to live here, in the handler, and
  // not in the navigation — hiding a sub-tab hides nothing from a URL.
  if (reportSection(slug) !== section) {
    return NextResponse.json({ error: `Unknown report: ${slug}` }, { status: 404 });
  }

  const q = req.nextUrl.searchParams;
  const daysRaw = Number(q.get('days'));
  const days = (WINDOW_OPTIONS as readonly number[]).includes(daysRaw) ? daysRaw : DEFAULT_WINDOW_DAYS;
  const scope = q.get('scope') || 'all';
  const refresh = q.get('refresh') === '1';
  const asXlsx = q.get('format') === 'xlsx';

  // Branch access. A scope naming a branch or station the user was not given is
  // refused outright rather than quietly widened to 'all' — asking for another
  // branch's rows is not a request this route answers.
  const access = branchAccessOf(user);
  if (!scopeAllowed(access, scope)) {
    return NextResponse.json({ error: 'You do not have access to that branch' }, { status: 403 });
  }

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

    const result = await getReport(slug, params, { scope, refresh, access });

    // No branch at all: a branch-scoped report has nothing for them. The page
    // recognises this message and shows it as an empty state, not a failure.
    if (!access.all && access.branches.length === 0 && result.branchScoped) {
      return NextResponse.json({ error: NO_BRANCH_ACCESS_MESSAGE }, { status: 403 });
    }

    if (asXlsx) {
      const restrictedAll = !access.all && result.scope === 'all' && result.branchScoped;
      const buffer = reportWorkbook(result, restrictedAll ? `Your branches: ${access.branches.join(', ')}` : undefined);
      // Branch and station both: 'Main branch' alone would name three different files the same.
      const scopePart = result.scope === 'all' ? 'All' : result.scope.split('__').join(' ').replace(/\s+/g, '-');
      const filename = `${section.toUpperCase()}-${slug}-${scopePart}-${gulfDate(Date.now())}.xlsx`;
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
    console.error(`[api/${section}/${slug}] failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
