import { basename } from "node:path";
import {
  AS_OF,
  DEFAULT_HEARTBEAT_INTERVAL_S,
  HEARTBEAT_GRACE_FACTOR,
  LOW_ENERGY_THRESHOLD_KWH,
  NORMAL_STOP_REASONS,
  TARGET_FIRMWARE_VERSION,
} from "./config.js";
import type { OcppMessage, StationLog } from "./types.js";
import { ROW_NUMBER_KEY, readXlsxRows } from "./xlsx.js";

const STATION_SIDE = new Set(["STATION_REQUEST", "STATION_RESPONSE"]);
const ENERGY_REGISTER = "Energy.Active.Import.Register";

// --- loading ---

/** "ALF-0011673_2026-10-18T1208_2026-10-21T1218.xlsx" -> id + export window (UTC). */
function parseFileName(path: string): { stationId: string | undefined; from: Date | undefined; to: Date | undefined } {
  const name = basename(path).replace(/\.[^.]+$/, "");
  const m = name.match(/^(.+?)_(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})_(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})/);
  if (!m) return { stationId: name.split("_")[0] || undefined, from: undefined, to: undefined };
  return {
    stationId: m[1],
    from: new Date(`${m[2]}T${m[3]}:${m[4]}:00Z`),
    to: new Date(`${m[5]}T${m[6]}:${m[7]}:00Z`),
  };
}

function pick(row: Record<string, string>, ...names: string[]): string {
  const wanted = names.map((n) => n.toLowerCase().replace(/[^a-z]/g, ""));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.includes(key.toLowerCase().replace(/[^a-z]/g, ""))) return value.trim();
  }
  return "";
}

function parsePayload(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { unparsed: raw };
  }
}

export async function loadStationLog(path: string): Promise<StationLog> {
  const rows = await readXlsxRows(path);
  const messages: OcppMessage[] = [];

  for (const row of rows) {
    const time = new Date(pick(row, "Time generated", "Timestamp", "Time"));
    if (Number.isNaN(time.getTime())) continue;
    const rawPayload = pick(row, "Message payload", "Payload");
    messages.push({
      row: Number(row[ROW_NUMBER_KEY]),
      time,
      messageId: pick(row, "Message ID"),
      messageType: pick(row, "Message type"),
      action: pick(row, "Action type", "Action"),
      payload: parsePayload(rawPayload),
      rawPayload,
      errorCode: pick(row, "Error code"),
      errorDescription: pick(row, "Error description"),
    });
  }
  messages.sort((a, b) => a.time.getTime() - b.time.getTime());

  const fromName = parseFileName(path);
  const bootSerial = messages.findLast((m) => m.action === "BootNotification" && m.messageType === "STATION_REQUEST")
    ?.payload["chargeBoxSerialNumber"];
  const lastMessage = messages.at(-1);

  return {
    stationId: fromName.stationId ?? (typeof bootSerial === "string" ? bootSerial : basename(path)),
    sourceFile: basename(path),
    exportFrom: fromName.from,
    exportTo: fromName.to,
    asOf: AS_OF ? new Date(AS_OF) : (fromName.to ?? lastMessage?.time ?? new Date()),
    messages,
  };
}

// --- helpers ---

interface TimeWindow {
  from: Date;
  to: Date;
}

function windowOf(log: StationLog, hours: number): TimeWindow {
  return { from: new Date(log.asOf.getTime() - hours * 3_600_000), to: log.asOf };
}

const inWindow = (d: Date, w: TimeWindow): boolean => d >= w.from && d <= w.to;
const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);
const minutes = (ms: number): number => Math.round(ms / 60_000);
const round = (n: number, digits = 3): number => Number(n.toFixed(digits));

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function payloadTime(m: OcppMessage): Date {
  const ts = str(m.payload["timestamp"]);
  const d = ts ? new Date(ts) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : m.time;
}

function idTagStatus(payload: Record<string, unknown>): string | undefined {
  const info = payload["idTagInfo"];
  return info && typeof info === "object" ? str((info as Record<string, unknown>)["status"]) : undefined;
}

/** Response to a request = same message ID, opposite side. */
function responseTo(log: StationLog, request: OcppMessage): OcppMessage | undefined {
  const wanted = request.messageType.startsWith("STATION") ? "SYSTEM_RESPONSE" : "STATION_RESPONSE";
  return log.messages.find((m) => m.messageId === request.messageId && m.messageType === wanted);
}

