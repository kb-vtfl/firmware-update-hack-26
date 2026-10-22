import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTPUT_DIR } from "./config.js";
import type { FollowUp } from "./types.js";

/** Local stand-in for a scheduler: post-update follow-up checks are appended to output/follow-ups.json. */
const FOLLOW_UPS_FILE = join(OUTPUT_DIR, "follow-ups.json");

export async function scheduleFollowUp(followUp: FollowUp): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  let all: FollowUp[] = [];
  try {
    all = JSON.parse(await readFile(FOLLOW_UPS_FILE, "utf8")) as FollowUp[];
  } catch {
    all = [];
  }
  all.push(followUp);
  await writeFile(FOLLOW_UPS_FILE, JSON.stringify(all, null, 2) + "\n", "utf8");
}
