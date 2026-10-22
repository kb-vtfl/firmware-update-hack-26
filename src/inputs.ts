import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROJECT_ROOT } from "./config.js";

/** Accepts .xlsx files and/or directories; with no arguments, every .xlsx in the project root is used. */
export async function resolveInputFiles(args: string[]): Promise<string[]> {
  const targets = args.length > 0 ? args.map((a) => resolve(a)) : [PROJECT_ROOT];
  const files: string[] = [];
  for (const target of targets) {
    if ((await stat(target)).isDirectory()) {
      const entries = await readdir(target);
      files.push(...entries.filter((e) => e.toLowerCase().endsWith(".xlsx") && !e.startsWith("~$")).map((e) => join(target, e)));
    } else {
      files.push(target);
    }
  }
  return files.sort();
}
