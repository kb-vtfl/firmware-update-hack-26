/** One-line, operator-readable outcome of each tool call, plus whether it should be shown as a failure. */

type Result = Record<string, unknown>;

export interface Outcome {
  /** ok = check passed, issue = check found a problem, fail = the command itself failed or was refused. */
  level: "ok" | "issue" | "fail";
  text: string;
}

const passIf = (condition: boolean): Outcome["level"] => (condition ? "ok" : "issue");

const list = (value: unknown): Result[] => (Array.isArray(value) ? (value as Result[]) : []);
const counts = (value: unknown): string =>
  Object.entries((value as Record<string, number> | undefined) ?? {})
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");

function summarizeConnection(r: Result): Outcome {
  if (r["status"] !== "CONNECTED") {
    const why = list(r["problems"]).length ? ` · ${String((r["problems"] as unknown[])[0])}` : "";
    return { level: "issue", text: `NO_CONNECTION${why}` };
  }
  const evses = list(r["evses"]).map((e) => `EVSE ${String(e["evseId"])} ${String(e["connectorStatus"])}`).join(", ");
  const rtt = r["roundTripMs"] !== null ? ` in ${String(r["roundTripMs"])} ms` : "";
  return { level: passIf(Number(r["faultedEvses"]) === 0), text: `CONNECTED${rtt} · ${evses || "no EVSE status"}` };
}

function summarizeSessions(r: Result): Outcome {
  const energy = Number(r["energyDeliveredKWh"]);
  const low = r["energyBelowThreshold"] === true;
  const stops = counts(r["stopReasons"]);
  const extras = [
    Number(r["ongoingSessions"]) ? `${String(r["ongoingSessions"])} ongoing` : "",
    Number(r["sessionsBelowThreshold"]) ? `${String(r["sessionsBelowThreshold"])} session(s) < ${String(r["lowEnergyThresholdKWh"])} kWh` : "",
    Number(r["rejectedStarts"]) ? `${String(r["rejectedStarts"])} rejected start(s)` : "",
  ].filter(Boolean);
  return {
    level: passIf(!low),
    text:
      `${String(r["completeSessions"])} complete session(s) · ${energy} kWh` +
      `${low ? ` (below ${String(r["lowEnergyThresholdKWh"])} kWh threshold)` : ""}` +
      `${stops ? ` · stops: ${stops}` : ""}${extras.length ? ` · ${extras.join(", ")}` : ""}`,
  };
}

function summarizeErrors(r: Result): Outcome {
  const events = list(r["notableEvents"]).length;
  const eventText = events ? ` · ${events} notable event(s)` : "";
  if (r["hasErrorCodes"] !== true) return { level: "ok", text: `no error codes${eventText}` };
  const groups = list(r["errorGroups"])
    .map(
      (g) =>
        `${String(g["errorCode"])}×${String(g["count"])} (connector ${String(g["connectorId"])}` +
        `${g["vendorErrorCode"] ? `, vendor ${String(g["vendorErrorCode"])}` : ""})`,
    )
    .join(", ");
  const callErrors = list(r["callErrors"]).length ? `, ${list(r["callErrors"]).length} CALLERROR(s)` : "";
  return { level: "issue", text: `error codes: ${groups}${callErrors}${eventText}` };
}

function summarizeFirmware(r: Result): Outcome {
  if (r["known"] !== true) return { level: "issue", text: "firmware unknown (no BootNotification in export)" };
  const device = [r["chargePointVendor"], r["chargePointModel"]].filter(Boolean).join(" ");
  const target = r["onTarget"] === true ? " · already on target" : "";
  return { level: "ok", text: `firmware ${String(r["firmwareVersion"])}${device ? ` (${device})` : ""}${target}` };
}

