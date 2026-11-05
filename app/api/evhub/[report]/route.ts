/**
 * GET /api/evhub/{report}?days=30|60|90[&scope=Dubai|Dubai__Emarat - Altwar][&refresh=1][&format=xlsx]
 *
 * One EVHUB report — columns, rows, summary tiles and notes in the shared
 * ReportResult shape (lib/reports/types.ts).
 *
 * Every parameter, the cache, the Excel export and the 404 for a slug that is
 * not an EVHUB report live in the shared handler, lib/reports/serve.ts; this
 * file only names the section.
 */

import type { NextRequest } from 'next/server';
import { serveReport } from '@/lib/reports/serve';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest, { params: route }: { params: { report: string } }) {
  return serveReport(req, route.report, 'evhub');
}
