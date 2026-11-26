import { CompaniesAdmin } from './CompaniesAdmin';

export const dynamic = 'force-dynamic';

/** Admin → Companies. The card reads Odoo from the browser, so a slow Odoo never blocks the page. */
export default function AdminCompaniesPage() {
  return <CompaniesAdmin />;
}
