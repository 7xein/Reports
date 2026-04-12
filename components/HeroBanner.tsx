interface HeroStat {
  value: string;
  label: string;
  sub?: string;
}

interface HeroBannerProps {
  eyebrow: string;
  title: string;
  titleEm: string;
  sub?: string;
  stats?: HeroStat[];
}

export function HeroBanner({ eyebrow, title, titleEm, sub, stats }: HeroBannerProps) {
  return (
    <div className="shell-hero">
      <div>
        <div className="text-xs text-white/50 tracking-widest uppercase mb-1.5">{eyebrow}</div>
        <h1 className="font-display text-3xl font-light text-white leading-tight">
          {title} <em className="not-italic text-evs-green font-bold">{titleEm}</em>
        </h1>
        {sub && <div className="text-xs text-white/45 mt-1.5">{sub}</div>}
      </div>
      {stats && stats.length > 0 && (
        <div className="flex gap-8">
          {stats.map((s) => (
            <div key={s.label} className="text-right">
              <div className="text-2xl font-black text-evs-green tabular-nums">{s.value}</div>
              <div className="text-xs text-white/45 uppercase tracking-wide mt-0.5">{s.label}</div>
              {s.sub && <div className="text-xs text-evs-green/70 mt-0.5">{s.sub}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
