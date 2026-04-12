import { RegionalSalesEntry, RegionalBranchConfig } from './types';

export function getDailyTarget(cfg: RegionalBranchConfig) {
  return cfg.daysInMonth > 0 ? cfg.monthlyTarget / cfg.daysInMonth : 0;
}

export function sumSalesFor(
  salesLog: RegionalSalesEntry[],
  branch: string,
  filterFn: (e: RegionalSalesEntry) => boolean
) {
  return salesLog
    .filter((e) => e.branch === branch && filterFn(e))
    .reduce((s, e) => s + e.actualSales, 0);
}

export function getWeekStart(date: string, weekStartIso: string): string {
  const d  = new Date(date);
  const ws = new Date(weekStartIso);
  const diff = Math.floor((d.getTime() - ws.getTime()) / (7 * 86400_000));
  return new Date(ws.getTime() + diff * 7 * 86400_000).toISOString().slice(0, 10);
}

export function getMonthStart(date: string) {
  return date.slice(0, 7) + '-01';
}

export function latestLogDate(salesLog: RegionalSalesEntry[]): string {
  const dates = salesLog.map((e) => e.date).sort();
  return dates[dates.length - 1] ?? '';
}
