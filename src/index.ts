import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ANALYSIS_WINDOW_HOURS,
  AZURE_FOUNDRY_DEPLOYMENT,
  FIRMWARE_LOCATION_TEMPLATE,
  INBOX_DIR,
  TARGET_FIRMWARE_VERSION,
  WATCH_DEBOUNCE_MS,
} from "./config.js";
import { resolveInputFiles } from "./inputs.js";
import { assertLlmConfigured } from "./llm.js";
import { log } from "./logger.js";
import { connectionStatus, errors, firmwareInfo, loadStationLog, sessions } from "./ocpp.js";
import { runPipeline } from "./pipeline.js";

const FLAGS = ["--dry-run", "--watch", "--no-upgrade"];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function printFacts(files: string[]): Promise<void> {
  for (const station of await Promise.all(files.map(loadStationLog))) {
    const facts = {
      connection: connectionStatus(station, ANALYSIS_WINDOW_HOURS),
      sessions: sessions(station, ANALYSIS_WINDOW_HOURS),
      errors: errors(station, ANALYSIS_WINDOW_HOURS),
      firmware: firmwareInfo(station),
    };
    console.log(`\n=== ${station.stationId} ===`);
    console.log(JSON.stringify(facts, null, 2));
  }
}

const signature = async (file: string): Promise<string> => {
  const s = await stat(file);
  return `${s.size}:${s.mtimeMs}`;
};

/** An upload is complete once its size stops changing. */
async function waitUntilStable(file: string): Promise<void> {
  let previous = "";
  for (let i = 0; i < 20; i++) {
    const current = await signature(file);
    if (current === previous) return;
    previous = current;
    await sleep(500);
  }
}

/** Long-running mode: processes what is in the inbox now, then every new or changed .xlsx dropped into it. */
async function watchInbox(dir: string, upgrade: boolean): Promise<void> {
  const processed = new Map<string, string>();
  let running = false;
  let rescan = false;
  let timer: NodeJS.Timeout | undefined;

  const scan = async (trigger: string): Promise<void> => {
    if (running) {
      rescan = true;
      return;
    }
    running = true;
    try {
      do {
        rescan = false;
        const fresh: string[] = [];
        for (const file of await resolveInputFiles([dir])) {
          await waitUntilStable(file);
          const sig = await signature(file).catch(() => "");
          if (sig && processed.get(file) !== sig) {
            fresh.push(file);
            processed.set(file, sig);
          }
        }
        if (fresh.length === 0) continue;
        try {
          await runPipeline(fresh, { upgrade, trigger });
        } catch (err) {
          log.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        log.info(`Watching ${dir} for new uploads (.xlsx) — Ctrl+C to stop`);
        trigger = "new upload";
      } while (rescan);
    } finally {
      running = false;
    }
  };

  watch(dir, (_event, filename) => {
    if (!filename || !filename.toString().toLowerCase().endsWith(".xlsx") || filename.toString().startsWith("~$")) return;
    clearTimeout(timer);
    timer = setTimeout(() => void scan(`new upload (${filename.toString()})`), WATCH_DEBOUNCE_MS);
  });

  await scan("startup");
  if (processed.size === 0) log.info(`Watching ${dir} for uploads (.xlsx) — Ctrl+C to stop`);
  await new Promise<never>(() => {});
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const paths = argv.filter((a) => !FLAGS.includes(a));
  const upgrade = !argv.includes("--no-upgrade");

  if (argv.includes("--dry-run")) return printFacts(await resolveInputFiles(paths));

  assertLlmConfigured();
  const watchMode = argv.includes("--watch");
  const inbox = resolve(paths[0] ?? INBOX_DIR);

  log.banner(
    "Firmware Upgrade Readiness Agent",
    `${watchMode ? "service mode" : "single run"} · model ${AZURE_FOUNDRY_DEPLOYMENT} · OCPP 2.0.1 gateway (mock)`,
  );
  log.info(`input: ${watchMode ? `watching ${inbox}` : paths.length ? paths.join(", ") : inbox}`);
  log.info(
    upgrade
      ? `rollout: ENABLED — READY_FOR_UPGRADE stations get firmware ${TARGET_FIRMWARE_VERSION ?? "(TARGET_FIRMWARE_VERSION not set)"}`
      : "rollout: disabled (--no-upgrade)",
  );
  if (upgrade) log.info(`firmware image location: ${FIRMWARE_LOCATION_TEMPLATE.replace(/(:\/\/)[^/@\s]+@/, "$1***@")}`);

  if (watchMode) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        log.info(`Received ${signal}, shutting down`);
        process.exit(0);
      });
    }
    return watchInbox(inbox, upgrade);
  }

  const files = await resolveInputFiles(paths);
  if (files.length === 0) throw new Error("No .xlsx files found. Pass file paths or a directory as arguments.");
  await runPipeline(files, { upgrade, trigger: "manual run" });
}

main().catch((err: unknown) => {
  log.error(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
