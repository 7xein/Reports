import { NextRequest, NextResponse } from 'next/server';
import { readData, writeData } from '@/lib/data-store';
import { isAuthenticated, isAdminAuthenticated } from '@/lib/auth';

export async function GET() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const data = await readData();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[GET /api/data]', err);
    return NextResponse.json({ error: 'Failed to load data' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated() || !isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  let current: Awaited<ReturnType<typeof readData>>;
  try {
    current = await readData();
  } catch (err) {
    console.error('[POST /api/data] readData failed:', err);
    return NextResponse.json({ error: 'Failed to load data' }, { status: 500 });
  }

  // body shape: { type: 'weekly' | 'daily', payload: ... }
  if (body.type === 'weekly') {
    const newCurrent = body.payload;
    // Push old current into history if it's a new weekEnding
    if (current.weekly.current.weekEnding !== newCurrent.weekEnding) {
      current.weekly.previous = current.weekly.current;
      // Add to history if not already there
      if (!current.weekly.history.find((h: any) => h.weekEnding === current.weekly.current.weekEnding)) {
        current.weekly.history.push(current.weekly.current);
      }
    }
    current.weekly.current = newCurrent;
  } else if (body.type === 'daily') {
    const newCurrent = body.payload;
    if (current.daily.current.date !== newCurrent.date) {
      current.daily.previous = current.daily.current;
    }
    current.daily.current = newCurrent;
  } else if (body.type === 'targets-weekly') {
    current.weekly.targets = body.payload;
  } else if (body.type === 'targets-daily') {
    current.daily.targets = body.payload;
  } else if (body.type === 'regional-config') {
    current.regional.weekStart = body.payload.weekStart;
    current.regional.branchConfig = body.payload.branchConfig;
  } else if (body.type === 'regional-log') {
    current.regional.salesLog = body.payload;
  } else if (body.type === 'wip-daily') {
    const entry = body.payload as import('@/lib/types').WipDailyEntry;
    if (!current.wipHistory) current.wipHistory = [];
    const idx = current.wipHistory.findIndex((e: import('@/lib/types').WipDailyEntry) => e.date === entry.date);
    if (idx >= 0) {
      current.wipHistory[idx] = entry;
    } else {
      current.wipHistory.push(entry);
    }
    current.wipHistory.sort((a: import('@/lib/types').WipDailyEntry, b: import('@/lib/types').WipDailyEntry) => a.date.localeCompare(b.date));
  } else if (body.type === 'wip-weekly') {
    const entry = body.payload as import('@/lib/types').WipWeeklyEntry;
    if (!current.wipWeeklyHistory) current.wipWeeklyHistory = [];
    const idx = current.wipWeeklyHistory.findIndex((e: import('@/lib/types').WipWeeklyEntry) => e.weekEnding === entry.weekEnding);
    if (idx >= 0) {
      current.wipWeeklyHistory[idx] = entry;
    } else {
      current.wipWeeklyHistory.push(entry);
    }
    current.wipWeeklyHistory.sort((a: import('@/lib/types').WipWeeklyEntry, b: import('@/lib/types').WipWeeklyEntry) => a.weekEnding.localeCompare(b.weekEnding));
  } else {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  }

  try {
    await writeData(current);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[POST /api/data] writeData failed:', detail);
    return NextResponse.json({
      error: 'Failed to save data',
      detail,
      usingRedis: !!process.env.UPSTASH_REDIS_REST_URL,
    }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
