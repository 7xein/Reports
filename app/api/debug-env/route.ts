import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';

export async function GET() {
  if (!isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const vars = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY', 'CRON_SECRET', 'UPSTASH_REDIS_REST_URL'];

  const status = Object.fromEntries(
    vars.map((k) => {
      const val = process.env[k];
      if (!val) return [k, '❌ MISSING'];
      // Show first 6 chars only — enough to confirm it's set without exposing the value
      return [k, `✅ set (${val.slice(0, 6)}…)`];
    })
  );

  return NextResponse.json(status);
}
