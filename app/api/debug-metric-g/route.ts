import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { debugMetricG } from '@/lib/odoo';

export const maxDuration = 60;

export async function GET() {
  if (!isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized — log into admin first' }, { status: 401 });
  }
  try {
    const result = await debugMetricG();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: 'Debug failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
