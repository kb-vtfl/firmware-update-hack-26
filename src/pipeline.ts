import { basename, join } from "node:path";
import { runAgent, type AgentRun } from "./agent.js";
import {
  ANALYSIS_PROMPT,
  ANALYSIS_WINDOW_HOURS,
  AZURE_FOUNDRY_DEPLOYMENT,
  OUTPUT_DIR,
  REPORT_PROMPT,
  TARGET_FIRMWARE_VERSION,
  UPGRADE_PROMPT,
} from "./config.js";
import * as dashboard from "./dashboard.js";
import { log, startRunLog } from "./logger.js";
import { createMockGateway } from "./mockStation.js";
import { loadStationLog } from "./ocpp.js";
import { CALL } from "./ocpp201.js";
import type { StationGateway } from "./stationGateway.js";
import {
  ANALYSIS_TOOLS,
  REPORT_TOOLS,
  UPGRADE_TOOLS,
  generateRunReport,
  getFirmwareAttempts,
  getGeneratedReportId,
  getPostChecks,
  getReboots,
  getRecommendations,
  getTickets,
  pendingStations,
  pendingUpgrades,
  recordAgentStats,
  reportFacts,
  startRun,
  upgradeCandidates,
} from "./tools.js";
import type { StationLog } from "./types.js";

const PHASES = 4;

