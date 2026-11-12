/**
 * GET /api/kpi/role-proposal
 *
 * Who should hold which KPI role, derived from what people demonstrably do in
 * Odoo over the last 90 days, per branch, with the counts that justified every
 * proposal. The owner reviews it in Admin, ticks and unticks, applies it to the
 * roster, and then presses Save — nothing here writes to Odoo or to the config.
 *
 * On its OWN route, deliberately. The activity map behind this is 30-odd Odoo
 * calls, and it used to run inside GET /api/kpi/odoo-options on every Admin page
 * load — the page the owner configures everything from — against that route's
 * 60-second limit. That is why it was never deployed. Here it is paid for when
 * the button is pressed, and a slow Odoo can no longer take the Admin page down.
 */

import { NextResponse } from 'next/server';
import { fetchKpiRoleProposal } from '@/lib/odoo';
import { isAdminAuthenticated } from '@/lib/auth';
import { readData } from '@/lib/data-store';
import { withKpiDefaults, type KpiConfig } from '@/lib/types';

export const dynamic = 'force-dynamic';

// 300, not 60, for the same reason as /api/kpi and the CEO and EVHUB reports:
// this is 30-odd Odoo calls, several of them chatter reads over tens of
// thousands of rows, and a minute is not enough. The map stops itself well
// inside this and reports which buckets it never reached, so a slow Odoo costs
// an incomplete proposal that says so — never a dead request with nothing in it.
export const maxDuration = 300;

export async function GET() {
  if (!isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Failed to build the role proposal', detail: `Missing environment variables: ${missing.join(', ')}` },
      { status: 500 }
    );
  }

  try {
    // The SAVED config, and it is load-bearing twice over. The map needs the
    // live stage mapping to know which chatter change means "reached
    // Inspection", "reached QA" or "marked Repaired" — the shipped defaults
    // point `repaired` at priority_matrix_status, which records no changes on
    // this instance, so assuming them would report that nobody marks cars
    // repaired. And the proposal compares itself against the saved roster, so
    // without it every person would read as off-roster.
    //
    // Unlike the options route, a store that cannot be read is NOT survivable
    // here: it would silently produce a proposal with three empty buckets and a
    // roster of nobody, which is exactly the "looks like an absence of activity"
    // failure this feature exists to prevent. So it fails loudly instead.
    let config: KpiConfig;
    try {
      config = withKpiDefaults((await readData()).kpiConfig);
    } catch (e) {
      console.error('❌ [kpi/role-proposal] could not read the saved KPI config:', e);
      return NextResponse.json(
        {
          error: 'Failed to build the role proposal',
          detail: 'The saved KPI configuration could not be read, and without it the stage mapping is unknown and the saved roster cannot be compared — so the proposal would understate three of the eleven activity buckets and show everyone as off-roster. '
            + `Fix the config store and try again: ${e instanceof Error ? e.message : String(e)}`,
        },
        { status: 500 }
      );
    }
    return NextResponse.json(await fetchKpiRoleProposal(config));
  } catch (error) {
    console.error('❌ [kpi/role-proposal] failed:', error);
    return NextResponse.json(
      { error: 'Failed to build the role proposal', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
