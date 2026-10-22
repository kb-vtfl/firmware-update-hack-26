import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

/**
 * Minimal reader for the single-sheet .xlsx exports produced by the CSMS: shared strings,
 * inline strings and plain values only. Formulas, dates-as-numbers and styles are not interpreted.
 */

const decoder = new TextDecoder("utf-8");

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Concatenates every <t> run, so rich-text cells come out as plain text. */
function textRuns(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1] ?? "";
  return decodeEntities(out);
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1] ?? ""));
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.replace(/\d+$/, "");
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function firstSheetPath(files: Record<string, Uint8Array>): string {
  const workbook = files["xl/workbook.xml"];
  const rels = files["xl/_rels/workbook.xml.rels"];
  if (workbook && rels) {
    const relId = decoder.decode(workbook).match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
    const relsXml = decoder.decode(rels);
    const target = relId
      ? relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bId="${relId}"[^>]*\\bTarget="([^"]+)"`))?.[1] ??
        relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${relId}"`))?.[1]
      : undefined;
    if (target) return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }
  const fallback = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  if (!fallback) throw new Error("No worksheet found in workbook");
  return fallback;
}

/** Spreadsheet row number (1-based, as shown in Excel) of each returned record. */
export const ROW_NUMBER_KEY = "__row";

/** Returns the first worksheet as objects keyed by the header row, plus ROW_NUMBER_KEY. */
export async function readXlsxRows(path: string): Promise<Record<string, string>[]> {
  const files = unzipSync(new Uint8Array(await readFile(path)));
  const sharedXml = files["xl/sharedStrings.xml"];
  const shared = parseSharedStrings(sharedXml ? decoder.decode(sharedXml) : undefined);

  const sheetFile = files[firstSheetPath(files)];
  if (!sheetFile) throw new Error(`Worksheet missing in ${path}`);
  const sheetXml = decoder.decode(sheetFile);

  const grid: string[][] = [];
  const rowNumbers: number[] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    const declared = Number((rowMatch[1] ?? "").match(/\br="(\d+)"/)?.[1]);
    rowNumbers.push(Number.isFinite(declared) && declared > 0 ? declared : (rowNumbers.at(-1) ?? 0) + 1);
    for (const cell of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? "";
      const inner = cell[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const rawValue = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];

      let value = "";
      if (type === "s" && rawValue !== undefined) value = shared[Number(rawValue)] ?? "";
      else if (type === "inlineStr") value = textRuns(inner);
      else if (rawValue !== undefined) value = decodeEntities(rawValue);

      row[ref ? columnIndex(ref) : row.length] = value;
    }
    grid.push(row);
  }

  const [header, ...body] = grid;
  if (!header) return [];
  const keys = Array.from(header, (h) => (h ?? "").trim());
  return body.map((row, index) => {
    const record: Record<string, string> = {};
    keys.forEach((key, i) => {
      if (key) record[key] = row[i] ?? "";
    });
    record[ROW_NUMBER_KEY] = String(rowNumbers[index + 1] ?? index + 2);
    return record;
  });
}