/** Energy register (Wh) from a StopTransaction's transactionData for the given context. */
function energyRegisterFromTransactionData(payload: Record<string, unknown>, context: string): number | undefined {
  const data = payload["transactionData"];
  if (!Array.isArray(data)) return undefined;
  for (const meterValue of data as Array<Record<string, unknown>>) {
    const sampled = meterValue["sampledValue"];
    if (!Array.isArray(sampled)) continue;
    for (const sv of sampled as Array<Record<string, unknown>>) {
      const measurand = str(sv["measurand"]) ?? ENERGY_REGISTER;
      if (measurand !== ENERGY_REGISTER || sv["context"] !== context || sv["phase"] !== undefined) continue;
      const value = num(sv["value"]);
      if (value === undefined) continue;
      return str(sv["unit"]) === "kWh" ? value * 1000 : value;
    }
  }
  return undefined;
}

// --- business-rule facts ---

export function stationOverview(log: StationLog): Record<string, unknown> {
  const actionCounts: Record<string, number> = {};
  for (const m of log.messages) {
    if (m.messageType.endsWith("REQUEST")) actionCounts[m.action] = (actionCounts[m.action] ?? 0) + 1;
  }
  return {
    stationId: log.stationId,
    sourceFile: log.sourceFile,
    exportFrom: iso(log.exportFrom),
    exportTo: iso(log.exportTo),
    asOf: iso(log.asOf),
    messageRows: log.messages.length,
    firstMessageAt: iso(log.messages[0]?.time),
    lastMessageAt: iso(log.messages.at(-1)?.time),
    requestCountsByAction: actionCounts,
  };
}

export function connectionStatus(log: StationLog, hours: number): Record<string, unknown> {
  const w = windowOf(log, hours);
  const stationMessages = log.messages.filter((m) => STATION_SIDE.has(m.messageType) && m.time <= log.asOf);
  const last = stationMessages.at(-1);

  const bootResponse = log.messages.findLast((m) => m.action === "BootNotification" && m.messageType === "SYSTEM_RESPONSE");
  const intervalS = num(bootResponse?.payload["interval"]) ?? DEFAULT_HEARTBEAT_INTERVAL_S;
  const allowedSilenceMs = intervalS * 1000 * HEARTBEAT_GRACE_FACTOR;
  const silenceMs = last ? log.asOf.getTime() - last.time.getTime() : Number.POSITIVE_INFINITY;

  // OCPP stations skip heartbeats while other traffic flows, so gaps are measured over all station-side messages.
  const timesInWindow = stationMessages.filter((m) => inWindow(m.time, w)).map((m) => m.time.getTime());
  const gapEdges = [...timesInWindow, log.asOf.getTime()];
  let longestGapMs = 0;
  let gapsOverAllowance = 0;
  for (let i = 1; i < gapEdges.length; i++) {
    const gap = (gapEdges[i] ?? 0) - (gapEdges[i - 1] ?? 0);
    longestGapMs = Math.max(longestGapMs, gap);
    if (gap > allowedSilenceMs) gapsOverAllowance++;
  }

  const heartbeats = stationMessages.filter((m) => m.action === "Heartbeat" && m.messageType === "STATION_REQUEST");

  return {
    stationId: log.stationId,
    status: last && silenceMs <= allowedSilenceMs ? "CONNECTED" : "NO_CONNECTION",
    asOf: iso(log.asOf),
    lastStationMessageAt: iso(last?.time),
    lastStationMessageAction: last?.action ?? null,
    lastStationMessageRow: last?.row ?? null,
    minutesSinceLastStationMessage: last ? minutes(silenceMs) : null,
    heartbeatIntervalSeconds: intervalS,
    heartbeatIntervalSource: bootResponse ? "BootNotification response" : "default",
    allowedSilenceMinutes: minutes(allowedSilenceMs),
    lastHeartbeatAt: iso(heartbeats.at(-1)?.time),
    heartbeatsInWindow: heartbeats.filter((m) => inWindow(m.time, w)).length,
    stationMessagesInWindow: timesInWindow.length,
    longestSilenceInWindowMinutes: timesInWindow.length ? minutes(longestGapMs) : null,
    silencesOverAllowanceInWindow: gapsOverAllowance,
  };
}

