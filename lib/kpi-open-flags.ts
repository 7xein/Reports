/**
 * Open KPI flags — every currently failing KPI verdict, uncapped, as Excel.
 *
 * Built for the clean reset at a KPI start date: before the date takes effect,
 * Admin downloads what is still failing so the carry-over can be worked off
 * rather than silently forgotten. The current week is therefore computed with
 * the start date IGNORED, so the export still captures the carry-over when it
 * is run after the date has been set.
 *
 * One row per failing evaluation, read from the engine's own evaluation list
 * (computeKpiEvaluations), never from a cell's `violations`, which is capped.
 */

import * as XLSX from 'xlsx-js-style';
import { autoWidth, boldHeaderRow } from './xlsx';
import { computeKpiEvaluations, type Evaluation } from './kpi';
import { call } from './odoo';
import { KPI_DEFINITIONS, KpiConfig, kpiDisplayName } from './types';

/** KPIs that are branch readings and name nobody (mirrors BRANCH_ONLY_KPI_IDS in lib/kpi.ts). */
const BRANCH_READING_KPI_IDS: readonly number[] = [7, 9];

export const OPEN_FLAGS_COLUMNS = [
  'Branch', 'KPI', 'KPI rule', 'Reference', 'Person responsible', 'Repair order stage', 'Repair order tags',
] as const;

export interface OpenFlagRow {
  branch: string;
  kpi: string;
  rule: string;
  reference: string;
  person: string;
  stage: string;
  tags: string;
}

export interface OpenFlags {
  week: { start: string; end: string };
  generatedAt: string;
  rows: OpenFlagRow[];
}

type Rec = Record<string, unknown>;
const m2o = (v: unknown): [number, string] | null => (Array.isArray(v) ? (v as [number, string]) : null);

/** ISO time → 'YYYY-MM-DD HH:MM' Gulf time (UTC+4, no DST). */
function gulfStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t + 4 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** Gulf calendar date of an ISO time, for the filename. */
export function gulfDate(iso: string): string {
  return gulfStamp(iso).slice(0, 10);
}

/**
 * Repair order name → { stage, tags }, for the refs that are repair orders.
 *
 * One batched search by name (chunked); a ref that is a quotation or purchase
 * order simply finds no repair order and stays blank. The stage is the
 * "Repair Status" workflow (repair_state) where this instance has it, else the
 * state field, read through its selection labels. Tags are tag_ids and
 * x_studio_stages_tags combined, as in the Admin repair-order export. A failed
 * read leaves both columns blank rather than failing the export.
 */
async function repairOrderDetails(refs: string[]): Promise<Map<string, { stage: string; tags: string }>> {
  const out = new Map<string, { stage: string; tags: string }>();
  const names = [...new Set(refs.filter(Boolean))];
  if (!names.length) return out;
  let meta: Record<string, { relation?: string; selection?: [string, string][] }>;
  try {
    meta = (await call('repair.order', 'fields_get', [], { attributes: ['type', 'relation', 'selection'] })) as typeof meta;
  } catch {
    return out;
  }
  const has = (f: string) => Object.prototype.hasOwnProperty.call(meta, f);
  const stageField = ['repair_state', 'state'].find(has);
  const tagFields = ['tag_ids', 'x_studio_stages_tags'].filter((f) => has(f) && meta[f]?.relation);
  const stageLabels = new Map<string, string>((stageField ? meta[stageField]?.selection ?? [] : []));

  const ros: Rec[] = [];
  for (let i = 0; i < names.length; i += 2000) {
    try {
      ros.push(...((await call('repair.order', 'search_read', [[['name', 'in', names.slice(i, i + 2000)]]], {
        fields: ['name', ...(stageField ? [stageField] : []), ...tagFields], limit: 0,
      })) as Rec[]));
    } catch { /* this chunk's refs stay blank */ }
  }

  const tagNames: Record<string, Map<number, string>> = {};
  for (const tf of tagFields) {
    const ids = [...new Set(ros.flatMap((r) => (r[tf] as number[] | undefined) ?? []))];
    const map = new Map<number, string>();
    if (ids.length) {
      try {
        const recs = (await call(meta[tf]!.relation!, 'read', [ids], { fields: ['display_name'] })) as Rec[];
        for (const t of recs) map.set(t.id as number, (t.display_name as string) || '');
      } catch { /* comodel unreadable — that field's tags stay blank */ }
    }
    tagNames[tf] = map;
  }

  for (const r of ros) {
    const name = (r.name as string) || '';
    if (!name || out.has(name)) continue;
    const raw = stageField ? r[stageField] : undefined;
    const stage = typeof raw === 'string' ? stageLabels.get(raw) ?? raw : (m2o(raw)?.[1] ?? '');
    const tags: string[] = [];
    for (const tf of tagFields) {
      for (const id of (r[tf] as number[] | undefined) ?? []) {
        const n = tagNames[tf]?.get(id);
        if (n) tags.push(n);
      }
    }
    out.set(name, { stage, tags: tags.join(', ') });
  }
  return out;
}

