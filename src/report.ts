import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTPUT_DIR } from "./config.js";
import type {
  FirmwareUpdateResult,
  FollowUp,
  LiveConnectionResult,
  PostUpdateCheckResult,
  RebootResult,
  Recommendation,
  Ticket,
} from "./types.js";

export interface RunReport {
  recommendations: Recommendation[];
  tickets: Ticket[];
  liveConnections: LiveConnectionResult[];
  /** Latest attempt per station. */
  firmwareUpdates: FirmwareUpdateResult[];
  firmwareAttempts: FirmwareUpdateResult[];
  reboots: RebootResult[];
  postChecks: PostUpdateCheckResult[];
  followUps: FollowUp[];
  agentSummary: string;
}

function toMarkdown(run: RunReport): string {
  const { recommendations, tickets, liveConnections, firmwareUpdates, firmwareAttempts, reboots, postChecks, agentSummary } = run;
  const upgradeOf = (stationId: string): string => firmwareUpdates.find((u) => u.stationId === stationId)?.outcome ?? "-";

  const lines = [
    "# Firmware upgrade readiness",
    "",
    "| Station | Verdict | Firmware | Connection | Complete sessions | Energy (kWh) | Error codes | Ticket | Upgrade |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...recommendations.map(
      (r) =>
        `| ${r.stationId} | ${r.verdict} | ${r.firmwareVersion} | ${r.connectionStatus} | ${r.completeSessions} | ` +
        `${r.energyDeliveredKWh} | ${r.errorCodes.join(", ") || "-"} | ${r.ticketId ?? "-"} | ${upgradeOf(r.stationId)} |`,
    ),
    "",
  ];

  for (const r of recommendations) {
    lines.push(`## ${r.stationId} — ${r.verdict}`, "", r.summary, "", "**Checks**", "");
    lines.push(...r.reasons.map((reason) => `- ${reason}`), "", "**Next actions**", "");
    lines.push(...r.nextActions.map((action) => `- ${action}`), "");
  }

  if (liveConnections.length > 0) {
    lines.push("## Live connection checks (OCPP 2.0.1)", "");
    for (const c of liveConnections) {
      const evses = c.evses.map((e) => `EVSE ${e.evseId}: ${e.connectorStatus}`).join(", ") || "no EVSE status";
      const rtt = c.roundTripMs !== null ? `, ${c.roundTripMs} ms` : "";
      lines.push(`- **${c.stationId}**: ${c.status}${rtt} — ${evses}${c.problems.length ? ` (${c.problems.join("; ")})` : ""}`);
    }
    lines.push("");
  }

  if (firmwareAttempts.length > 0) {
    lines.push("## Firmware updates (OCPP 2.0.1 UpdateFirmware)", "");
    for (const u of firmwareAttempts) {
      const statuses = u.firmwareStatuses.map((s) => s.status).join(" → ") || "no status";
      lines.push(
        `- **${u.stationId}** attempt ${u.attempt}/${u.maxAttempts}: ${u.outcome}${u.failedStatus ? ` (${u.failedStatus})` : ""} — ${u.previousVersion} → ${u.targetVersion} (requestId ${u.requestId})`,
        `  - location: \`${u.location}\``,
        `  - statuses: ${statuses}`,
        ...(u.reportedFirmwareVersion ? [`  - station now reports firmware ${u.reportedFirmwareVersion}`] : []),
        ...u.problems.map((p) => `  - ${p}`),
      );
      for (const r of reboots.filter((x) => x.stationId === u.stationId && x.reason.includes(`attempt ${u.attempt})`))) {
        lines.push(`  - recovery reboot (Reset Immediate): ${r.outcome}${r.downtimeMs !== null ? ` after ${(r.downtimeMs / 1000).toFixed(1)} s` : ""}`);
      }
    }
    lines.push("");
  }

  if (postChecks.length > 0) {
    lines.push("## Post-update snapshot (immediately after)", "");
    for (const c of postChecks) {
      const mark = (passed: boolean): string => (passed ? "✅" : "❌");
      lines.push(
        `- **${c.stationId}**: ${c.passed ? "PASSED" : "FAILED"}`,
        `  - ${mark(c.installationComplete.passed)} installation complete — ${c.installationComplete.detail}`,
        `  - ${mark(c.connection.passed)} connection status — ${c.connection.detail}`,
        `  - ${mark(c.connectorAvailability.passed)} connector availability — ${c.connectorAvailability.detail}`,
        `  - 24h follow-up due ${c.followUp.dueAt}: ${c.followUp.checks.join("; ")}`,
      );
    }
    lines.push("");
  }

  if (tickets.length > 0) {
    lines.push("## Tickets created", "");
    lines.push(...tickets.map((t) => `- **${t.id}** (${t.severity}) ${t.title} — ${t.reason}`), "");
  }

  lines.push("## Agent summary", "", agentSummary, "");
  return lines.join("\n");
}

export async function writeReport(run: RunReport): Promise<{ json: string; markdown: string }> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const json = join(OUTPUT_DIR, `report-${stamp}.json`);
  const markdown = join(OUTPUT_DIR, `report-${stamp}.md`);
  await writeFile(json, JSON.stringify(run, null, 2) + "\n", "utf8");
  await writeFile(markdown, toMarkdown(run), "utf8");
  return { json, markdown };
}
