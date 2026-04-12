export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

export function formatCurrency(n: number): string {
  if (Math.abs(n) >= 1_000_000) {
    return `AED ${(n / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `AED ${(n / 1_000).toFixed(0)}K`;
  }
  return `AED ${formatNumber(n)}`;
}

export function formatCurrencyFull(n: number): string {
  return `AED ${formatNumber(n)}`;
}

export function formatPercent(n: number, withSign = true): string {
  const sign = withSign && n > 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(1)}%`;
}

export function formatChange(current: number, previous: number): {
  value: number;
  display: string;
  direction: 'up' | 'down' | 'flat';
} {
  if (previous === 0) {
    return { value: 0, display: '—', direction: 'flat' };
  }
  const change = (current - previous) / previous;
  const direction = change > 0.001 ? 'up' : change < -0.001 ? 'down' : 'flat';
  return {
    value: change,
    display: formatPercent(change),
    direction,
  };
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function sumBranchValues(values: Record<string, number>): number {
  return Object.values(values).reduce((a, b) => a + b, 0);
}
