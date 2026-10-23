import type {
  FirmwareUpdateOutcome,
  FirmwareUpdateResult,
  FollowUp,
  PostUpdateCheckResult,
  RebootResult,
  Recommendation,
  Ticket,
  Verdict,
} from "./types.js";

/**
 * Run summary report: the facts come from the run state, the narrative (headline, executive summary, highlights,
 * risks, next actions) from the report agent. Raw logs stay in output/runs and output/ocpp-traffic.jsonl.
 */

export interface RunContext {
  runId: string;
  trigger: string;
  upgrade: boolean;
  startedAt: string;
  inputFiles: string[];
  model: string;
  targetFirmwareVersion: string | null;
}

export interface AgentStats {
  phase: string;
  steps: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface RunFacts {
  stations: Array<{ stationId: string; firmwareVersion: string }>;
  recommendations: Recommendation[];
  firmwareAttempts: FirmwareUpdateResult[];
  reboots: RebootResult[];
  postChecks: PostUpdateCheckResult[];
  tickets: Ticket[];
  followUps: FollowUp[];
  agentStats: AgentStats[];
}

export interface ReportNarrative {
  headline: string;
  executiveSummary: string;
  stationHighlights: Record<string, string>;
  risks: string[];
  nextActions: string[];
  generatedBy: "agent" | "fallback";
}

export interface StationSummary {
  stationId: string;
  verdict: Verdict | null;
  firmwareBefore: string;
  firmwareAfter: string | null;
  connection: string | null;
  completeSessions: number | null;
  energyDeliveredKWh: number | null;
  errorCodes: string[];
  rolloutOutcome: FirmwareUpdateOutcome | null;
  rollout: string;
  attempts: number;
  reboots: number;
  postCheck: "PASSED" | "FAILED" | null;
  ticketId: string | null;
  followUpDueAt: string | null;
  highlight: string;
}

export interface RunSummary {
  id: string;
  generatedAt: string;
  generatedBy: ReportNarrative["generatedBy"];
  run: RunContext & { finishedAt: string; durationMs: number };
  headline: string;
  executiveSummary: string;
  kpis: {
    stations: number;
    verdicts: Record<Verdict, number>;
    noRecommendation: number;
    installed: number;
    scheduled: number;
    failed: number;
    recoveryReboots: number;
    tickets: number;
    followUps: number;
  };
  stations: StationSummary[];
  tickets: Array<Pick<Ticket, "id" | "stationId" | "severity" | "title" | "reason">>;
  followUps: Array<Pick<FollowUp, "stationId" | "dueAt" | "firmwareVersion">>;
  risks: string[];
  nextActions: string[];
  agentStats: AgentStats[];
}

export const VERDICT_ORDER: Verdict[] = ["READY_FOR_UPGRADE", "ALREADY_ON_TARGET", "NEEDS_INVESTIGATION", "NOT_READY"];
const FAILED_OUTCOMES: FirmwareUpdateOutcome[] = ["FAILED", "REJECTED", "NO_RESPONSE", "TIMEOUT"];

function rolloutOf(
  context: RunContext,
  rec: Recommendation | undefined,
  attempts: FirmwareUpdateResult[],
  reboots: number,
  ticket: Ticket | undefined,
): string {
  const last = attempts.at(-1);
  if (last) {
    const failed = last.failedStatus ? ` (${last.failedStatus})` : "";
    const rebootText = reboots ? `, ${reboots} recovery reboot(s)` : "";
    return `${last.outcome}${failed} after ${last.attempt}/${last.maxAttempts} attempt(s)${rebootText}`;
  }
  if (!rec) return "no recommendation submitted";
  if (rec.verdict !== "READY_FOR_UPGRADE") return `not upgraded (${rec.verdict})`;
  if (!context.upgrade) return "not upgraded (analysis-only run)";
  if (!context.targetFirmwareVersion) return "not upgraded (no target firmware configured)";
  if (ticket) return "not upgraded (ticket created before the rollout)";
  return "not attempted";
}

export function buildRunSummary(context: RunContext, facts: RunFacts, narrative: ReportNarrative): RunSummary {
  const generatedAt = new Date();
  const stations: StationSummary[] = facts.stations.map(({ stationId, firmwareVersion }) => {
    const rec = facts.recommendations.find((r) => r.stationId === stationId);
    const attempts = facts.firmwareAttempts.filter((a) => a.stationId === stationId);
    const reboots = facts.reboots.filter((r) => r.stationId === stationId).length;
    const ticket = facts.tickets.find((t) => t.stationId === stationId);
    const post = facts.postChecks.find((c) => c.stationId === stationId);
    const last = attempts.at(-1);
    const firmwareAfter =
      last?.outcome === "INSTALLED"
        ? (last.reportedFirmwareVersion ?? last.targetVersion)
        : last?.outcome === "INSTALL_SCHEDULED"
          ? `${last.targetVersion} (pending install)`
          : null;
    return {
      stationId,
      verdict: rec?.verdict ?? null,
      firmwareBefore: rec?.firmwareVersion ?? firmwareVersion,
      firmwareAfter,
      connection: rec?.connectionStatus ?? null,
      completeSessions: rec?.completeSessions ?? null,
      energyDeliveredKWh: rec?.energyDeliveredKWh ?? null,
      errorCodes: rec?.errorCodes ?? [],
      rolloutOutcome: last?.outcome ?? null,
      rollout: rolloutOf(context, rec, attempts, reboots, ticket),
      attempts: attempts.length,
      reboots,
      postCheck: post ? (post.passed ? "PASSED" : "FAILED") : null,
      ticketId: ticket?.id ?? null,
      followUpDueAt: facts.followUps.find((f) => f.stationId === stationId)?.dueAt ?? null,
      highlight: narrative.stationHighlights[stationId] ?? rec?.summary ?? "No recommendation submitted.",
    };
  });

  const verdicts = Object.fromEntries(VERDICT_ORDER.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const s of stations) if (s.verdict) verdicts[s.verdict]++;
  const outcomes = stations.map((s) => s.rolloutOutcome);

  return {
    id: context.runId,
    generatedAt: generatedAt.toISOString(),
    generatedBy: narrative.generatedBy,
    run: { ...context, finishedAt: generatedAt.toISOString(), durationMs: generatedAt.getTime() - Date.parse(context.startedAt) },
    headline: narrative.headline,
    executiveSummary: narrative.executiveSummary,
    kpis: {
      stations: stations.length,
      verdicts,
      noRecommendation: stations.filter((s) => !s.verdict).length,
      installed: outcomes.filter((o) => o === "INSTALLED").length,
      scheduled: outcomes.filter((o) => o === "INSTALL_SCHEDULED").length,
      failed: outcomes.filter((o) => o !== null && FAILED_OUTCOMES.includes(o)).length,
      recoveryReboots: facts.reboots.length,
      tickets: facts.tickets.length,
      followUps: facts.followUps.length,
    },
    stations,
    tickets: facts.tickets.map(({ id, stationId, severity, title, reason }) => ({ id, stationId, severity, title, reason })),
    followUps: facts.followUps.map(({ stationId, dueAt, firmwareVersion }) => ({ stationId, dueAt, firmwareVersion })),
    risks: narrative.risks,
    nextActions: narrative.nextActions,
    agentStats: facts.agentStats,
  };
}

// --- shared formatting ---

const utc = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const label = (v: string | null): string => (v ? v.replace(/_/g, " ") : "-");
const kwh = (n: number | null): string => (n === null ? "-" : `${n} kWh`);
const mode = (s: RunSummary): string => (s.run.upgrade ? "analysis + rollout" : "analysis only");
const firmwareChange = (s: StationSummary): string => (s.firmwareAfter ? `${s.firmwareBefore} → ${s.firmwareAfter}` : `${s.firmwareBefore} (unchanged)`);

function kpiList(s: RunSummary): Array<[string, string]> {
  return [
    ["Stations analysed", String(s.kpis.stations)],
    ...VERDICT_ORDER.map((v): [string, string] => [label(v), String(s.kpis.verdicts[v])]),
    ...(s.kpis.noRecommendation ? [["No recommendation", String(s.kpis.noRecommendation)] as [string, string]] : []),
    ["Upgrades installed", String(s.kpis.installed)],
    ["Installs scheduled", String(s.kpis.scheduled)],
    ["Upgrades failed", String(s.kpis.failed)],
    ["Recovery reboots", String(s.kpis.recoveryReboots)],
    ["Tickets", String(s.kpis.tickets)],
    ["Follow-ups due", String(s.kpis.followUps)],
  ];
}

function headerFacts(s: RunSummary): Array<[string, string]> {
  return [
    ["Run", s.run.runId],
    ["Mode", mode(s)],
    ["Trigger", s.run.trigger],
    ["Started", utc(s.run.startedAt)],
    ["Finished", `${utc(s.run.finishedAt)} (${duration(s.run.durationMs)})`],
    ["Target firmware", s.run.targetFirmwareVersion ?? "not configured"],
    ["Model", s.run.model],
    ["Input files", s.run.inputFiles.join(", ") || "-"],
  ];
}

// --- Markdown ---

const mdCell = (v: string): string => v.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function toMarkdown(s: RunSummary): string {
  const lines = [
    `# Firmware rollout report: ${s.headline}`,
    "",
    ...headerFacts(s).map(([k, v]) => `- **${k}:** ${v}`),
    ...(s.generatedBy === "fallback" ? ["", "> The report agent did not finish; this summary was generated automatically from the run state."] : []),
    "",
    "## Executive summary",
    "",
    s.executiveSummary,
    "",
    "## Key figures",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...kpiList(s).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Stations",
    "",
    "| Station | Verdict | Firmware | Rollout | Post-update | Ticket | Highlight |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...s.stations.map(
      (x) =>
        `| ${x.stationId} | ${label(x.verdict)} | ${mdCell(firmwareChange(x))} | ${mdCell(x.rollout)} | ${x.postCheck ?? "-"} | ` +
        `${x.ticketId ?? "-"} | ${mdCell(x.highlight)} |`,
    ),
    "",
    "| Station | Connection | Complete sessions (24h) | Energy | Error codes |",
    "| --- | --- | --- | --- | --- |",
    ...s.stations.map(
      (x) => `| ${x.stationId} | ${x.connection ?? "-"} | ${x.completeSessions ?? "-"} | ${kwh(x.energyDeliveredKWh)} | ${x.errorCodes.join(", ") || "-"} |`,
    ),
    "",
  ];

