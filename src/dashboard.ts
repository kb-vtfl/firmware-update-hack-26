import { FIRMWARE_MAX_ATTEMPTS, TARGET_FIRMWARE_VERSION } from "./config.js";
import type { LogEntry } from "./logger.js";
import { rowView, stationSnapshot, type StationSnapshot, type XlsxRowView } from "./snapshot.js";
import { simulation, type FailureMode } from "./simulation.js";
import type { OcppMessage, PostUpdateCheckResult, Recommendation, StationLog, Ticket } from "./types.js";

/**
 * Live state behind the browser dashboard. The pipeline, agent loop and OCPP gateway report what happens here;
 * the server streams it to the browser. Without a browser attached this is just a cheap in-memory record.
 */

export type Rule = "connection" | "sessions" | "energy" | "errors" | "firmware";
export type PhaseName = "INGEST" | "ANALYSIS" | "UPGRADE" | "REPORT";

export interface RuleCheck {
  status: "running" | "pass" | "warn" | "fail";
  value: string;
  rows: XlsxRowView[];
  tool: string;
  at: string;
}

export interface FirmwareAttempt {
  attempt: number;
  startedAt: string;
  statuses: Array<{ status: string; at: string }>;
  outcome: string | null;
  failedStatus: string | null;
  requestId: number | null;
  reportedVersion: string | null;
}

export interface RecoveryReboot {
  afterAttempt: number;
  requestedAt: string;
  state: "requested" | "offline" | "booted" | "failed";
  bootedAt: string | null;
  downtimeMs: number | null;
  firmwareVersion: string | null;
}

export interface FirmwareProgress {
  state: "idle" | "queued" | "skipped" | "running" | "recovering" | "installed" | "scheduled" | "failed";
  note: string | null;
  previousVersion: string | null;
  targetVersion: string | null;
  currentVersion: string | null;
  attempts: FirmwareAttempt[];
  reboots: RecoveryReboot[];
  maxAttempts: number;
  /** True while the station's connection is down (reboot after installation or recovery Reset). */
  rebooting: boolean;
  location: string | null;
}

export interface PostCheckView {
  status: "running" | "pass" | "fail";
  result: PostUpdateCheckResult | null;
}

export interface StationState {
  activity: { tool: string; intent: string; startedAt: string } | null;
  checks: Partial<Record<Rule, RuleCheck>>;
  live: { status: string; roundTripMs: number | null; checkedAt: string; problems: string[] } | null;
  liveConnectors: Record<string, { connectorStatus: string; at: string }>;
  recommendation: Recommendation | null;
  firmware: FirmwareProgress;
  postCheck: PostCheckView | null;
  ticket: Ticket | null;
}

export interface DashboardState {
  run: {
    id: string;
    status: "running" | "finished" | "failed";
    trigger: string;
    upgrade: boolean;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
    report: string | null;
  } | null;
  phases: Array<{ name: PhaseName; status: "pending" | "active" | "done" }>;
  agent: { thinking: boolean; step: number };
  stations: Record<string, StationState>;
  tickets: Ticket[];
  settings: {
    firmwareStepMs: number;
    targetFirmwareVersion: string | null;
    maxAttempts: number;
    failures: Record<string, FailureMode>;
  };
}

const PHASES: PhaseName[] = ["INGEST", "ANALYSIS", "UPGRADE", "REPORT"];
const RULES_BY_TOOL: Record<string, Rule[]> = {
  get_connection_status: ["connection"],
  get_sessions: ["sessions", "energy"],
  get_errors: ["errors"],
  get_firmware_info: ["firmware"],
};
const MAX_LOGS = 3000;
const MAX_EVIDENCE_ROWS = 12;

type Change = "state" | "stations";
type Result = Record<string, unknown>;

let snapshots: StationSnapshot[] = [];
const rowIndex = new Map<string, Map<number, OcppMessage>>();
const logs: LogEntry[] = [];
const listeners = new Set<(change: Change) => void>();
let pending: Set<Change> = new Set();
let flushTimer: NodeJS.Timeout | undefined;

