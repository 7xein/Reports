import Link from 'next/link';
import { reportVariants, type ReportSlug } from '@/lib/reports/types';

/**
 * Switches between a report and its child views (REPORTS[].parent) — e.g. Open
 * parts for every open repair order, or car-in only. Each option is its own
 * page, so this is plain links; the branch scope is kept by ReportView, which
 * remembers it per section. Renders nothing for a report with no variants.
 *
 * Styled as the branch picker's pills, so it reads as one of the page's pickers.
 */
export function ReportVariantToggle({ slug, basePath }: { slug: ReportSlug; basePath: string }) {
  const variants = reportVariants(slug);
  if (!variants.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Report view">
      {variants.map((v) => {
        const active = v.slug === slug;
        return (
          <Link
            key={v.slug}
            href={`${basePath}/${v.slug}`}
            aria-current={active ? 'page' : undefined}
            className={`text-sm font-semibold px-4 py-1.5 rounded-full border transition-all ${
              active
                ? 'bg-evs-green text-white border-transparent shadow-sm'
                : 'bg-white text-ink-muted border-border hover:border-gray-400'
            }`}
          >
            {v.variantLabel ?? v.label}
          </Link>
        );
      })}
    </div>
  );
}
