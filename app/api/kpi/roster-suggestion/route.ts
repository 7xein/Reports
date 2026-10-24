/**
 * GET /api/kpi/roster-suggestion
 *
 * A reviewable suggestion of who to track and where they belong, built from the
 * last 30 days of Odoo activity: which people actually show up as service
 * advisors or on workshop stations, plus notes explaining how each guess was
 * made. Nothing here is saved — the admin reads the suggestion and applies it.
 */

import { NextResponse } from 'next/server';
import { fetchRosterSuggestion } from '@/lib/odoo';
import { isAdminAuthenticated } from '@/lib/auth';

// Roughly a dozen Odoo queries over a 30-day window — slower than odoo-options.
export const maxDuration = 60;

export async function GET() {
  if (!isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Failed to load roster suggestion', detail: `Missing environment variables: ${missing.join(', ')}` },
      { status: 500 }
    );
  }

  try {
    return NextResponse.json(await fetchRosterSuggestion());
  } catch (error) {
    console.error('❌ [kpi/roster-suggestion] failed:', error);
    return NextResponse.json(
      { error: 'Failed to load roster suggestion', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