const now = (): string => new Date().toISOString();

const freshPhases = (): DashboardState["phases"] => PHASES.map((name) => ({ name, status: "pending" }));

function freshStation(snapshot: StationSnapshot): StationState {
  return {
    activity: null,
    checks: {},
    live: null,
    liveConnectors: {},
    recommendation: null,
    firmware: {
      state: "idle",
      note: null,
      previousVersion: snapshot.firmwareVersion,
      targetVersion: null,
      currentVersion: snapshot.firmwareVersion,
      attempts: [],
      reboots: [],
      maxAttempts: FIRMWARE_MAX_ATTEMPTS,
      rebooting: false,
      location: null,
    },
    postCheck: null,
    ticket: null,
  };
}

const state: DashboardState = {
  run: null,
  phases: freshPhases(),
  agent: { thinking: false, step: 0 },
  stations: {},
  tickets: [],
  settings: {
    firmwareStepMs: simulation.firmwareStepMs,
    targetFirmwareVersion: TARGET_FIRMWARE_VERSION ?? null,
    maxAttempts: FIRMWARE_MAX_ATTEMPTS,
    failures: simulation.failures,
  },
};

function changed(change: Change): void {
  pending.add(change);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const batch = pending;
    pending = new Set();
    for (const c of batch) for (const listener of listeners) listener(c);
  }, 40);
}

const station = (id: string | undefined): StationState | undefined => (id ? state.stations[id] : undefined);

function evidence(stationId: string, rows: Array<number | null | undefined>): XlsxRowView[] {
  const index = rowIndex.get(stationId);
  const unique = [...new Set(rows.filter((r): r is number => typeof r === "number"))];
  return unique
    .map((r) => index?.get(r))
    .filter((m): m is OcppMessage => m !== undefined)
    .sort((a, b) => b.time.getTime() - a.time.getTime())
    .slice(0, MAX_EVIDENCE_ROWS)
    .map(rowView);
}

const list = (value: unknown): Result[] => (Array.isArray(value) ? (value as Result[]) : []);

/** Turns a tool result into rule checks, each pointing at the xlsx rows it is based on. */
function checksFromResult(stationId: string, tool: string, result: Result): Partial<Record<Rule, RuleCheck>> {
  const at = now();
  const check = (status: RuleCheck["status"], value: string, rows: Array<number | null | undefined>): RuleCheck => ({
    status,
    value,
    rows: evidence(stationId, rows),
    tool,
    at,
  });
  const snapshot = snapshots.find((s) => s.stationId === stationId);

  switch (tool) {
    case "get_connection_status": {
      const evses = list(result["evses"]);
      const faulted = Number(result["faultedEvses"]) > 0;
      const connected = result["status"] === "CONNECTED";
      const value = connected
        ? `live CONNECTED${result["roundTripMs"] !== null ? ` · ${String(result["roundTripMs"])} ms` : ""} · ` +
          (evses.map((e) => `EVSE ${String(e["evseId"])} ${String(e["connectorStatus"])}`).join(", ") || "no EVSE status")
        : "live NO_CONNECTION · station did not answer";
      const rows = [snapshot?.connection.row, ...(snapshot?.connectors.map((c) => c.row) ?? [])];
      return { connection: check(!connected || faulted ? "fail" : "pass", value, rows) };
    }
    case "get_sessions": {
      const views = list(result["sessions"]);
      const rows = views.flatMap((s) => {
        const r = (s["xlsxRows"] ?? {}) as { start?: number | null; stop?: number | null };
        return [r.start, r.stop];
      });
      const complete = Number(result["completeSessions"]);
      const stops = Object.entries((result["stopReasons"] as Record<string, number>) ?? {})
        .map(([k, v]) => `${k}×${v}`)
        .join(", ");
      const low = result["energyBelowThreshold"] === true;
      const lowSessions = Number(result["sessionsBelowThreshold"]);
      return {
        sessions: check(
          complete === 0 ? "fail" : Number(result["abnormalStops"]) > 0 ? "warn" : "pass",
          `${complete} complete session(s)${stops ? ` · ${stops}` : ""}`,
          rows,
        ),
        energy: check(
          low ? "fail" : lowSessions > 0 ? "warn" : "pass",
          `${String(result["energyDeliveredKWh"])} kWh${lowSessions ? ` · ${lowSessions} session(s) < ${String(result["lowEnergyThresholdKWh"])} kWh` : ""}`,
          rows,
        ),
      };
    }
    case "get_errors": {
      const groups = list(result["errorGroups"]);
      const events = list(result["notableEvents"]);
      const rows = [...groups.flatMap((g) => (g["xlsxRows"] as number[]) ?? []), ...events.map((e) => e["xlsxRow"] as number)];
      if (result["hasErrorCodes"] === true) {
        const codes = groups.map((g) => `${String(g["errorCode"])}×${String(g["count"])}`).join(", ");
        return { errors: check("fail", codes || "CALLERROR(s) present", rows) };
      }
      return { errors: check(events.length ? "warn" : "pass", `no error codes${events.length ? ` · ${events.length} notable event(s)` : ""}`, rows) };
    }
    case "get_firmware_info":
      return {
        firmware:
          result["known"] === true
            ? check("pass", `firmware ${String(result["firmwareVersion"])}`, [result["xlsxRow"] as number])
            : check("warn", "firmware unknown · no BootNotification in export", []),
      };
    default:
      return {};
  }
}