function summarizeUpgrade(r: Result): Outcome {
  if (r["sent"] === false) return { level: "fail", text: `refused: ${String(r["refused"])}` };
  const outcome = String(r["outcome"]);
  const attempt = `attempt ${String(r["attempt"])}/${String(r["maxAttempts"])}`;
  const version = `${String(r["previousVersion"])} → ${String(r["targetVersion"])}`;
  const statuses = list(r["firmwareStatuses"]).map((s) => String(s["status"])).join(" → ");
  const reported = r["reportedFirmwareVersion"] ? ` · station reports ${String(r["reportedFirmwareVersion"])}` : "";
  const failed = r["failedStatus"] ? ` at ${String(r["failedStatus"])}` : "";
  return {
    level: outcome === "INSTALLED" || outcome === "INSTALL_SCHEDULED" ? "ok" : "fail",
    text: `${outcome}${failed} · ${attempt} · ${version}${reported}${statuses ? ` · ${statuses}` : ""}`,
  };
}

function summarizeReboot(r: Result): Outcome {
  if (r["sent"] === false) return { level: "fail", text: `refused: ${String(r["refused"])}` };
  if (r["outcome"] !== "REBOOTED") return { level: "fail", text: `${String(r["outcome"])} · ${list(r["problems"]).join("; ")}` };
  const downtime = r["downtimeMs"] !== null ? `${(Number(r["downtimeMs"]) / 1000).toFixed(1)} s` : "?";
  return {
    level: "ok",
    text: `REBOOTED · Reset(Immediate) ${String(r["resetStatus"])} · back after ${downtime} · BootNotification firmware ${String(r["firmwareVersion"])}`,
  };
}

function summarizePostCheck(r: Result): Outcome {
  const part = (key: string, label: string): string => {
    const c = (r[key] ?? {}) as Result;
    return `${label} ${c["passed"] === true ? "✓" : "✗"}`;
  };
  const followUp = (r["followUp"] ?? {}) as Result;
  return {
    level: r["passed"] === true ? "ok" : "issue",
    text:
      `${r["passed"] === true ? "PASSED" : "FAILED"} · ${part("installationComplete", "installation")} · ` +
      `${part("connection", "connection")} · ${part("connectorAvailability", "connectors")} · ` +
      `follow-up due ${String(followUp["dueAt"] ?? "").slice(0, 16).replace("T", " ")} UTC`,
  };
}

export function summarizeToolResult(name: string, result: unknown): Outcome {
  const r = (result ?? {}) as Result;
  if (typeof r["error"] === "string") return { level: "fail", text: `error: ${r["error"]}` };

  switch (name) {
    case "list_stations": {
      const stations = list(r["stations"]);
      return { level: "ok", text: `${stations.length} station(s): ${stations.map((s) => String(s["stationId"])).join(", ")}` };
    }
    case "get_connection_status":
      return summarizeConnection(r);
    case "get_connection_history":
      return {
        level: passIf(r["status"] === "CONNECTED"),
        text: `${String(r["status"])} by log · last message ${String(r["minutesSinceLastStationMessage"])} min before export end`,
      };
    case "get_sessions":
      return summarizeSessions(r);
    case "get_errors":
      return summarizeErrors(r);
    case "get_firmware_info":
      return summarizeFirmware(r);
    case "get_messages":
      return { level: "ok", text: `${String(r["returned"])} of ${String(r["totalMatches"])} matching message(s)` };
    case "create_ticket": {
      const ticket = (r["ticket"] ?? {}) as Result;
      return { level: "ok", text: `${r["created"] ? "ticket created" : "ticket already exists"}: ${String(ticket["id"])} (${String(ticket["severity"])})` };
    }
    case "submit_recommendation":
      return r["accepted"] === true
        ? { level: "ok", text: "recommendation accepted" }
        : { level: "issue", text: `recommendation rejected: ${list(r["problems"]).length ? (r["problems"] as string[]).join(" ") : "unknown reason"}` };
    case "upgrade_firmware":
      return summarizeUpgrade(r);
    case "reboot_station":
      return summarizeReboot(r);
    case "post_update_check":
      return summarizePostCheck(r);
    case "generate_report":
      if (r["accepted"] === true) return { level: "ok", text: `report ${String(r["reportId"])} saved (HTML, Markdown, JSON)` };
      if (r["note"]) return { level: "ok", text: String(r["note"]) };
      return { level: "issue", text: `report rejected: ${list(r["problems"]).length ? (r["problems"] as string[]).join(" ") : "unknown reason"}` };
    default:
      return { level: "ok", text: JSON.stringify(result).slice(0, 200) };
  }
}
