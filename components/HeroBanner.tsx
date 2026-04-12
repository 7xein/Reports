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
        <div className="text-[9px] text-white/45 tracking-widest uppercase mb-1">{eyebrow}</div>
        <h1 className="font-display text-xl font-light text-white leading-tight">
          {title} <em className="not-italic text-evs-green font-bold">{titleEm}</em>
        </h1>
        {sub && <div className="text-[9px] text-white/40 mt-1">{sub}</div>}
      </div>
      {stats && stats.length > 0 && (
        <div className="flex gap-6">
          {stats.map((s) => (
            <div key={s.label} className="text-right">
              <div className="text-lg font-black text-evs-green tabular-nums">{s.value}</div>
              <div className="text-[8px] text-white/40 uppercase tracking-wide mt-0.5">{s.label}</div>
              {s.sub && <div className="text-[8px] text-evs-green/60 mt-0.5">{s.sub}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