/** Who a failing verdict names, as the sheet shows it. */
export function personLabel(e: Pick<Evaluation, 'kpiId' | 'userId' | 'userName'>): string {
  if (BRANCH_READING_KPI_IDS.includes(e.kpiId)) return 'Branch reading (no individual)';
  return e.userId == null ? 'No one identified' : e.userName;
}

/** Failing evaluations → sorted rows. Separate from Odoo so it can be checked on its own. */
export function openFlagRows(
  evaluations: readonly Evaluation[],
  config: KpiConfig,
  details: Map<string, { stage: string; tags: string }>,
): OpenFlagRow[] {
  const defs = new Map<number, { name: string; rule: string }>(KPI_DEFINITIONS.map((d) => [d.id, { name: d.name, rule: d.rule }]));
  const rows = evaluations
    .filter((e) => !e.compliant)
    .map((e) => {
      const def = defs.get(e.kpiId);
      const ro = details.get(e.ref);
      return {
        branch: e.branch,
        kpi: kpiDisplayName(e.kpiId, def?.name ?? `KPI ${e.kpiId}`, config.thresholds),
        rule: def?.rule ?? '',
        reference: e.ref,
        person: personLabel(e),
        stage: ro?.stage ?? '',
        tags: ro?.tags ?? '',
      };
    });
  const cmp = (a: string, b: string) => a.localeCompare(b);
  return rows.sort((a, b) => cmp(a.branch, b.branch) || cmp(a.kpi, b.kpi) || cmp(a.person, b.person) || cmp(a.reference, b.reference));
}

/** The current week, start date ignored, every failing verdict with its repair-order details. */
export async function computeOpenFlags(config: KpiConfig): Promise<OpenFlags> {
  const { tree, evaluations } = await computeKpiEvaluations(config, undefined, { ignoreStartDate: true });
  const failing = evaluations.filter((e) => !e.compliant);
  const details = await repairOrderDetails(failing.map((e) => e.ref));
  return { week: tree.week, generatedAt: tree.generatedAt, rows: openFlagRows(failing, config, details) };
}

function sheet(aoa: (string | number)[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = autoWidth(aoa);
  boldHeaderRow(ws);
  return ws;
}

/** Two sheets: "Open flags" (one row per failing verdict) and "About". */
export function openFlagsWorkbook(flags: OpenFlags): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const table: string[][] = [
    [...OPEN_FLAGS_COLUMNS],
    ...flags.rows.map((r) => [r.branch, r.kpi, r.rule, r.reference, r.person, r.stage, r.tags]),
  ];
  XLSX.utils.book_append_sheet(wb, sheet(table), 'Open flags');

  const about: (string | number)[][] = [
    ['Generated', `${gulfStamp(flags.generatedAt)} (Gulf time)`],
    ['Week', `${flags.week.start} to ${flags.week.end}`],
    ['Rows', flags.rows.length],
    [],
    ['Every KPI item failing in the current week, one row per failing verdict, with no cap. Computed without the KPI start date, so work created before it is included. Repair order stage and tags are filled only where the reference is a repair order.'],
  ];
  XLSX.utils.book_append_sheet(wb, sheet(about), 'About');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
