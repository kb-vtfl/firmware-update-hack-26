import { ANALYSIS_WINDOW_HOURS } from "./config.js";
import { connectionStatus, describeMessage, errors, firmwareInfo, sessions } from "./ocpp.js";
import type { OcppMessage, StationLog } from "./types.js";

/** What the dashboard shows for a station before the agent touches it: everything comes from the xlsx export. */

export interface XlsxRowView {
  row: number;
  at: string;
  messageType: string;
  action: string;
  detail: string;
  severity: "error" | "warn" | "info" | "muted";
}

export interface StationSnapshot {
  stationId: string;
  sourceFile: string;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
  exportFrom: string;
  exportTo: string;
  asOf: string;
  windowFrom: string;
  messageCount: number;
  connection: { status: string; lastMessageAt: string | null; minutesSince: number | null; row: number | null };
  connectors: Array<{ connectorId: number; status: string; errorCode: string | null; info: string | null; since: string; row: number }>;
  last24h: { completeSessions: number; energyKWh: number; errorCodes: string[]; errorCount: number };
  timeline: {
    status: Array<{ connectorId: number; status: string; errorCode: string | null; from: string; to: string; row: number }>;
    sessions: Array<{ connectorId: number | null; from: string | null; to: string | null; energyKWh: number | null; transactionId: number | null; rows: number[] }>;
    errors: Array<{ at: string; connectorId: number | null; errorCode: string; row: number }>;
    boots: Array<{ at: string; firmwareVersion: string | null; row: number }>;
    operator: Array<{ at: string; action: string; detail: string; row: number }>;
  };
  /** Rows worth reading (no heartbeats, meter samples or plain acknowledgements). */
  rows: XlsxRowView[];
}

const iso = (d: Date): string => d.toISOString();
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

function severityOf(m: OcppMessage): XlsxRowView["severity"] {
  const code = text(m.payload["errorCode"]);
  if (m.errorCode || m.payload["status"] === "Faulted" || (code && code !== "NoError")) return "error";
  const status = text(m.payload["status"]) ?? "";
  if (/Rejected|Failed|Unavailable/.test(status) || ["Reset", "UnlockConnector", "BootNotification"].includes(m.action)) return "warn";
  if (m.messageType.endsWith("RESPONSE")) return "muted";
  return "info";
}

const isNoise = (m: OcppMessage): boolean =>
  m.action === "Heartbeat" ||
  m.action === "MeterValues" ||
  (m.messageType === "SYSTEM_RESPONSE" && ["StatusNotification", "Authorize", "StartTransaction", "StopTransaction"].includes(m.action)) ||
  (m.messageType === "STATION_RESPONSE" && m.rawPayload === '{"status":"Accepted"}');

export function rowView(m: OcppMessage): XlsxRowView {
  return { row: m.row, at: iso(m.time), messageType: m.messageType, action: m.action, detail: describeMessage(m), severity: severityOf(m) };
}

export function stationSnapshot(log: StationLog): StationSnapshot {
  const firmware = firmwareInfo(log);
  const connection = connectionStatus(log, ANALYSIS_WINDOW_HOURS);
  const day = sessions(log, ANALYSIS_WINDOW_HOURS);
  const dayErrors = errors(log, ANALYSIS_WINDOW_HOURS);
  const allSessions = sessions(log, 24 * 365);
  const exportFrom = log.exportFrom ?? log.messages[0]?.time ?? log.asOf;

  const statusRows = log.messages.filter((m) => m.action === "StatusNotification" && m.messageType === "STATION_REQUEST");
  const status: StationSnapshot["timeline"]["status"] = [];
  const open = new Map<number, (typeof status)[number]>();
  for (const m of statusRows) {
    const connectorId = Number(m.payload["connectorId"]);
    if (!Number.isFinite(connectorId) || connectorId === 0) continue;
    const previous = open.get(connectorId);
    if (previous) previous.to = iso(m.time);
    const segment = {
      connectorId,
      status: text(m.payload["status"]) ?? "Unknown",
      errorCode: text(m.payload["errorCode"]),
      from: iso(m.time),
      to: iso(log.asOf),
      row: m.row,
    };
    status.push(segment);
    open.set(connectorId, segment);
  }

  const connectors = [...open.values()]
    .sort((a, b) => a.connectorId - b.connectorId)
    .map((s) => {
      const m = statusRows.find((x) => x.row === s.row);
      return { connectorId: s.connectorId, status: s.status, errorCode: s.errorCode, info: text(m?.payload["info"]), since: s.from, row: s.row };
    });

  const sessionViews = (allSessions["sessions"] as Array<Record<string, unknown>>).map((s) => {
    const rows = s["xlsxRows"] as { start: number | null; stop: number | null };
    return {
      connectorId: (s["connectorId"] as number | null) ?? null,
      from: (s["startedAt"] as string | null) ?? null,
      to: (s["stoppedAt"] as string | null) ?? null,
      energyKWh: (s["energyKWh"] as number | null) ?? null,
      transactionId: (s["transactionId"] as number | null) ?? null,
      rows: [rows.start, rows.stop].filter((r): r is number => r !== null),
    };
  });

  return {
    stationId: log.stationId,
    sourceFile: log.sourceFile,
    vendor: text(firmware["chargePointVendor"]),
    model: text(firmware["chargePointModel"]),
    serialNumber: text(firmware["chargePointSerialNumber"]),
    firmwareVersion: text(firmware["firmwareVersion"]),
    exportFrom: iso(exportFrom),
    exportTo: iso(log.exportTo ?? log.asOf),
    asOf: iso(log.asOf),
    windowFrom: iso(new Date(log.asOf.getTime() - ANALYSIS_WINDOW_HOURS * 3_600_000)),
    messageCount: log.messages.length,
    connection: {
      status: String(connection["status"]),
      lastMessageAt: (connection["lastStationMessageAt"] as string | null) ?? null,
      minutesSince: (connection["minutesSinceLastStationMessage"] as number | null) ?? null,
      row: (connection["lastStationMessageRow"] as number | null) ?? null,
    },
    connectors,
    last24h: {
      completeSessions: Number(day["completeSessions"]),
      energyKWh: Number(day["energyDeliveredKWh"]),
      errorCodes: dayErrors["distinctErrorCodes"] as string[],
      errorCount: Number(dayErrors["errorNotificationCount"]),
    },
    timeline: {
      status,
      sessions: sessionViews,
      errors: statusRows
        .filter((m) => m.payload["status"] === "Faulted" || (text(m.payload["errorCode"]) ?? "NoError") !== "NoError")
        .map((m) => ({
          at: iso(m.time),
          connectorId: Number(m.payload["connectorId"]) || null,
          errorCode: text(m.payload["errorCode"]) ?? "Unknown",
          row: m.row,
        })),
      boots: log.messages
        .filter((m) => m.action === "BootNotification" && m.messageType === "STATION_REQUEST")
        .map((m) => ({ at: iso(m.time), firmwareVersion: text(m.payload["firmwareVersion"]), row: m.row })),
      operator: log.messages
        .filter((m) => m.messageType === "SYSTEM_REQUEST" && ["Reset", "UnlockConnector", "ChangeAvailability", "TriggerMessage"].includes(m.action))
        .map((m) => ({ at: iso(m.time), action: m.action, detail: describeMessage(m), row: m.row })),
    },
    rows: log.messages.filter((m) => !isNoise(m)).map(rowView).reverse(),
  };
}
