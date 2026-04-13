import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';

/**
 * POST /api/seed
 * One-time endpoint: uploads data.json content to the KV store.
 * Call this once after first deploy via the Admin panel or curl.
 * Protected — requires admin auth cookie.
 */
export async function POST(req: NextRequest) {
  if (!isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.KV_REST_API_URL) {
    return NextResponse.json({ error: 'KV not configured — seed only needed on Vercel' }, { status: 400 });
  }

  try {
    const body = await req.json();
    const { kv } = await import('@vercel/kv');
    await kv.set('evs_report_data', body);
    return NextResponse.json({ success: true, message: 'KV store seeded successfully.' });
  } catch (err) {
    console.error('[/api/seed]', err);
    return NextResponse.json({ error: 'Seed failed', detail: String(err) }, { status: 500 });
  }
}