export function firmwareInfo(log: StationLog): Record<string, unknown> {
  const boots = log.messages.filter((m) => m.action === "BootNotification" && m.messageType === "STATION_REQUEST");
  const latest = boots.at(-1);
  const version = str(latest?.payload["firmwareVersion"]) ?? null;
  const firmwareStatus = log.messages
    .filter((m) => m.action === "FirmwareStatusNotification" && m.messageType === "STATION_REQUEST")
    .map((m) => ({ at: iso(m.time), status: str(m.payload["status"]) ?? null }));

  return {
    stationId: log.stationId,
    known: version !== null,
    firmwareVersion: version,
    source: latest ? "latest BootNotification" : "no BootNotification in export",
    lastBootAt: iso(latest?.time),
    xlsxRow: latest?.row ?? null,
    bootAccepted: latest ? (str(responseTo(log, latest)?.payload["status"]) ?? null) : null,
    bootNotificationsInExport: boots.length,
    chargePointVendor: str(latest?.payload["chargePointVendor"]) ?? null,
    chargePointModel: str(latest?.payload["chargePointModel"]) ?? null,
    chargeBoxSerialNumber: str(latest?.payload["chargeBoxSerialNumber"]) ?? null,
    chargePointSerialNumber: str(latest?.payload["chargePointSerialNumber"]) ?? null,
    firmwareStatusNotifications: firmwareStatus,
    targetFirmwareVersion: TARGET_FIRMWARE_VERSION ?? null,
    onTarget: TARGET_FIRMWARE_VERSION && version ? version === TARGET_FIRMWARE_VERSION : null,
    ...(version === null
      ? { hint: "Firmware unknown - send TriggerMessage(requestedMessage=BootNotification) to the station." }
      : {}),
  };
}

interface ErrorNotification {
  row: number;
  at: Date;
  connectorId: number | null;
  status: string | null;
  errorCode: string;
  info: string | null;
  vendorErrorCode: string | null;
  vendorId: string | null;
}

function errorNotifications(log: StationLog): ErrorNotification[] {
  return log.messages
    .filter((m) => m.action === "StatusNotification" && m.messageType === "STATION_REQUEST")
    .filter((m) => {
      const code = str(m.payload["errorCode"]);
      return (code !== undefined && code !== "NoError") || m.payload["status"] === "Faulted";
    })
    .map((m) => ({
      row: m.row,
      at: m.time,
      connectorId: num(m.payload["connectorId"]) ?? null,
      status: str(m.payload["status"]) ?? null,
      errorCode: str(m.payload["errorCode"]) ?? "Unknown",
      info: str(m.payload["info"]) ?? null,
      vendorErrorCode: str(m.payload["vendorErrorCode"]) ?? null,
      vendorId: str(m.payload["vendorId"]) ?? null,
    }));
}

