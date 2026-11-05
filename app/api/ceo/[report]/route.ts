/**
 * GET /api/ceo/{report}?days=30|60|90[&scope=Dubai|Dubai__Emarat - Altwar][&refresh=1][&format=xlsx]
 *
 * One CEO report, in the same ReportResult shape as every other report. The
 * shared handler (lib/reports/serve.ts) holds the behaviour, including the 404
 * that keeps an EVHUB slug from being read through this prefix and vice versa.
 */

import type { NextRequest } from 'next/server';
import { serveReport } from '@/lib/reports/serve';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest, { params: route }: { params: { report: string } }) {
  return serveReport(req, route.report, 'ceo');
}
