import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTPUT_DIR } from "./config.js";
import { toHtml, toMarkdown, type RunSummary } from "./report.js";
import type { Verdict } from "./types.js";

/** Run reports live in output/reports/<runId>/report.{html,md,json}; in Azure, output/ is an Azure Files mount. */

export const REPORTS_DIR = join(OUTPUT_DIR, "reports");
export const REPORT_FORMATS = ["html", "md", "json"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportListing {
  id: string;
  generatedAt: string;
  generatedBy: RunSummary["generatedBy"];
  headline: string;
  upgrade: boolean;
  trigger: string;
  stations: number;
  verdicts: Record<Verdict, number>;
  tickets: number;
}

const VALID_ID = /^[\w-]+$/;

const fileOf = (id: string, format: ReportFormat): string => join(REPORTS_DIR, id, `report.${format}`);

export const downloadPaths = (id: string): Record<ReportFormat, string> =>
  Object.fromEntries(REPORT_FORMATS.map((f) => [f, `/api/reports/${id}/${f}`])) as Record<ReportFormat, string>;

export async function saveReport(summary: RunSummary): Promise<{ id: string; files: Record<ReportFormat, string> }> {
  if (!VALID_ID.test(summary.id)) throw new Error(`Invalid report id "${summary.id}"`);
  await mkdir(join(REPORTS_DIR, summary.id), { recursive: true });
  const contents: Record<ReportFormat, string> = {
    html: toHtml(summary),
    md: toMarkdown(summary),
    json: JSON.stringify(summary, null, 2) + "\n",
  };
  for (const format of REPORT_FORMATS) await writeFile(fileOf(summary.id, format), contents[format], "utf8");
  return { id: summary.id, files: Object.fromEntries(REPORT_FORMATS.map((f) => [f, fileOf(summary.id, f)])) as Record<ReportFormat, string> };
}

export async function listReports(): Promise<ReportListing[]> {
  let ids: string[];
  try {
    ids = (await readdir(REPORTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory() && VALID_ID.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const listings: ReportListing[] = [];
  for (const id of ids) {
    try {
      const s = JSON.parse(await readFile(fileOf(id, "json"), "utf8")) as RunSummary;
      listings.push({
        id,
        generatedAt: s.generatedAt,
        generatedBy: s.generatedBy,
        headline: s.headline,
        upgrade: s.run.upgrade,
        trigger: s.run.trigger,
        stations: s.kpis.stations,
        verdicts: s.kpis.verdicts,
        tickets: s.kpis.tickets,
      });
    } catch {
      // half-written or foreign folder
    }
  }
  return listings.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function readReport(id: string, format: ReportFormat): Promise<Buffer | null> {
  if (!VALID_ID.test(id) || !REPORT_FORMATS.includes(format)) return null;
  try {
    return await readFile(fileOf(id, format));
  } catch {
    return null;
  }
}