export function sessions(log: StationLog, hours: number): Record<string, unknown> {
  const w = windowOf(log, hours);
  const errors = errorNotifications(log);

  interface Session {
    transactionId: number | null;
    connectorId: number | null;
    idTag: string | null;
    startedAt: Date | undefined;
    stoppedAt: Date | undefined;
    meterStartWh: number | undefined;
    meterStartSource: string | null;
    meterStopWh: number | undefined;
    stopReason: string | null;
    startAuthorization: string | null;
    startRow: number | null;
    stopRow: number | null;
  }
  const byKey = new Map<string, Session>();

  for (const start of log.messages.filter((m) => m.action === "StartTransaction" && m.messageType === "STATION_REQUEST")) {
    const response = responseTo(log, start);
    const transactionId = num(response?.payload["transactionId"]) ?? null;
    byKey.set(transactionId !== null ? `tx-${transactionId}` : `start-${start.messageId}`, {
      transactionId,
      connectorId: num(start.payload["connectorId"]) ?? null,
      idTag: str(start.payload["idTag"]) ?? null,
      startedAt: payloadTime(start),
      stoppedAt: undefined,
      meterStartWh: num(start.payload["meterStart"]),
      meterStartSource: "StartTransaction.meterStart",
      meterStopWh: undefined,
      stopReason: null,
      startAuthorization: response ? (idTagStatus(response.payload) ?? null) : "no response",
      startRow: start.row,
      stopRow: null,
    });
  }

  for (const stop of log.messages.filter((m) => m.action === "StopTransaction" && m.messageType === "STATION_REQUEST")) {
    const transactionId = num(stop.payload["transactionId"]) ?? null;
    const key = transactionId !== null ? `tx-${transactionId}` : `stop-${stop.messageId}`;
    const session: Session = byKey.get(key) ?? {
      transactionId,
      connectorId: null,
      idTag: str(stop.payload["idTag"]) ?? null,
      startedAt: undefined,
      stoppedAt: undefined,
      meterStartWh: energyRegisterFromTransactionData(stop.payload, "Transaction.Begin"),
      meterStartSource: "StopTransaction.transactionData (start not in export)",
      meterStopWh: undefined,
      stopReason: null,
      startAuthorization: null,
      startRow: null,
      stopRow: null,
    };
    session.stoppedAt = payloadTime(stop);
    session.meterStopWh = num(stop.payload["meterStop"]);
    session.stopReason = str(stop.payload["reason"]) ?? "Local";
    session.stopRow = stop.row;
    byKey.set(key, session);
  }

  const all = [...byKey.values()].map((s) => {
    const complete = s.startedAt !== undefined && s.stoppedAt !== undefined;
    const delta =
      s.meterStartWh !== undefined && s.meterStopWh !== undefined ? s.meterStopWh - s.meterStartWh : undefined;
    const energyWh = delta !== undefined && delta >= 0 ? delta : undefined;
    const errorsDuring = errors.filter(
      (e) =>
        s.startedAt &&
        e.at >= s.startedAt &&
        e.at <= (s.stoppedAt ?? log.asOf) &&
        (e.connectorId === null || e.connectorId === 0 || e.connectorId === s.connectorId),
    );
    const state = complete ? "complete" : s.startedAt ? (s.startAuthorization === "Accepted" ? "ongoing" : "rejected") : "stop_without_start";
    return {
      session: s,
      complete,
      state,
      energyWh,
      view: {
        transactionId: s.transactionId,
        connectorId: s.connectorId,
        state,
        startedAt: iso(s.startedAt),
        stoppedAt: iso(s.stoppedAt),
        durationMinutes: s.startedAt && s.stoppedAt ? minutes(s.stoppedAt.getTime() - s.startedAt.getTime()) : null,
        energyKWh: energyWh !== undefined ? round(energyWh / 1000) : null,
        ...(delta !== undefined && delta < 0
          ? { energyNote: `invalid meter reading: meterStop ${s.meterStopWh} Wh < meterStart ${s.meterStartWh} Wh` }
          : {}),
        meterStartSource: s.meterStartSource,
        stopReason: s.stopReason,
        abnormalStop: s.stopReason !== null && !NORMAL_STOP_REASONS.includes(s.stopReason),
        startAuthorization: s.startAuthorization,
        errorCodesDuringSession: [...new Set(errorsDuring.map((e) => e.errorCode))],
        xlsxRows: { start: s.startRow, stop: s.stopRow },
      },
    };
  });

  const relevant = all.filter((x) => {
    const s = x.session;
    if (s.stoppedAt) return inWindow(s.stoppedAt, w);
    return s.startedAt !== undefined && s.startedAt <= w.to;
  });
  const completeInWindow = relevant.filter((x) => x.complete);
  const totalWh = completeInWindow.reduce((sum, x) => sum + (x.energyWh ?? 0), 0);
  const stopReasons: Record<string, number> = {};
  for (const x of relevant) {
    if (x.session.stopReason) stopReasons[x.session.stopReason] = (stopReasons[x.session.stopReason] ?? 0) + 1;
  }
  const failedAuthorizations = log.messages.filter(
    (m) =>
      m.action === "Authorize" &&
      m.messageType === "SYSTEM_RESPONSE" &&
      inWindow(m.time, w) &&
      idTagStatus(m.payload) !== undefined &&
      idTagStatus(m.payload) !== "Accepted",
  ).length;

  return {
    stationId: log.stationId,
    window: { hours, from: iso(w.from), to: iso(w.to) },
    completeSessions: completeInWindow.length,
    energyDeliveredKWh: round(totalWh / 1000),
    lowEnergyThresholdKWh: LOW_ENERGY_THRESHOLD_KWH,
    energyBelowThreshold: totalWh / 1000 < LOW_ENERGY_THRESHOLD_KWH,
    sessionsBelowThreshold: completeInWindow.filter((x) => (x.energyWh ?? 0) / 1000 < LOW_ENERGY_THRESHOLD_KWH).length,
    ongoingSessions: relevant.filter((x) => x.state === "ongoing").length,
    rejectedStarts: relevant.filter((x) => x.state === "rejected").length,
    stopsWithoutStartInExport: relevant.filter((x) => x.state === "stop_without_start").length,
    failedAuthorizations,
    stopReasons,
    abnormalStops: relevant.filter((x) => x.view.abnormalStop).length,
    sessions: relevant.map((x) => x.view),
  };
}

