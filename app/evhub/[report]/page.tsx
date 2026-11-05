import { notFound } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { ReportView } from '@/components/reports/ReportView';
import { isReportSlug, reportMeta, reportSection, reportsFor } from '@/lib/reports/types';

export const dynamic = 'force-dynamic';

const SUB_TABS = reportsFor('evhub').map((r) => ({ href: `/evhub/${r.slug}`, label: r.label }));

export default function EvhubReportPage({ params }: { params: { report: string } }) {
  // A slug now only counts here if it belongs to this section — another
  // section's report would otherwise render under the EVHUB heading and then
  // fail its fetch. The 404 that actually protects the data is in the handler.
  if (!isReportSlug(params.report) || reportSection(params.report) !== 'evhub') notFound();
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
      <ReportView key={slug} slug={slug} windowed={meta.windowed} section="evhub" apiBase="/api/evhub" />
    </Shell>
  );
}