// --- inputs from the pipeline / agent / gateway ---

export function onDashboardChange(listener: (change: Change) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getSnapshots = (): StationSnapshot[] => snapshots;
export const getState = (): DashboardState => state;
export const getLogs = (): LogEntry[] => logs;

export function addLog(entry: LogEntry): void {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

/** New set of station exports: rebuild the "initial state" view and forget everything from earlier runs. */
export function loadStations(stationLogs: StationLog[]): void {
  snapshots = stationLogs.map(stationSnapshot);
  rowIndex.clear();
  for (const log of stationLogs) rowIndex.set(log.stationId, new Map(log.messages.map((m) => [m.row, m])));
  state.stations = Object.fromEntries(snapshots.map((s) => [s.stationId, freshStation(s)]));
  state.tickets = [];
  changed("stations");
  changed("state");
}

export function startRun(id: string, trigger: string, upgrade: boolean): void {
  state.run = { id, status: "running", trigger, upgrade, startedAt: now(), finishedAt: null, error: null, report: null };
  state.phases = freshPhases();
  state.agent = { thinking: false, step: 0 };
  changed("state");
}

export function setPhase(name: PhaseName): void {
  let reached = false;
  for (const phase of state.phases) {
    if (phase.name === name) {
      phase.status = "active";
      reached = true;
    } else if (!reached) phase.status = "done";
  }
  changed("state");
}

export function finishRun(status: "finished" | "failed", details: { error?: string; report?: string } = {}): void {
  if (!state.run) return;
  state.run.status = status;
  state.run.finishedAt = now();
  state.run.error = details.error ?? null;
  state.run.report = details.report ?? null;
  if (status === "finished") for (const phase of state.phases) phase.status = "done";
  state.agent.thinking = false;
  for (const s of Object.values(state.stations)) s.activity = null;
  changed("state");
}

export function agentThinking(step: number, thinking: boolean): void {
  state.agent = { thinking, step };
  changed("state");
}

export function toolStarted(stationId: string | undefined, tool: string, intent: string, args: Result): void {
  const s = station(stationId);
  if (!s) return;
  s.activity = { tool, intent, startedAt: now() };
  for (const rule of RULES_BY_TOOL[tool] ?? []) {
    s.checks[rule] = { status: "running", value: s.checks[rule]?.value ?? "checking…", rows: s.checks[rule]?.rows ?? [], tool, at: now() };
  }
  const fw = s.firmware;
  if (tool === "upgrade_firmware") {
    fw.state = "running";
    fw.note = `UpdateFirmware sent (attempt ${fw.attempts.length + 1}/${fw.maxAttempts})`;
    fw.targetVersion = typeof args["targetVersion"] === "string" ? args["targetVersion"] : (TARGET_FIRMWARE_VERSION ?? null);
    fw.attempts.push({
      attempt: fw.attempts.length + 1,
      startedAt: now(),
      statuses: [],
      outcome: null,
      failedStatus: null,
      requestId: null,
      reportedVersion: null,
    });
  }
  if (tool === "reboot_station") {
    fw.state = "recovering";
    fw.note = "Reset(Immediate) sent — rebooting the station before retrying";
    fw.reboots.push({ afterAttempt: fw.attempts.length, requestedAt: now(), state: "requested", bootedAt: null, downtimeMs: null, firmwareVersion: null });
  }
  if (tool === "post_update_check") s.postCheck = { status: "running", result: null };
  changed("state");
}

export function toolFinished(
  stationId: string | undefined,
  tool: string,
  result: unknown,
  context: { recommendation?: Recommendation | undefined; ticket?: Ticket | undefined },
): void {
  const s = station(stationId);
  if (!s || !stationId) return;
  const r = (result ?? {}) as Result;
  s.activity = null;

  if (typeof r["error"] === "string") {
    for (const rule of RULES_BY_TOOL[tool] ?? []) {
      s.checks[rule] = { status: "fail", value: String(r["error"]), rows: [], tool, at: now() };
    }
  } else {
    Object.assign(s.checks, checksFromResult(stationId, tool, r));
  }

  if (tool === "get_connection_status") {
    s.live = {
      status: String(r["status"]),
      roundTripMs: (r["roundTripMs"] as number | null) ?? null,
      checkedAt: String(r["checkedAt"] ?? now()),
      problems: (r["problems"] as string[]) ?? [],
    };
    for (const e of list(r["evses"])) {
      s.liveConnectors[String(e["evseId"])] = { connectorStatus: String(e["connectorStatus"]), at: String(e["timestamp"]) };
    }
  }
  if (tool === "submit_recommendation" && context.recommendation) s.recommendation = context.recommendation;
  if (tool === "create_ticket" && context.ticket) {
    s.ticket = context.ticket;
    if (!state.tickets.some((t) => t.id === context.ticket?.id)) state.tickets.push(context.ticket);
  }
  const fw = s.firmware;
  if (tool === "upgrade_firmware") {
    const attempt = fw.attempts.at(-1);
    if (r["sent"] === false) {
      if (attempt && attempt.outcome === null) fw.attempts.pop();
      fw.note = `refused: ${String(r["refused"])}`;
      if (fw.attempts.length === 0) fw.state = "failed";
    } else {
      const outcome = String(r["outcome"]);
      if (attempt) {
        attempt.outcome = outcome;
        attempt.failedStatus = (r["failedStatus"] as string | null) ?? null;
        attempt.requestId = Number(r["requestId"]);
        attempt.reportedVersion = (r["reportedFirmwareVersion"] as string | null) ?? null;
      }
      const attemptsLeft = Number(r["attemptsLeft"] ?? 0);
      const retryable = outcome === "FAILED" && attempt?.failedStatus !== null && attemptsLeft > 0;
      fw.state = outcome === "INSTALLED" ? "installed" : outcome === "INSTALL_SCHEDULED" ? "scheduled" : retryable ? "recovering" : "failed";
      fw.note =
        outcome === "INSTALLED"
          ? `Installed on attempt ${String(r["attempt"])} — station reports ${String(r["reportedFirmwareVersion"])}`
          : retryable
            ? `${String(attempt?.failedStatus)} on attempt ${String(r["attempt"])} — agent recovers with a reboot and retries (${attemptsLeft} attempt(s) left)`
            : list(r["problems"]).length
              ? (r["problems"] as string[]).join(" ")
              : outcome;
      fw.previousVersion = String(r["previousVersion"]);
      fw.targetVersion = String(r["targetVersion"]);
      fw.location = String(r["location"]);
      fw.rebooting = false;
      fw.currentVersion = (r["reportedFirmwareVersion"] as string | null) ?? fw.currentVersion;
    }
  }
  if (tool === "reboot_station") {
    const reboot = fw.reboots.at(-1);
    if (r["sent"] === false) {
      if (reboot && reboot.state === "requested") fw.reboots.pop();
      fw.note = `reboot refused: ${String(r["refused"])}`;
    } else if (reboot) {
      const ok = r["outcome"] === "REBOOTED";
      reboot.state = ok ? "booted" : "failed";
      reboot.bootedAt = (r["bootedAt"] as string | null) ?? null;
      reboot.downtimeMs = (r["downtimeMs"] as number | null) ?? null;
      reboot.firmwareVersion = (r["firmwareVersion"] as string | null) ?? null;
      fw.rebooting = false;
      fw.state = ok ? "recovering" : "failed";
      fw.note = ok
        ? `Station back online after ${((reboot.downtimeMs ?? 0) / 1000).toFixed(1)} s (firmware ${reboot.firmwareVersion}) — retrying the update`
        : `Recovery reboot ${String(r["outcome"])}`;
    }
  }
  if (tool === "post_update_check") {
    const result = typeof r["error"] === "string" ? null : (r as unknown as PostUpdateCheckResult);
    s.postCheck = { status: result?.passed ? "pass" : "fail", result };
  }
  changed("state");
}

export function upgradesPlanned(candidates: string[], skipped: Array<{ stationId: string; reason: string }>): void {
  for (const id of candidates) {
    const s = station(id);
    if (s) s.firmware = { ...s.firmware, state: "queued", note: `queued for ${TARGET_FIRMWARE_VERSION ?? "target firmware"}` };
  }
  for (const { stationId, reason } of skipped) {
    const s = station(stationId);
    if (s) s.firmware = { ...s.firmware, state: "skipped", note: reason };
  }
  changed("state");
}

export function firmwareStatus(stationId: string, status: string): void {
  const s = station(stationId);
  const attempt = s?.firmware.attempts.at(-1);
  if (!s || !attempt) return;
  attempt.statuses.push({ status, at: now() });
  changed("state");
}

/** The station's OCPP connection dropped or came back (reboots show up this way). */
export function stationLink(stationId: string, online: boolean): void {
  const s = station(stationId);
  if (!s) return;
  s.firmware.rebooting = !online;
  const reboot = s.firmware.reboots.at(-1);
  if (!online && reboot?.state === "requested") reboot.state = "offline";
  changed("state");
}

export function setFailureMode(stationId: string, mode: FailureMode): void {
  if (mode === "none") delete simulation.failures[stationId];
  else simulation.failures[stationId] = mode;
  state.settings.failures = simulation.failures;
  changed("state");
}

export function stationBooted(stationId: string, firmwareVersion: string | null): void {
  const s = station(stationId);
  if (!s) return;
  s.firmware.rebooting = false;
  const attempt = s.firmware.attempts.at(-1);
  if (attempt && attempt.outcome === null && firmwareVersion) attempt.reportedVersion = firmwareVersion;
  if (firmwareVersion) s.firmware.currentVersion = firmwareVersion;
  changed("state");
}

export function connectorStatus(stationId: string, evseId: number, connectorStatus: string): void {
  const s = station(stationId);
  if (!s) return;
  s.liveConnectors[String(evseId)] = { connectorStatus, at: now() };
  changed("state");
}

export function setFirmwareStepMs(ms: number): void {
  simulation.firmwareStepMs = ms;
  state.settings.firmwareStepMs = ms;
  changed("state");
}