export interface PipelineOptions {
  upgrade: boolean;
  /** Why this run started, e.g. "startup" or "new upload". */
  trigger: string;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const day = (d: Date | undefined): string => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "?");

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [line(header), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

const agentStats = (run: AgentRun, ms: number): string =>
  `${seconds(ms)} · ${run.steps} LLM step(s) · ${run.toolCalls} tool call(s) · tokens in=${run.tokensIn} out=${run.tokensOut}`;

const record = (phase: string, run: AgentRun, ms: number): void =>
  recordAgentStats({ phase, steps: run.steps, toolCalls: run.toolCalls, tokensIn: run.tokensIn, tokensOut: run.tokensOut, durationMs: ms });

/** Surfaces the live station side of the rollout: firmware progress always, raw frames at LOG_LEVEL=debug. */
function followOcppTraffic(gateway: StationGateway): () => void {
  const stopLinks = gateway.onConnection((stationId, online) => {
    log.ocpp(online ? "station reconnected (OCPP WebSocket up)" : "station went offline — rebooting (OCPP WebSocket closed)", stationId);
    dashboard.stationLink(stationId, online);
  });
  const stopTraffic = gateway.onTraffic(({ stationId, direction, frame }) => {
    log.debug(`${direction} ${JSON.stringify(frame).slice(0, 300)}`, stationId);
    if (direction !== "CS->CSMS" || frame[0] !== CALL) return;
    const [, , action, raw] = frame;
    const payload = raw as Record<string, unknown>;
    if (action === "FirmwareStatusNotification") {
      log.ocpp(`station reports firmware status ${log.bold(String(payload["status"]))}`, stationId);
      dashboard.firmwareStatus(stationId, String(payload["status"]));
    } else if (action === "BootNotification") {
      const station = (payload["chargingStation"] ?? {}) as Record<string, unknown>;
      const version = typeof station["firmwareVersion"] === "string" ? station["firmwareVersion"] : null;
      if (payload["reason"] === "FirmwareUpdate") {
        log.ocpp(`BootNotification after installation — station now reports firmware ${log.bold(String(version))}`, stationId);
      } else if (payload["reason"] === "RemoteReset") {
        log.ocpp(`BootNotification after recovery reboot — firmware ${log.bold(String(version))}`, stationId);
      }
      dashboard.stationBooted(stationId, version);
    } else if (action === "StatusNotification") {
      dashboard.connectorStatus(stationId, Number(payload["evseId"]), String(payload["connectorStatus"]));
    }
  });
  return () => {
    stopLinks();
    stopTraffic();
  };
}

async function ingest(files: string[]): Promise<StationLog[]> {
  log.phase(1, PHASES, "INGEST", "upload the OCPP log exports and parse them");
  dashboard.setPhase("INGEST");
  log.plan(`Upload ${files.length} file(s) and parse every OCPP message so the agent can query them`);

  const byStation = new Map<string, StationLog>();
  for (const file of files) {
    log.do(`uploading ${basename(file)}`);
    try {
      const station = await loadStationLog(file);
      const previous = byStation.get(station.stationId);
      if (previous) log.warn(`also in ${previous.sourceFile}; using ${station.sourceFile}`, station.stationId);
      byStation.set(station.stationId, station);
      log.ok(
        `${station.messages.length} OCPP messages · export ${day(station.exportFrom)} → ${day(station.exportTo)} UTC`,
        station.stationId,
      );
    } catch (err) {
      log.fail(`could not parse ${basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [...byStation.values()];
}

async function analyse(): Promise<string> {
  log.phase(2, PHASES, "ANALYSIS", "agent applies the business rules and recommends per station");
  dashboard.setPhase("ANALYSIS");
  log.plan(
    `Agent checks live connection, sessions & energy (last ${ANALYSIS_WINDOW_HOURS}h), error codes and firmware for ` +
      `${pendingStations().length} station(s), then submits one recommendation each`,
  );

  const started = Date.now();
  const run = await runAgent({
    instructions: ANALYSIS_PROMPT,
    query:
      `Check every loaded station and decide whether it is ready for a firmware upgrade. For each station: live ` +
      `connection status, complete sessions in the last ${ANALYSIS_WINDOW_HOURS}h and their stop/failure reasons, ` +
      `energy delivered, error codes in the last ${ANALYSIS_WINDOW_HOURS}h and current firmware version. Create a ` +
      `ticket for every station without connection. Submit one recommendation per station, then summarise.`,
    tools: ANALYSIS_TOOLS,
    pending: pendingStations,
    reminder: (pending) => `You have not called submit_recommendation for: ${pending.join(", ")}. Analyse and submit them, then summarise.`,
  });

  const recommendations = getRecommendations();
  record("Analysis", run, Date.now() - started);
  log.ok(`Analysis finished: ${recommendations.length} recommendation(s) in ${agentStats(run, Date.now() - started)}`);
  log.block(
    table(
      ["Station", "Verdict", "Firmware", "Connection", "Sessions", "kWh", "Errors"],
      recommendations.map((r) => [
        r.stationId,
        r.verdict,
        r.firmwareVersion,
        r.connectionStatus,
        String(r.completeSessions),
        String(r.energyDeliveredKWh),
        r.errorCodes.join(", ") || "-",
      ]),
    ),
  );
  for (const r of recommendations) log.agent(`${log.bold(r.stationId)}: ${r.summary}`);
  const missing = pendingStations();
  if (missing.length) log.warn(`No recommendation for ${missing.join(", ")}`);
  return run.text;
}

async function rollOut(enabled: boolean): Promise<string> {
  log.phase(3, PHASES, "UPGRADE", "send UpdateFirmware to the stations that passed analysis");
  dashboard.setPhase("UPGRADE");
  const candidates = upgradeCandidates();
  const skipped = getRecommendations().filter((x) => x.verdict !== "READY_FOR_UPGRADE");
  for (const r of skipped) log.info(`skipped — ${r.verdict}`, r.stationId);
  const ready = enabled && Boolean(TARGET_FIRMWARE_VERSION);
  dashboard.upgradesPlanned(
    ready ? candidates.map((r) => r.stationId) : [],
    [
      ...skipped.map((r) => ({ stationId: r.stationId, reason: `not upgraded — ${r.verdict}` })),
      ...(ready ? [] : candidates.map((r) => ({ stationId: r.stationId, reason: enabled ? "no target firmware configured" : "rollout disabled" }))),
    ],
  );

  const skip = (message: string, warn = false): string => {
    if (warn) log.warn(message);
    else log.info(message);
    return message;
  };
  if (!enabled) return skip("Upgrade phase disabled (--no-upgrade); recommendations only.");
  if (candidates.length === 0) return skip("No station is READY_FOR_UPGRADE — nothing to roll out.");
  if (!TARGET_FIRMWARE_VERSION) return skip("TARGET_FIRMWARE_VERSION is not set — cannot choose a firmware image, skipping rollout.", true);

  const ids = candidates.map((r) => r.stationId);
  log.plan(`Agent upgrades ${ids.join(", ")} to firmware ${TARGET_FIRMWARE_VERSION}, re-checking each station's connection first`);

  const started = Date.now();
  const run = await runAgent({
    instructions: UPGRADE_PROMPT,
    query:
      `Upgrade these READY_FOR_UPGRADE stations to firmware ${TARGET_FIRMWARE_VERSION}, one at a time. The decision ` +
      `to upgrade is final; the analysis notes are context only.\n` +
      candidates.map((r) => `- ${r.stationId} (current firmware ${r.firmwareVersion}). Analysis notes: ${r.summary}`).join("\n"),
    tools: UPGRADE_TOOLS,
    pending: pendingUpgrades,
    reminder: (pending) => `These stations have not been upgraded yet: ${pending.join(", ")}. Upgrade them or explain why not.`,
  });

  const attempts = getFirmwareAttempts();
  const reboots = getReboots();
  const postChecks = getPostChecks();
  record("Rollout", run, Date.now() - started);
  log.ok(
    `Rollout finished: ${attempts.length} UpdateFirmware attempt(s), ${reboots.length} recovery reboot(s) in ${agentStats(run, Date.now() - started)}`,
  );
  if (attempts.length) {
    log.block(
      table(
        ["Station", "Attempt", "Outcome", "Firmware statuses", "Then"],
        attempts.map((u) => {
          const reboot = reboots.find((r) => r.stationId === u.stationId && r.requestedAt >= u.startedAt && r.reason.includes(`attempt ${u.attempt})`));
          return [
            u.stationId,
            `${u.attempt}/${u.maxAttempts}`,
            u.outcome + (u.failedStatus ? ` (${u.failedStatus})` : ""),
            u.firmwareStatuses.map((s) => s.status).join(" → ") || "-",
            reboot ? `reboot → ${reboot.outcome}` : u.reportedFirmwareVersion ? `boot fw ${u.reportedFirmwareVersion}` : "-",
          ];
        }),
      ),
    );
  }
  if (postChecks.length) {
    const mark = (passed: boolean): string => (passed ? "✓" : "✗");
    log.block(
      table(
        ["Station", "Post-update", "Installation", "Connection", "Connectors", "24h follow-up due (UTC)"],
        postChecks.map((c) => [
          c.stationId,
          c.passed ? "PASSED" : "FAILED",
          mark(c.installationComplete.passed),
          mark(c.connection.passed),
          `${mark(c.connectorAvailability.passed)} ${c.connectorAvailability.detail}`,
          c.followUp.dueAt.slice(0, 16).replace("T", " "),
        ]),
      ),
    );
  }
  log.agent(run.text);
  return run.text;
}

/** Used when the report agent fails: same report, narrative stitched together from the earlier agent output. */
async function fallbackReport(analysisSummary: string, rolloutSummary: string): Promise<string> {
  const { kpis } = reportFacts();
  const nextActions = [...new Set(getRecommendations().flatMap((r) => r.nextActions.map((a) => `${r.stationId}: ${a}`)))];
  const { reportId } = await generateRunReport({
    headline: `${kpis.stations} station(s) checked · ${kpis.installed} upgraded · ${kpis.failed} failed · ${kpis.tickets} ticket(s)`,
    executiveSummary: `${analysisSummary}\n\n${rolloutSummary}`,
    stationHighlights: {},
    risks: [],
    nextActions,
    generatedBy: "fallback",
  });
  return reportId;
}

async function report(runLogPath: string, analysisSummary: string, rolloutSummary: string): Promise<string> {
  log.phase(4, PHASES, "REPORT", "agent writes the run summary report");
  dashboard.setPhase("REPORT");
  log.plan("Agent summarises the run for operations and stores the report (HTML, Markdown, JSON) for download");

  const started = Date.now();
  try {
    const run = await runAgent({
      instructions: REPORT_PROMPT,
      query:
        `Write the summary report for this run by calling generate_report.\n\n` +
        `## Analysis phase summary\n${analysisSummary}\n\n## Rollout phase summary\n${rolloutSummary}\n\n` +
        `## Run facts (verified, JSON)\n${JSON.stringify(reportFacts())}`,
      tools: REPORT_TOOLS,
      pending: () => (getGeneratedReportId() ? [] : ["generate_report"]),
      reminder: () => "You have not generated the report yet. Call generate_report now.",
    });
    log.ok(`Report agent finished in ${agentStats(run, Date.now() - started)}`);
  } catch (err) {
    log.warn(`Report agent failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let reportId = getGeneratedReportId();
  if (!reportId) {
    log.warn("No report from the agent — generating it from the run state instead");
    reportId = await fallbackReport(analysisSummary, rolloutSummary);
  }
  log.ok(`report: ${join(OUTPUT_DIR, "reports", reportId)} (download in the dashboard)`);
  log.ok(`run log (JSON lines): ${runLogPath}`);

  const tickets = getTickets();
  if (tickets.length) for (const t of tickets) log.info(`ticket ${t.id}: ${t.title}`, t.stationId);
  else log.info("no tickets created");
  return reportId;
}

/** One end-to-end run: ingest → analysis → upgrade → report. */
export async function runPipeline(files: string[], options: PipelineOptions): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runLogPath = join(OUTPUT_DIR, "runs", `run-${stamp}.jsonl`);
  startRunLog(runLogPath);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  log.banner(`Firmware readiness run ${stamp}`, `trigger: ${options.trigger} · ${files.length} file(s)`);
  dashboard.startRun(stamp, options.trigger, options.upgrade);

  const stations = await ingest(files);
  if (stations.length === 0) {
    dashboard.finishRun("failed", { error: "No usable files" });
    return log.fail("No usable files — run aborted.");
  }
  dashboard.loadStations(stations);

  const gateway = createMockGateway(stations);
  const stopFollowing = followOcppTraffic(gateway);
  startRun(stations, gateway, {
    runId: stamp,
    trigger: options.trigger,
    upgrade: options.upgrade,
    startedAt,
    inputFiles: stations.map((s) => basename(s.sourceFile)),
    model: AZURE_FOUNDRY_DEPLOYMENT,
    targetFirmwareVersion: TARGET_FIRMWARE_VERSION ?? null,
  });
  log.ok(`OCPP 2.0.1 gateway (mock) has a link to ${stations.length} station(s)`);

  try {
    const analysisSummary = await analyse();
    const rolloutSummary = await rollOut(options.upgrade);
    const reportId = await report(runLogPath, analysisSummary, rolloutSummary);
    log.banner(`Run finished in ${seconds(Date.now() - started)}`);
    dashboard.finishRun("finished", { report: reportId });
  } catch (err) {
    dashboard.finishRun("failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    stopFollowing();
  }
}
