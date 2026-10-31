import type { CellValue, ColumnKind, ReportColumn, Tone } from '@/lib/reports/types';

/** Pill classes for a badge (and an inactive filter chip) of a given tone. */
export const BADGE_TONE: Record<Tone, string> = {
  good: 'bg-evs-green/10 text-evs-green-dark',
  warn: 'bg-amber-50 text-amber-700',
  bad: 'bg-red-50 text-danger',
  neutral: 'bg-surface text-ink-soft border border-border',
};

/** Solid classes for an active filter chip of a given tone. */
export const CHIP_ACTIVE_TONE: Record<Tone, string> = {
  good: 'bg-evs-green-dark text-white',
  warn: 'bg-amber-500 text-white',
  bad: 'bg-danger text-white',
  neutral: 'bg-ink-soft text-white',
};

/** Summary tile value colour by tone. */
export const VALUE_TONE: Record<Tone, string> = {
  good: 'text-evs-green-dark',
  warn: 'text-amber-600',
  bad: 'text-danger',
  neutral: 'text-ink',
};

/** Summary tile top-border colour by tone (no tone reads as neutral). */
export const TILE_BORDER_TONE: Record<Tone, string> = {
  good: 'border-t-evs-green',
  warn: 'border-t-amber-400',
  bad: 'border-t-danger',
  neutral: 'border-t-gray-300',
};

export const NUMERIC_KINDS: ReadonlySet<ColumnKind> = new Set(['number', 'days', 'currency', 'percent']);
export const SEARCHABLE_KINDS: ReadonlySet<ColumnKind> = new Set(['text', 'badge', 'date']);

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function isEmpty(v: CellValue | undefined): v is null | undefined | '' {
  return v === null || v === undefined || v === '';
}

function toNumber(v: CellValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const Dash = () => <span className="text-ink-muted">—</span>;

export function Cell({
  col,
  value,
  tones,
}: {
  col: ReportColumn;
  value: CellValue | undefined;
  tones?: Record<string, Tone>;
}) {
  if (isEmpty(value)) return <Dash />;

  switch (col.kind) {
    case 'number': {
      const n = toNumber(value);
      return n === null ? <>{String(value)}</> : <>{numberFmt.format(n)}</>;
    }
    case 'days': {
      const n = toNumber(value);
      return n === null ? <>{String(value)}</> : <>{n.toFixed(1)} d</>;
    }
    case 'currency': {
      const n = toNumber(value);
      return n === null ? (
        <>{String(value)}</>
      ) : (
        <>{n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
      );
    }
    case 'percent': {
      const n = toNumber(value);
      if (n === null) return <>{String(value)}</>;
      const text = `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1)}%`;
      let cls = '';
      if (n !== 0 && col.trend) {
        const bad = col.trend === 'up-bad' ? n > 0 : n < 0;
        cls = bad ? 'text-danger' : 'text-evs-green-dark';
      }
      return <span className={cls}>{text}</span>;
    }
    case 'badge': {
      const label = String(value);
      const tone = tones?.[label] ?? 'neutral';
      return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${BADGE_TONE[tone]}`}>
          {label}
        </span>
      );
    }
    default:
      return <>{String(value)}</>;
  }
}