  if (s.tickets.length) {
    lines.push("## Tickets", "", ...s.tickets.map((t) => `- **${t.id}** (${t.severity}, ${t.stationId}): ${t.title}. ${t.reason}`), "");
  }
  if (s.followUps.length) {
    lines.push("## Follow-ups", "", ...s.followUps.map((f) => `- **${f.stationId}**: re-check on firmware ${f.firmwareVersion} due ${utc(f.dueAt)}`), "");
  }
  if (s.risks.length) lines.push("## Risks", "", ...s.risks.map((r) => `- ${r}`), "");
  if (s.nextActions.length) lines.push("## Next actions", "", ...s.nextActions.map((a) => `- ${a}`), "");

  if (s.agentStats.length) {
    lines.push(
      "## Appendix: agent activity",
      "",
      "| Phase | Duration | LLM steps | Tool calls | Tokens in | Tokens out |",
      "| --- | --- | --- | --- | --- | --- |",
      ...s.agentStats.map((a) => `| ${a.phase} | ${duration(a.durationMs)} | ${a.steps} | ${a.toolCalls} | ${a.tokensIn} | ${a.tokensOut} |`),
      "",
    );
  }
  lines.push(`_Generated ${utc(s.generatedAt)} by the Firmware Rollout Control Room._`, "");
  return lines.join("\n");
}

