import { WIP_METRICS } from '@/lib/types';

/** Explains all 7 WIP metrics. Shown at the bottom of both WIP dashboard tabs. */
export function WipMetricsLegend() {
  return (
    <div className="bg-white rounded-lg shadow-sm p-5 mt-4">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-bold uppercase tracking-wide text-ink-muted">What the metrics mean</span>
        <div className="flex items-center gap-4 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full inline-block bg-evs-green" />Higher is better
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full inline-block bg-danger" />Lower is better
          </span>
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
        {WIP_METRICS.map((m) => (
          <div key={m.key} className="flex gap-2.5">
            <span
              className={`mt-1.5 w-2 h-2 rounded-full inline-block flex-shrink-0 ${m.lowerIsBetter ? 'bg-danger' : 'bg-evs-green'}`}
              aria-hidden
            />
            <div>
              <div className="text-sm font-semibold text-ink leading-tight">{m.label}</div>
              <div className="text-xs text-ink-muted mt-0.5 leading-snug">{m.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
