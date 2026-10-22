import {
  ANALYSIS_WINDOW_HOURS,
  FIRMWARE_LOCATION_TEMPLATE,
  FIRMWARE_MAX_ATTEMPTS,
  FOLLOW_UP_DELAY_HOURS,
  LOW_ENERGY_THRESHOLD_KWH,
  OCPP_TRAFFIC_LOG,
  TARGET_FIRMWARE_VERSION,
} from "./config.js";
import { scheduleFollowUp } from "./followUps.js";
import {
  connectionStatus,
  errors,
  findMessages,
  firmwareInfo,
  latestConnectorStatuses,
  sessions,
  stationOverview,
} from "./ocpp.js";
import { checkLiveConnection, firmwareLocation, rebootStation, updateFirmware } from "./stationCommands.js";
import type { StationGateway } from "./stationGateway.js";
import { createTicket } from "./tickets.js";
import type {
  FirmwareUpdateResult,
  FollowUp,
  LiveConnectionResult,
  PostUpdateCheckResult,
  RebootResult,
  Recommendation,
  StationLog,
  Ticket,
  ToolDefinition,
  Verdict,
} from "./types.js";

const VERDICTS: Verdict[] = ["READY_FOR_UPGRADE", "NEEDS_INVESTIGATION", "NOT_READY", "ALREADY_ON_TARGET"];
const SEVERITY_RANK: Record<Verdict, number> = {
  READY_FOR_UPGRADE: 0,
  ALREADY_ON_TARGET: 1,
  NEEDS_INVESTIGATION: 2,
  NOT_READY: 3,
};

let stations: StationLog[] = [];
let gateway: StationGateway | undefined;
const tickets = new Map<string, Ticket>();
const recommendations = new Map<string, Recommendation>();
const liveConnections = new Map<string, LiveConnectionResult>();
const firmwareAttempts = new Map<string, FirmwareUpdateResult[]>();
const reboots = new Map<string, RebootResult[]>();
const postChecks = new Map<string, PostUpdateCheckResult>();

/** Resets all per-run state; called once per batch of uploaded files. */
export function startRun(logs: StationLog[], stationGateway: StationGateway): void {
  stations = logs;
  gateway = stationGateway;
  tickets.clear();
  recommendations.clear();
  liveConnections.clear();
  firmwareAttempts.clear();
  reboots.clear();
  postChecks.clear();
}

export const getTickets = (): Ticket[] => [...tickets.values()];
export const getRecommendations = (): Recommendation[] => [...recommendations.values()];
export const getLiveConnections = (): LiveConnectionResult[] => [...liveConnections.values()];
/** Latest attempt per station. */
export const getFirmwareUpdates = (): FirmwareUpdateResult[] =>
  [...firmwareAttempts.values()].map((a) => a.at(-1)).filter((a): a is FirmwareUpdateResult => a !== undefined);
export const getFirmwareAttempts = (): FirmwareUpdateResult[] => [...firmwareAttempts.values()].flat();
export const getReboots = (): RebootResult[] => [...reboots.values()].flat();
export const getPostChecks = (): PostUpdateCheckResult[] => [...postChecks.values()];
export const getFollowUps = (): FollowUp[] => getPostChecks().map((c) => c.followUp);
export const pendingStations = (): string[] =>
  stations.map((s) => s.stationId).filter((id) => !recommendations.has(id));

// --- argument helpers ---

const text = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string).trim() : "";