// --- HTML (self-contained, printable) ---

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const paragraphs = (text: string): string =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

const verdictChip = (v: Verdict | null): string => (v ? `<span class="chip v-${v}">${esc(label(v))}</span>` : `<span class="chip">-</span>`);

function outcomeChip(x: StationSummary): string {
  const kind =
    x.rolloutOutcome === "INSTALLED" ? "good" : x.rolloutOutcome === "INSTALL_SCHEDULED" ? "warn" : x.rolloutOutcome ? "bad" : "muted";
  return `<span class="out ${kind}">${esc(x.rollout)}</span>`;
}

const STYLES = `
:root { --ink: #0a1222; --muted: #5b6c8c; --line: #dbe2ee; --soft: #f4f7fb; --yellow: #ffda00; --green: #1f9d5c; --amber: #c27c00; --red: #d0283a; --cyan: #1b8fb3; }
* { box-sizing: border-box; }
body { margin: 0; background: #e9eef6; color: var(--ink); font: 14px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
.page { max-width: 1040px; margin: 24px auto; background: #fff; border-radius: 14px; box-shadow: 0 10px 40px rgba(10, 18, 34, 0.12); overflow: hidden; }
header { background: #0a1222; color: #fff; padding: 24px 32px; display: flex; gap: 16px; align-items: center; }
.logo { width: 44px; height: 44px; border-radius: 11px; background: var(--yellow); display: grid; place-items: center; flex: none; }
.logo svg { width: 26px; height: 26px; fill: #0a1222; }
header h1 { margin: 0; font-size: 20px; }
header p { margin: 2px 0 0; color: #a9b8d3; font-size: 13px; }
main { padding: 8px 32px 28px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); margin: 26px 0 10px; border-bottom: 2px solid var(--yellow); padding-bottom: 4px; display: inline-block; }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 32px; margin-top: 18px; font-size: 13px; }
.facts div { display: flex; gap: 8px; }
.facts div.wide { grid-column: 1 / -1; }
.facts b { color: var(--muted); font-weight: 600; min-width: 120px; flex: none; }
.notice { margin-top: 14px; padding: 10px 14px; border-radius: 9px; background: #fff7d6; border: 1px solid #f2d36b; font-size: 13px; }
.summary { font-size: 15px; }
.summary p { margin: 0 0 10px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.kpi { background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.kpi .v { font-size: 22px; font-weight: 800; }
.kpi .k { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--muted); font-weight: 600; font-size: 12px; padding: 8px; border-bottom: 2px solid var(--line); }
td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.mono, .mono { font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
td.station { white-space: nowrap; }
.chip { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: 0.4px; padding: 2px 8px; border-radius: 999px; background: var(--soft); white-space: nowrap; }
.v-READY_FOR_UPGRADE { background: #d8f5e6; color: var(--green); }
.v-NOT_READY { background: #fde0e3; color: var(--red); }
.v-NEEDS_INVESTIGATION { background: #fff0d1; color: var(--amber); }
.v-ALREADY_ON_TARGET { background: #d9f1f9; color: var(--cyan); }
.out { font-size: 12px; }
.out.good { color: var(--green); font-weight: 600; }
.out.warn { color: var(--amber); font-weight: 600; }
.out.bad { color: var(--red); font-weight: 600; }
.out.muted { color: var(--muted); }
.highlight { color: #2b3a55; }
ul { margin: 0; padding-left: 20px; }
li { margin: 4px 0; }
footer { color: var(--muted); font-size: 12px; padding: 14px 32px 22px; border-top: 1px solid var(--line); }
@media print {
  body { background: #fff; }
  .page { margin: 0; box-shadow: none; border-radius: 0; max-width: none; }
  header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .chip, .kpi, h2 { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tr, .kpi { break-inside: avoid; }
  h2 { break-after: avoid; }
}`;

