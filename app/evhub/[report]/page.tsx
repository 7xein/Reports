import { notFound } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { ReportView } from '@/components/reports/ReportView';
import { REPORTS, isReportSlug, reportMeta } from '@/lib/reports/types';

export const dynamic = 'force-dynamic';

const SUB_TABS = REPORTS.map((r) => ({ href: `/evhub/${r.slug}`, label: r.label }));

export default function EvhubReportPage({ params }: { params: { report: string } }) {
  if (!isReportSlug(params.report)) notFound();
  const slug = params.report;
  const meta = reportMeta(slug);

  return (
    <Shell
      breadcrumbSection="EVHUB"
      breadcrumbPage={meta.label}
      subTabs={SUB_TABS}
      hero={{
        eyebrow: 'EVHUB · Parts & purchasing · Live from Odoo',
        title: meta.hero.title,
        titleEm: meta.hero.titleEm,
        sub: meta.hero.sub,
      }}
    >
      {/* Keyed so switching sub-tab starts clean instead of showing the last report's rows under the new heading. */}
      <ReportView key={slug} slug={slug} windowed={meta.windowed} />
    </Shell>
  );
}