const textList = (args: Record<string, unknown>, key: string): string[] =>
  Array.isArray(args[key]) ? (args[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];

function hoursArg(args: Record<string, unknown>): number {
  const hours = Number(args["hours"]);
  return Number.isFinite(hours) && hours > 0 ? hours : ANALYSIS_WINDOW_HOURS;
}

function dateArg(args: Record<string, unknown>, key: string): Date | undefined {
  const raw = text(args, key);
  const d = raw ? new Date(raw) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
}

function station(args: Record<string, unknown>): StationLog {
  const id = text(args, "stationId");
  const found = stations.find((s) => s.stationId.toLowerCase() === id.toLowerCase());
  if (!found) {
    throw new Error(`Unknown stationId "${id}". Loaded stations: ${stations.map((s) => s.stationId).join(", ")}`);
  }
  return found;
}

function requireGateway(): StationGateway {
  if (!gateway) throw new Error("No OCPP gateway configured");
  return gateway;
}

/** Raw frames stay in the traffic log; the model only needs the interpreted result. */
function withoutFrames<T extends { ocppExchange: unknown[] }>(result: T): Omit<T, "ocppExchange"> & { ocppFrames: string } {
  const { ocppExchange, ...rest } = result;
  return { ...rest, ocppFrames: `${ocppExchange.length} frames logged to ${OCPP_TRAFFIC_LOG}` };
}

// --- tool implementations ---

async function runGetConnectionStatus(args: Record<string, unknown>): Promise<unknown> {
  const log = station(args);
  const evseIds = [...latestConnectorStatuses(log).keys()];
  const result = await checkLiveConnection(requireGateway(), log.stationId, evseIds.length > 0 ? evseIds : [1]);
  liveConnections.set(log.stationId, result);
  return withoutFrames(result);
}

const RETRYABLE_FAILURES = ["DownloadFailed", "InstallationFailed"];

async function runUpgradeFirmware(args: Record<string, unknown>): Promise<unknown> {
  const log = station(args);
  const refuse = (reason: string): unknown => ({ sent: false, refused: reason });

  const recommendation = recommendations.get(log.stationId);
  if (recommendation?.verdict !== "READY_FOR_UPGRADE") {
    return refuse(`Only stations with an accepted READY_FOR_UPGRADE recommendation can be upgraded (current: ${recommendation?.verdict ?? "none"}).`);
  }

  const attempts = firmwareAttempts.get(log.stationId) ?? [];
  const last = attempts.at(-1);
  if (last) {
    if (last.outcome === "INSTALLED" || last.outcome === "INSTALL_SCHEDULED") return refuse(`Already ${last.outcome}; nothing to retry.`);
    if (last.outcome !== "FAILED" || !RETRYABLE_FAILURES.includes(last.failedStatus ?? "")) {
      return refuse(`Attempt ${last.attempt} ended in ${last.outcome}; only DownloadFailed / InstallationFailed are retried. Create a ticket.`);
    }
    if (attempts.length >= FIRMWARE_MAX_ATTEMPTS) {
      return refuse(`All ${FIRMWARE_MAX_ATTEMPTS} attempts used. Create a ticket with the attempt history.`);
    }
    const reboot = reboots.get(log.stationId)?.at(-1);
    if (!reboot || reboot.requestedAt < last.startedAt) return refuse(`Attempt ${last.attempt} failed with ${last.failedStatus}: call reboot_station before retrying.`);
    if (reboot.outcome !== "REBOOTED") return refuse(`The recovery reboot ended in ${reboot.outcome}; the station is not back. Create a ticket.`);
  } else {
    const live = liveConnections.get(log.stationId);
    if (live?.status !== "CONNECTED") return refuse("Call get_connection_status first; the station must be CONNECTED.");
    if (live.faultedEvses > 0) return refuse("Station reports a Faulted EVSE.");
  }

  const firmware = firmwareInfo(log);
  const previousVersion = typeof firmware["firmwareVersion"] === "string" ? firmware["firmwareVersion"] : "unknown";
  const targetVersion = text(args, "targetVersion") || TARGET_FIRMWARE_VERSION || "";
  if (!targetVersion) return refuse("No targetVersion given and TARGET_FIRMWARE_VERSION is not configured.");
  if (targetVersion === previousVersion) return refuse(`Station already runs ${targetVersion}.`);

  const model = typeof firmware["chargePointModel"] === "string" ? firmware["chargePointModel"] : "unknown";
  const location = firmwareLocation(FIRMWARE_LOCATION_TEMPLATE, { version: targetVersion, model, stationId: log.stationId });

  const result = await updateFirmware(requireGateway(), {
    stationId: log.stationId,
    previousVersion,
    targetVersion,
    location,
    attempt: attempts.length + 1,
    maxAttempts: FIRMWARE_MAX_ATTEMPTS,
  });
  firmwareAttempts.set(log.stationId, [...attempts, result]);

  const retryable = result.outcome === "FAILED" && RETRYABLE_FAILURES.includes(result.failedStatus ?? "");
  const attemptsLeft = FIRMWARE_MAX_ATTEMPTS - result.attempt;
  return {
    sent: true,
    ...withoutFrames(result),
    attemptsLeft,
    next:
      result.outcome === "INSTALLED"
        ? "Run post_update_check."
        : retryable && attemptsLeft > 0
          ? "Recover: reboot_station, then upgrade_firmware again."
          : result.outcome === "INSTALL_SCHEDULED"
            ? "Nothing to do; the station installs after the running transaction."
            : "Create a ticket with the attempt history.",
  };
}

async function runRebootStation(args: Record<string, unknown>): Promise<unknown> {
  const log = station(args);
  const refuse = (reason: string): unknown => ({ sent: false, refused: reason });
  const attempts = firmwareAttempts.get(log.stationId) ?? [];
  const last = attempts.at(-1);
  if (!last || last.outcome !== "FAILED" || !RETRYABLE_FAILURES.includes(last.failedStatus ?? "")) {
    return refuse("reboot_station is only used to recover from a DownloadFailed / InstallationFailed firmware attempt.");
  }
  const previous = reboots.get(log.stationId) ?? [];
  if (previous.some((r) => r.requestedAt >= last.startedAt)) return refuse("The station was already rebooted after this failed attempt.");

  const result = await rebootStation(requireGateway(), log.stationId, `recover from ${last.failedStatus} (attempt ${last.attempt})`);
  reboots.set(log.stationId, [...previous, result]);
  return { sent: true, ...withoutFrames(result), attemptsLeft: FIRMWARE_MAX_ATTEMPTS - attempts.length };
}

/** "Immediately after" snapshot plus the 24h follow-up that repeats the pre-update rules. */
async function runPostUpdateCheck(args: Record<string, unknown>): Promise<unknown> {
  const log = station(args);
  const last = firmwareAttempts.get(log.stationId)?.at(-1);
  if (last?.outcome !== "INSTALLED") return { error: "post_update_check needs a firmware attempt that ended INSTALLED." };

  const evseIds = [...latestConnectorStatuses(log).keys()];
  const live = await checkLiveConnection(requireGateway(), log.stationId, evseIds.length > 0 ? evseIds : [1]);
  liveConnections.set(log.stationId, live);

  const sawInstalled = last.firmwareStatuses.some((s) => s.status === "Installed");
  const versionOk = last.reportedFirmwareVersion === last.targetVersion;
  const unavailable = live.evses.filter((e) => e.connectorStatus === "Faulted" || e.connectorStatus === "Unavailable");
  const missing = (evseIds.length || 1) - live.evses.length;
  const checkedAt = new Date();

  const followUp: FollowUp = {
    stationId: log.stationId,
    createdAt: checkedAt.toISOString(),
    dueAt: new Date(checkedAt.getTime() + FOLLOW_UP_DELAY_HOURS * 3_600_000).toISOString(),
    firmwareVersion: last.targetVersion,
    checks: [
      "Connection status",
      `Complete sessions (StartTransaction + StopTransaction) in the last ${ANALYSIS_WINDOW_HOURS}h and their failure reasons`,
      `Energy delivered in those sessions (>= ${LOW_ENERGY_THRESHOLD_KWH} kWh)`,
      `Error codes in the last ${ANALYSIS_WINDOW_HOURS}h`,
      `Firmware version is ${last.targetVersion}`,
    ],
  };

  const result: PostUpdateCheckResult = {
    stationId: log.stationId,
    checkedAt: checkedAt.toISOString(),
    passed: false,
    installationComplete: {
      passed: sawInstalled && versionOk,
      detail: sawInstalled
        ? `FirmwareStatusNotification Installed · BootNotification reports ${last.reportedFirmwareVersion ?? "no version"} (target ${last.targetVersion})`
        : "no Installed status received",
    },
    connection: {
      passed: live.status === "CONNECTED",
      detail: live.status === "CONNECTED" ? `CONNECTED · ${live.roundTripMs ?? "?"} ms round trip` : `NO_CONNECTION · ${live.problems.join("; ")}`,
    },
    connectorAvailability: {
      passed: unavailable.length === 0 && missing <= 0,
      detail:
        live.evses.map((e) => `EVSE ${e.evseId} ${e.connectorStatus}`).join(", ") +
        (missing > 0 ? ` · ${missing} EVSE(s) sent no StatusNotification` : ""),
      evses: live.evses.map((e) => ({ evseId: e.evseId, connectorStatus: e.connectorStatus })),
    },
    followUp,
  };
  result.passed = result.installationComplete.passed && result.connection.passed && result.connectorAvailability.passed;
  postChecks.set(log.stationId, result);
  await scheduleFollowUp(followUp);
  return result;
}

async function runCreateTicket(args: Record<string, unknown>): Promise<unknown> {
  const log = station(args);
  const existing = tickets.get(log.stationId);
  if (existing) return { note: "A ticket already exists for this station in this run.", ticket: existing };

  const title = text(args, "title");
  const reason = text(args, "reason");
  if (!title || !reason) return { error: "title and reason are required." };

  const ticket = await createTicket({
    stationId: log.stationId,
    title,
    severity: text(args, "severity") || "high",
    reason,
    details: text(args, "details"),
  });
  tickets.set(log.stationId, ticket);
  return { created: true, ticket };
}

/** Business rules are enforced here too, so a model slip cannot produce an unsafe "ready" verdict. */
function runSubmitRecommendation(args: Record<string, unknown>): unknown {
  const log = station(args);
  const verdict = text(args, "verdict") as Verdict;
  if (!VERDICTS.includes(verdict)) return { error: `verdict must be one of ${VERDICTS.join(", ")}` };

  const live = liveConnections.get(log.stationId);
  if (!live) return { accepted: false, problems: ["Call get_connection_status (live OCPP check) for this station first."] };

  const sessionFacts = sessions(log, ANALYSIS_WINDOW_HOURS);
  const errorFacts = errors(log, ANALYSIS_WINDOW_HOURS);
  const firmware = firmwareInfo(log);

  const problems: string[] = [];
  let minimum: Verdict = "READY_FOR_UPGRADE";
  const atLeast = (v: Verdict): void => {
    if (SEVERITY_RANK[v] > SEVERITY_RANK[minimum]) minimum = v;
  };

  if (live.status === "NO_CONNECTION") {
    atLeast("NOT_READY");
    if (!tickets.has(log.stationId)) problems.push("Station has NO_CONNECTION: call create_ticket before submitting.");
  }
  if (live.faultedEvses > 0 || errorFacts["hasErrorCodes"] === true) atLeast("NOT_READY");
  if (sessionFacts["energyBelowThreshold"] === true || sessionFacts["completeSessions"] === 0) atLeast("NEEDS_INVESTIGATION");
  if (firmware["known"] !== true) atLeast("NEEDS_INVESTIGATION");
  if (firmware["onTarget"] === true) atLeast("ALREADY_ON_TARGET");

  if (SEVERITY_RANK[verdict] < SEVERITY_RANK[minimum]) {
    problems.push(`The facts require at least ${minimum} (you submitted ${verdict}). Re-check the business rules.`);
  }
  if (verdict === "ALREADY_ON_TARGET" && firmware["onTarget"] !== true) {
    problems.push("ALREADY_ON_TARGET is only allowed when get_firmware_info reports onTarget = true.");
  }
  const completeSessions = Number(args["completeSessions"]);
  if (completeSessions !== sessionFacts["completeSessions"]) {
    problems.push(`completeSessions must be ${String(sessionFacts["completeSessions"])} (from get_sessions).`);
  }
  const energy = Number(args["energyDeliveredKWh"]);
  if (Math.abs(energy - Number(sessionFacts["energyDeliveredKWh"])) > 0.01) {
    problems.push(`energyDeliveredKWh must be ${String(sessionFacts["energyDeliveredKWh"])} (from get_sessions).`);
  }
  if (problems.length > 0) return { accepted: false, problems };

  const recommendation: Recommendation = {
    stationId: log.stationId,
    verdict,
    firmwareVersion: text(args, "firmwareVersion") || "unknown",
    connectionStatus: live.status,
    completeSessions,
    energyDeliveredKWh: energy,
    errorCodes: textList(args, "errorCodes"),
    ticketId: tickets.get(log.stationId)?.id,
    reasons: textList(args, "reasons"),
    nextActions: textList(args, "nextActions"),
    summary: text(args, "summary"),
  };
  recommendations.set(log.stationId, recommendation);
  return { accepted: true, stillPending: pendingStations() };
}

// --- tool schemas ---

const stationIdParam = { type: "string", description: "Station chargeBoxId, as returned by list_stations." };
const hoursParam = {
  type: "number",
  description: `Look-back window in hours, counted back from the station's asOf time. Default ${ANALYSIS_WINDOW_HOURS}.`,
};

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    name: "list_stations",
    description: "Lists the loaded station log exports: stationId, export window, asOf time and message counts per action.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_connection_status",
    description:
      "Rule 1 (live). Contacts the station over OCPP 2.0.1: TriggerMessage(Heartbeat), then " +
      "TriggerMessage(StatusNotification) per EVSE. Returns CONNECTED / NO_CONNECTION, round-trip time and the " +
      "current connectorStatus of every EVSE (Available, Occupied, Reserved, Unavailable, Faulted).",
    parameters: { type: "object", properties: { stationId: stationIdParam }, required: ["stationId"] },
  },
  {
    type: "function",
    name: "get_connection_history",
    description:
      "Context for rule 1 from the log export: silence since the last station message vs. the heartbeat interval, " +
      "heartbeat counts and the longest silence in the window.",
    parameters: { type: "object", properties: { stationId: stationIdParam, hours: hoursParam }, required: ["stationId"] },
  },
  {
    type: "function",
    name: "get_sessions",
    description:
      "Rules 2-3. Pairs StartTransaction/StopTransaction messages into sessions. Returns the number of complete " +
      "sessions stopped in the window, total energy delivered (kWh), whether it is below the low-energy threshold, " +
      "stop reasons, rejected starts, error codes raised during sessions and the per-session list.",
    parameters: { type: "object", properties: { stationId: stationIdParam, hours: hoursParam }, required: ["stationId"] },
  },
  {
    type: "function",
    name: "get_errors",
    description:
      "Rule 4. Returns StatusNotification error codes (errorCode != NoError, or status Faulted) in the window, grouped " +
      "with counts and first/last seen, OCPP CALLERRORs, the latest status per connector and notable events " +
      "(reboots, resets, failed unlocks, Unavailable).",
    parameters: { type: "object", properties: { stationId: stationIdParam, hours: hoursParam }, required: ["stationId"] },
  },
  {
    type: "function",
    name: "get_firmware_info",
    description:
      "Rule 5. Returns the current firmware version from the latest BootNotification, vendor/model/serials, " +
      "FirmwareStatusNotifications and whether the station is already on the configured target version.",
    parameters: { type: "object", properties: { stationId: stationIdParam }, required: ["stationId"] },
  },
  {
    type: "function",
    name: "get_messages",
    description:
      "Drill-down: returns raw OCPP messages (newest first, payload truncated to 800 chars) filtered by action, " +
      "message type and time range. Use only to explain something the other tools surfaced.",
    parameters: {
      type: "object",
      properties: {
        stationId: stationIdParam,
        action: { type: "string", description: "OCPP action, e.g. StatusNotification, StopTransaction, BootNotification." },
        messageType: {
          type: "string",
          enum: ["STATION_REQUEST", "STATION_RESPONSE", "SYSTEM_REQUEST", "SYSTEM_RESPONSE"],
        },
        from: { type: "string", description: "ISO-8601 lower bound (inclusive)." },
        to: { type: "string", description: "ISO-8601 upper bound (inclusive)." },
        limit: { type: "number", description: "Max messages to return (default 20, max 100)." },
      },
      required: ["stationId"],
    },
  },
  {
    type: "function",
    name: "create_ticket",
    description:
      "Creates a service ticket for a station. Required when get_connection_status reports NO_CONNECTION, when the " +
      "firmware procedure still fails after the last allowed attempt (or ends in REJECTED / NO_RESPONSE / TIMEOUT, or " +
      "a recovery reboot fails), and when post_update_check fails.",
    parameters: {
      type: "object",
      properties: {
        stationId: stationIdParam,
        title: { type: "string", description: "Short ticket title." },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        reason: { type: "string", description: "Which business rule triggered the ticket." },
        details: { type: "string", description: "Evidence: last message time, silence duration, etc." },
      },
      required: ["stationId", "title", "severity", "reason", "details"],
    },
  },
  {
    type: "function",
    name: "submit_recommendation",
    description:
      "Records the final firmware-upgrade recommendation for one station. Requires a prior get_connection_status. " +
      "Numbers must match the tool results; the call is rejected (accepted=false) if they do not or if the verdict " +
      "contradicts the business rules.",
    parameters: {
      type: "object",
      properties: {
        stationId: stationIdParam,
        verdict: { type: "string", enum: VERDICTS },
        firmwareVersion: { type: "string", description: 'Current firmware version, or "unknown".' },
        completeSessions: { type: "number", description: "completeSessions from get_sessions." },
        energyDeliveredKWh: { type: "number", description: "energyDeliveredKWh from get_sessions." },
        errorCodes: { type: "array", items: { type: "string" }, description: "Distinct error codes in the window." },
        reasons: {
          type: "array",
          items: { type: "string" },
          description: "One entry per business rule: what was found and whether it passes.",
        },
        nextActions: { type: "array", items: { type: "string" }, description: "Concrete next steps for operations." },
        summary: { type: "string", description: "Two or three sentence recommendation." },
      },
      required: [
        "stationId",
        "verdict",
        "firmwareVersion",
        "completeSessions",
        "energyDeliveredKWh",
        "errorCodes",
        "reasons",
        "nextActions",
        "summary",
      ],
    },
  },
  {
    type: "function",
    name: "upgrade_firmware",
    description:
      "Sends OCPP 2.0.1 UpdateFirmware to the station with the firmware image location on the FTP server and follows " +
      "FirmwareStatusNotifications (Downloading -> Downloaded -> Installing -> InstallRebooting -> Installed) until a " +
      "final status. Only allowed for stations whose recommendation was accepted as READY_FOR_UPGRADE and whose latest " +
      "get_connection_status reported CONNECTED without Faulted EVSEs. Outcome: INSTALLED, INSTALL_SCHEDULED (waits " +
      "for the running transaction), FAILED, REJECTED, NO_RESPONSE or TIMEOUT.",
    parameters: {
      type: "object",
      properties: {
        stationId: stationIdParam,
        targetVersion: {
          type: "string",
          description: `Firmware version to install.${TARGET_FIRMWARE_VERSION ? ` Defaults to ${TARGET_FIRMWARE_VERSION}.` : ""}`,
        },
      },
      required: ["stationId"],
    },
  },
  {
    type: "function",
    name: "reboot_station",
    description:
      "Recovery step after a firmware attempt ended in DownloadFailed or InstallationFailed: sends OCPP 2.0.1 " +
      "Reset(Immediate), waits for the station to drop its connection, come back and send a BootNotification. " +
      "Required before retrying upgrade_firmware. Outcome: REBOOTED, REJECTED, NO_RESPONSE or NO_BOOT.",
    parameters: { type: "object", properties: { stationId: stationIdParam }, required: ["stationId"] },
  },
  {
    type: "function",
    name: "post_update_check",
    description:
      "Station snapshot immediately after an INSTALLED firmware update: (1) installation complete — Installed status " +
      "and BootNotification with the new version, (2) live connection status, (3) connector availability from fresh " +
      `StatusNotifications. Also schedules the ${FOLLOW_UP_DELAY_HOURS}h follow-up that repeats the pre-update rules.`,
    parameters: { type: "object", properties: { stationId: stationIdParam }, required: ["stationId"] },
  },
];