export function errors(log: StationLog, hours: number): Record<string, unknown> {
  const w = windowOf(log, hours);
  const inRange = errorNotifications(log).filter((e) => inWindow(e.at, w));

  const groups = new Map<string, ErrorNotification & { count: number; firstSeen: Date; lastSeen: Date; rows: number[] }>();
  for (const e of inRange) {
    const key = [e.connectorId, e.status, e.errorCode, e.vendorErrorCode, e.info].join("|");
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.lastSeen = e.at;
      g.rows.push(e.row);
    } else {
      groups.set(key, { ...e, count: 1, firstSeen: e.at, lastSeen: e.at, rows: [e.row] });
    }
  }

  const callErrors = log.messages
    .filter((m) => inWindow(m.time, w) && (m.errorCode || m.errorDescription))
    .map((m) => ({
      at: iso(m.time),
      action: m.action,
      messageType: m.messageType,
      errorCode: m.errorCode,
      errorDescription: m.errorDescription,
    }));

  const latestStatusByConnector = new Map<number, OcppMessage>();
  for (const m of log.messages) {
    if (m.action !== "StatusNotification" || m.messageType !== "STATION_REQUEST" || m.time > log.asOf) continue;
    const connectorId = num(m.payload["connectorId"]);
    if (connectorId !== undefined) latestStatusByConnector.set(connectorId, m);
  }

  const notableEvents: Array<{ at: string | null; event: string; detail: string; xlsxRow: number }> = [];
  const operatorCommands = ["Reset", "UnlockConnector", "ChangeAvailability"];
  for (const m of log.messages.filter((x) => inWindow(x.time, w))) {
    const status = str(m.payload["status"]);
    if (m.action === "BootNotification" && m.messageType === "STATION_REQUEST") {
      notableEvents.push({ at: iso(m.time), event: "Boot", detail: "station (re)booted", xlsxRow: m.row });
    } else if (m.messageType === "SYSTEM_REQUEST" && operatorCommands.includes(m.action)) {
      const reply = str(responseTo(log, m)?.payload["status"]) ?? "no response";
      notableEvents.push({ at: iso(m.time), event: m.action, detail: `${JSON.stringify(m.payload)} -> ${reply}`, xlsxRow: m.row });
    } else if (
      m.messageType === "STATION_RESPONSE" &&
      !operatorCommands.includes(m.action) &&
      status &&
      /Rejected|Failed|NotSupported/.test(status)
    ) {
      notableEvents.push({ at: iso(m.time), event: `${m.action} response`, detail: status, xlsxRow: m.row });
    } else if (m.action === "StatusNotification" && m.messageType === "STATION_REQUEST" && status === "Unavailable") {
      notableEvents.push({ at: iso(m.time), event: "Unavailable", detail: `connector ${String(m.payload["connectorId"])}`, xlsxRow: m.row });
    }
  }

  return {
    stationId: log.stationId,
    window: { hours, from: iso(w.from), to: iso(w.to) },
    hasErrorCodes: inRange.length > 0 || callErrors.length > 0,
    errorNotificationCount: inRange.length,
    distinctErrorCodes: [...new Set(inRange.map((e) => e.errorCode))],
    errorGroups: [...groups.values()].map((g) => ({
      connectorId: g.connectorId,
      status: g.status,
      errorCode: g.errorCode,
      info: g.info,
      vendorErrorCode: g.vendorErrorCode,
      vendorId: g.vendorId,
      count: g.count,
      firstSeen: iso(g.firstSeen),
      lastSeen: iso(g.lastSeen),
      xlsxRows: g.rows.slice(-10),
    })),
    callErrors,
    currentConnectorStatus: [...latestStatusByConnector.entries()]
      .sort(([a], [b]) => a - b)
      .map(([connectorId, m]) => ({
        connectorId,
        status: str(m.payload["status"]) ?? null,
        errorCode: str(m.payload["errorCode"]) ?? null,
        since: iso(m.time),
      })),
    notableEvents,
  };
}