function htmlList(items: string[]): string {
  return `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

export function toHtml(s: RunSummary): string {
  const sections: string[] = [];

  sections.push(
    `<div class="facts">${headerFacts(s)
      .map(([k, v]) => `<div${k === "Input files" ? ' class="wide"' : ""}><b>${esc(k)}</b><span${k === "Run" ? ' class="mono"' : ""}>${esc(v)}</span></div>`)
      .join("")}</div>`,
  );
  if (s.generatedBy === "fallback") {
    sections.push(`<div class="notice">The report agent did not finish; this summary was generated automatically from the run state.</div>`);
  }
  sections.push(`<h2>Executive summary</h2><div class="summary">${paragraphs(s.executiveSummary)}</div>`);
  sections.push(
    `<h2>Key figures</h2><div class="kpis">${kpiList(s)
      .map(([k, v]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`)
      .join("")}</div>`,
  );
  sections.push(
    `<h2>Stations</h2><table><thead><tr><th>Station</th><th>Verdict</th><th>Firmware</th><th>Rollout</th><th>Post-update</th><th>Ticket</th></tr></thead><tbody>` +
      s.stations
        .map(
          (x) =>
            `<tr><td class="mono station"><b>${esc(x.stationId)}</b></td><td>${verdictChip(x.verdict)}</td><td class="mono">${esc(firmwareChange(x))}</td>` +
            `<td>${outcomeChip(x)}</td><td>${esc(x.postCheck ?? "-")}</td><td class="mono">${esc(x.ticketId ?? "-")}</td></tr>` +
            `<tr><td></td><td colspan="5" class="highlight">${esc(x.highlight)}</td></tr>`,
        )
        .join("") +
      `</tbody></table>`,
  );
  sections.push(
    `<h2>Readiness checks</h2><table><thead><tr><th>Station</th><th>Connection</th><th>Complete sessions (24h)</th><th>Energy</th><th>Error codes</th></tr></thead><tbody>` +
      s.stations
        .map(
          (x) =>
            `<tr><td class="mono">${esc(x.stationId)}</td><td>${esc(x.connection ?? "-")}</td><td>${esc(x.completeSessions ?? "-")}</td>` +
            `<td>${esc(kwh(x.energyDeliveredKWh))}</td><td>${esc(x.errorCodes.join(", ") || "-")}</td></tr>`,
        )
        .join("") +
      `</tbody></table>`,
  );
  if (s.tickets.length) {
    sections.push(
      `<h2>Tickets</h2><table><thead><tr><th>Ticket</th><th>Station</th><th>Severity</th><th>Title</th><th>Reason</th></tr></thead><tbody>` +
        s.tickets
          .map(
            (t) =>
              `<tr><td class="mono">${esc(t.id)}</td><td class="mono">${esc(t.stationId)}</td><td>${esc(t.severity)}</td><td>${esc(t.title)}</td><td>${esc(t.reason)}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`,
    );
  }
  if (s.followUps.length) {
    sections.push(
      `<h2>Follow-ups</h2>` +
        htmlList(s.followUps.map((f) => `${f.stationId}: re-check on firmware ${f.firmwareVersion} due ${utc(f.dueAt)}`)),
    );
  }
  if (s.risks.length) sections.push(`<h2>Risks</h2>${htmlList(s.risks)}`);
  if (s.nextActions.length) sections.push(`<h2>Next actions</h2>${htmlList(s.nextActions)}`);
  if (s.agentStats.length) {
    sections.push(
      `<h2>Appendix: agent activity</h2><table><thead><tr><th>Phase</th><th>Duration</th><th>LLM steps</th><th>Tool calls</th><th>Tokens in</th><th>Tokens out</th></tr></thead><tbody>` +
        s.agentStats
          .map(
            (a) =>
              `<tr><td>${esc(a.phase)}</td><td>${esc(duration(a.durationMs))}</td><td>${a.steps}</td><td>${a.toolCalls}</td><td>${a.tokensIn}</td><td>${a.tokensOut}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`,
    );
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Firmware rollout report ${esc(s.id)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="page">
<header>
<div class="logo"><svg viewBox="0 0 32 32"><path d="M18 4 8 18h7l-2 10 11-15h-7z"/></svg></div>
<div><h1>${esc(s.headline)}</h1><p>Firmware rollout report · ${esc(mode(s))} · ${esc(utc(s.run.startedAt))}</p></div>
</header>
<main>
${sections.join("\n")}
</main>
<footer>Generated ${esc(utc(s.generatedAt))} by the Firmware Rollout Control Room · run ${esc(s.id)}</footer>
</div>
</body>
</html>
`;
}