const INTENT_PARAM = {
  type: "string",
  description: "One short sentence for the operator log: what you are about to check or do, and why.",
};

/** Every tool takes an "intent" so the run log shows the agent's plan before each action. */
function withIntent(tool: ToolDefinition): ToolDefinition {
  const parameters = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: { intent: INTENT_PARAM, ...parameters.properties },
      required: ["intent", ...(parameters.required ?? [])],
    },
  };
}

function toolSet(names: string[]): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => names.includes(t.name)).map(withIntent);
}

/** Phase 2: read-only analysis, live status check, tickets and recommendations. */
export const ANALYSIS_TOOLS = toolSet([
  "list_stations",
  "get_connection_status",
  "get_connection_history",
  "get_sessions",
  "get_errors",
  "get_firmware_info",
  "get_messages",
  "create_ticket",
  "submit_recommendation",
]);

/** Phase 3: the only phase allowed to change a station. */
export const UPGRADE_TOOLS = toolSet([
  "get_connection_status",
  "get_firmware_info",
  "upgrade_firmware",
  "reboot_station",
  "post_update_check",
  "create_ticket",
]);

/** Stations that passed analysis and may be upgraded. */
export const upgradeCandidates = (): Recommendation[] =>
  getRecommendations().filter((r) => r.verdict === "READY_FOR_UPGRADE");

