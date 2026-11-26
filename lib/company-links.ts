/**
 * Which Odoo company each configured site is.
 *
 * The names in BRANCH_CLUSTERS (lib/odoo.ts) and SUB_BRANCH_COMPANY
 * (lib/types.ts) are our own LABELS for a site. Each label is linked to a
 * stable Odoo company id, stored in Redis under COMPANY_LINKS_KEY, so a company
 * renamed in Odoo keeps resolving instead of silently zeroing its branch.
 *
 * Resolution, per label:
 *   1. a stored link whose id is still an Odoo company wins — ids over names;
 *   2. otherwise the label is matched to an Odoo company NAME (exact, then
 *      case- and whitespace-insensitive), and that id is returned in `learned`
 *      so the caller can store it as the label's link;
 *   3. otherwise the label is unresolved.
 *
 * Pure and import-free (types only), so client components can use its types and
 * the logic can be tested without Odoo or Redis.
 */

/** Redis hash: configured label → Odoo company id. */
export const COMPANY_LINKS_KEY = 'evs_company_links';

/** How a site found its company: a stored id, a name match, or not at all. */
export type CompanyLinkHow = 'link' | 'name' | 'missing';

export interface OdooCompany {
  id: number;
  name: string;
}

/** A configured site: one entry of BRANCH_CLUSTERS. */
export interface ConfiguredSite {
  branch: string;
  /** The configured name — our label for the site. */
  label: string;
  /** Whether this is the branch's own main site rather than a station. */
  main: boolean;
}

export interface ResolvedSite extends ConfiguredSite {
  /** The Odoo company id the label resolves to, or null when unresolved. */
  id: number | null;
  /** That company's CURRENT name in Odoo, or null when unresolved. */
  odooName: string | null;
  how: CompanyLinkHow;
}

export interface CompanyResolution {
  /** Every Odoo company read, sorted by name. */
  odoo: OdooCompany[];
  /** One entry per configured site, in configuration order. */
  sites: ResolvedSite[];
  /**
   * Odoo company name → id, overlaid with every RESOLVED configured label →
   * its id. Callers ask by configured label (companyIdFor(map, label)) exactly
   * as they did when labels had to equal Odoo names.
   */
  map: Record<string, number>;
  /**
   * Odoo company id → the configured label that claims it. The first label in
   * configuration order wins when two labels share an id, matching the
   * tie-break the reports' companyIndex already uses.
   */
  labelById: Record<number, string>;
  /**
   * Links to store: labels resolved by name whose stored link is missing or
   * differs. Empty when the stored links could not be read (`links === null`),
   * so an unreadable store is never overwritten with guesses.
   */
  learned: Record<string, number>;
}

/** One configured site as GET/PATCH /api/companies report it. */
export interface CompanySiteRow {
  branch: string;
  label: string;
  main: boolean;
  linkedId: number | null;
  odooName: string | null;
  how: CompanyLinkHow;
}

/** The body of GET/PATCH /api/companies. */
export interface CompaniesResponse {
  /** Configured sites, grouped by branch in BRANCH_CLUSTERS order. */
  sites: CompanySiteRow[];
  /** Every Odoo company, sorted by name. */
  companies: OdooCompany[];
}

export function toCompaniesResponse(res: CompanyResolution): CompaniesResponse {
  return {
    sites: res.sites.map((s) => ({
      branch: s.branch, label: s.label, main: s.main, linkedId: s.id, odooName: s.odooName, how: s.how,
    })),
    companies: res.odoo,
  };
}

/**
 * Company id for a name in a name → id map.
 *
 * Exact match first, then case- and whitespace-insensitive. Odoo company names
 * are typed by people and get re-typed on every rename, so "Almushrif" vs
 * "AlMushrif" is a matter of time — and an exact-only match turns that into a
 * silent zero rather than an error. The relaxed pass costs nothing and removes
 * a whole class of invisible breakage.
 */
export function companyIdFor(map: Record<string, number>, name: string): number | undefined {
  const exact = map[name];
  if (exact) return exact;
  const want = name.trim().toLowerCase();
  for (const [known, id] of Object.entries(map)) {
    if (known.trim().toLowerCase() === want) return id;
  }
  return undefined;
}

/** A positive integer id, or null. */
export function cleanCompanyId(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/** A stored links value as label → id, dropping anything that is not a positive integer id. */
export function cleanCompanyLinks(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [label, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = cleanCompanyId(v);
    if (id != null) out[label] = id;
  }
  return out;
}

/**
 * Resolve every configured site against the Odoo companies and the stored links.
 *
 * `links` is null when the store could not be read (or there is none): the
 * sites then resolve by name alone, as they did before links existed, and
 * nothing is offered for learning.
 */
export function resolveCompanyLinks(
  sites: readonly ConfiguredSite[],
  companies: readonly OdooCompany[],
  links: Record<string, number> | null,
): CompanyResolution {
  const byId = new Map<number, OdooCompany>();
  const nameMap: Record<string, number> = {};
  for (const c of companies) {
    byId.set(c.id, c);
    nameMap[c.name] = c.id;
  }

  const learned: Record<string, number> = {};
  const byLabel = new Map<string, { id: number | null; how: CompanyLinkHow }>();
  const resolveLabel = (label: string): { id: number | null; how: CompanyLinkHow } => {
    const known = byLabel.get(label);
    if (known) return known;
    let out: { id: number | null; how: CompanyLinkHow };
    const linked = links?.[label];
    if (linked != null && byId.has(linked)) {
      out = { id: linked, how: 'link' };
    } else {
      const id = companyIdFor(nameMap, label);
      if (id != null) {
        out = { id, how: 'name' };
        if (links && links[label] !== id) learned[label] = id;
      } else {
        out = { id: null, how: 'missing' };
      }
    }
    byLabel.set(label, out);
    return out;
  };

  const resolved: ResolvedSite[] = sites.map((s) => {
    const { id, how } = resolveLabel(s.label);
    return { ...s, id, odooName: id != null ? byId.get(id)?.name ?? null : null, how };
  });

  const map: Record<string, number> = { ...nameMap };
  const labelById: Record<number, string> = {};
  for (const s of resolved) {
    if (s.id == null) continue;
    map[s.label] = s.id;
    if (!(s.id in labelById)) labelById[s.id] = s.label;
  }

  const odoo = [...companies].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  return { odoo, sites: resolved, map, labelById, learned };
}
