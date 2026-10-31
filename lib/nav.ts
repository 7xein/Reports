// Sub-tab links shown in the top bar of each section. Shared by the pages and
// their loading skeletons so both render the same links.
// (EVHUB's sub-tabs are derived from REPORTS in lib/reports/types.ts.)

export interface SubTab {
  href: string;
  label: string;
}

export const WIP_SUB_TABS: SubTab[] = [
  { href: '/wip/daily',  label: 'Accumulative' },
  { href: '/wip/weekly', label: 'Weekly Snapshot' },
];

export const SALES_SUB_TABS: SubTab[] = [
  { href: '/sales/daily',   label: 'Daily'   },
  { href: '/sales/weekly',  label: 'Weekly'  },
  { href: '/sales/monthly', label: 'Monthly' },
];

export const KPI_SUB_TABS: SubTab[] = [{ href: '/kpi', label: 'Weekly KPIs' }];

// Breadcrumb page label each route's page passes to Shell, so the loading
// skeleton's top bar has the same width as the real page's and does not jump.
export const BREADCRUMB_PAGES: Record<string, string> = {
  '/wip/daily':     'Daily Trends',
  '/wip/weekly':    'Weekly Snapshot',
  '/sales/daily':   'Daily',
  '/sales/weekly':  'Weekly',
  '/sales/monthly': 'Monthly',
  '/kpi':           'Weekly KPIs',
};