/** One human-readable line per message, used wherever an xlsx row is shown to an operator. */
export function describeMessage(m: OcppMessage): string {
  const p = m.payload;
  const connector = p["connectorId"] !== undefined ? ` · connector ${String(p["connectorId"])}` : "";
  switch (m.action) {
    case "StatusNotification": {
      if (!m.messageType.endsWith("REQUEST")) return "acknowledged";
      const code = str(p["errorCode"]);
      const error = code && code !== "NoError" ? ` · ${code}` : "";
      const vendor = p["vendorErrorCode"] ? ` (vendor ${String(p["vendorErrorCode"])})` : "";
      const info = p["info"] ? ` · "${String(p["info"])}"` : "";
      return `${String(p["status"])}${error}${vendor}${connector}${info}`;
    }
    case "StartTransaction":
      return m.messageType === "STATION_REQUEST"
        ? `start${connector} · idTag ${String(p["idTag"])} · meterStart ${String(p["meterStart"])} Wh`
        : `transactionId ${String(p["transactionId"])} · ${idTagStatus(p) ?? ""}`;
    case "StopTransaction":
      return m.messageType === "STATION_REQUEST"
        ? `stop tx ${String(p["transactionId"])} · reason ${String(p["reason"] ?? "Local")} · meterStop ${String(p["meterStop"])} Wh`
        : (idTagStatus(p) ?? "acknowledged");
    case "BootNotification":
      return m.messageType === "STATION_REQUEST"
        ? `boot · firmware ${String(p["firmwareVersion"])} · ${String(p["chargePointVendor"] ?? "")} ${String(p["chargePointModel"] ?? "")}`.trim()
        : `${String(p["status"])} · interval ${String(p["interval"])} s`;
    case "Heartbeat":
      return m.messageType === "STATION_REQUEST" ? "heartbeat" : "time sync";
    case "MeterValues": {
      const values = Array.isArray(p["meterValue"]) ? (p["meterValue"] as unknown[]).length : 0;
      return m.messageType === "STATION_REQUEST" ? `${values} meter sample(s)${connector}` : "acknowledged";
    }
    default: {
      const body = m.rawPayload && m.rawPayload !== "{}" ? m.rawPayload : "";
      return body.length > 120 ? `${body.slice(0, 120)}…` : body || "—";
    }
  }
}

/** Latest OCPP 1.6 status per physical connector (connector 0 = whole station is skipped). */
export function latestConnectorStatuses(log: StationLog): Map<number, string> {
  const latest = new Map<number, string>();
  for (const m of log.messages) {
    if (m.action !== "StatusNotification" || m.messageType !== "STATION_REQUEST") continue;
    const connectorId = num(m.payload["connectorId"]);
    const status = str(m.payload["status"]);
    if (connectorId !== undefined && connectorId > 0 && status) latest.set(connectorId, status);
  }
  return new Map([...latest.entries()].sort(([a], [b]) => a - b));
}

export interface MessageFilter {
  action?: string;
  messageType?: string;
  from?: Date;
  to?: Date;
  limit: number;
}

export function findMessages(log: StationLog, filter: MessageFilter): Record<string, unknown> {
  const matches = log.messages.filter(
    (m) =>
      (!filter.action || m.action.toLowerCase() === filter.action.toLowerCase()) &&
      (!filter.messageType || m.messageType.toLowerCase() === filter.messageType.toLowerCase()) &&
      (!filter.from || m.time >= filter.from) &&
      (!filter.to || m.time <= filter.to),
  );
  return {
    stationId: log.stationId,
    totalMatches: matches.length,
    returned: Math.min(matches.length, filter.limit),
    newestFirst: matches
      .slice(-filter.limit)
      .reverse()
      .map((m) => ({
        xlsxRow: m.row,
        at: iso(m.time),
        messageId: m.messageId,
        messageType: m.messageType,
        action: m.action,
        payload: m.rawPayload.length > 800 ? `${m.rawPayload.slice(0, 800)}...[truncated]` : m.rawPayload,
        ...(m.errorCode || m.errorDescription ? { errorCode: m.errorCode, errorDescription: m.errorDescription } : {}),
      })),
  };
}