/** Stations where the rollout procedure is not finished yet (used to remind the agent). */
export const pendingUpgrades = (): string[] =>
  upgradeCandidates()
    .map((r) => r.stationId)
    .filter((id) => {
      const last = firmwareAttempts.get(id)?.at(-1);
      if (!last) return true;
      if (last.outcome === "INSTALLED") return !postChecks.has(id);
      if (last.outcome === "INSTALL_SCHEDULED") return false;
      if (tickets.has(id)) return false;
      return true;
    });

export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_stations":
      return { stations: stations.map(stationOverview), analysisWindowHours: ANALYSIS_WINDOW_HOURS };
    case "get_connection_status":
      return runGetConnectionStatus(args);
    case "get_connection_history":
      return connectionStatus(station(args), hoursArg(args));
    case "get_sessions":
      return sessions(station(args), hoursArg(args));
    case "get_errors":
      return errors(station(args), hoursArg(args));
    case "get_firmware_info":
      return firmwareInfo(station(args));
    case "get_messages": {
      const from = dateArg(args, "from");
      const to = dateArg(args, "to");
      const action = text(args, "action");
      const messageType = text(args, "messageType");
      return findMessages(station(args), {
        limit: Math.min(Math.max(Number(args["limit"]) || 20, 1), 100),
        ...(action ? { action } : {}),
        ...(messageType ? { messageType } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });
    }
    case "create_ticket":
      return runCreateTicket(args);
    case "submit_recommendation":
      return runSubmitRecommendation(args);
    case "upgrade_firmware":
      return runUpgradeFirmware(args);
    case "reboot_station":
      return runRebootStation(args);
    case "post_update_check":
      return runPostUpdateCheck(args);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
