/**
 * Deep links into Odoo, for report rows that should open the record itself.
 *
 * Reads ODOO_URL straight from the environment rather than through odoo.ts's
 * requireEnv: a missing URL means no link, not a dead page. Throwing here would
 * take down a whole report over a hyperlink.
 */

/**
 * The form view of one record, or null when it cannot be addressed.
 *
 * `cids` carries the record's company because this Odoo is multi-company:
 * without the hint, a record belonging to a company outside the viewer's active
 * selection opens as an access error rather than the record.
 *
 * The `/web#…` hash form is what Odoo 17 — this instance — serves. Odoo 18
 * redirects it to the newer `/odoo/…` path, so the link survives an upgrade.
 */
export function odooRecordUrl(model: string, id: number, companyId?: number | null): string | null {
  const raw = process.env.ODOO_URL;
  if (!raw) return null;
  if (!Number.isFinite(id) || id <= 0) return null;

  const base = raw.replace(/\/+$/, '');
  const url = `${base}/web#id=${id}&model=${model}&view_type=form`;
  return typeof companyId === 'number' && Number.isFinite(companyId) ? `${url}&cids=${companyId}` : url;
}
