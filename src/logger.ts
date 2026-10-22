import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Operator-facing log. Every line says what the agent plans, what it is doing, or what came out of it,
 * so a run can be followed live on screen. A JSON-lines copy is written per run for later inspection.
 */

type Level = "debug" | "info" | "warn" | "error";
type Kind = "banner" | "phase" | "plan" | "do" | "ok" | "issue" | "fail" | "agent" | "ocpp" | "info" | "warn" | "error" | "debug";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: Level = (["debug", "info", "warn", "error"] as const).find((l) => l === process.env["LOG_LEVEL"]) ?? "info";

const COLOR = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint =
  (code: string) =>
  (text: string): string =>
    COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
const dim = paint("2");
const bold = paint("1");

const TAGS: Record<Kind, { label: string; color: (t: string) => string; level: Level }> = {
  banner: { label: "", color: paint("1;36"), level: "info" },
  phase: { label: "", color: paint("1;35"), level: "info" },
  plan: { label: "PLAN", color: paint("36"), level: "info" },
  do: { label: "DO", color: paint("34"), level: "info" },
  ok: { label: "OK", color: paint("32"), level: "info" },
  issue: { label: "ISSUE", color: paint("33"), level: "info" },
  fail: { label: "FAIL", color: paint("31"), level: "warn" },
  agent: { label: "AGENT", color: paint("35"), level: "info" },
  ocpp: { label: "OCPP", color: paint("33"), level: "info" },
  info: { label: "INFO", color: (t) => t, level: "info" },
  warn: { label: "WARN", color: paint("33"), level: "warn" },
  error: { label: "ERROR", color: paint("1;31"), level: "error" },
  debug: { label: "DEBUG", color: dim, level: "debug" },
};

let runLogFile: string | undefined;

export interface LogEntry {
  ts: string;
  level: Level;
  kind: Kind | "block";
  station?: string;
  message: string;
}

const sinks = new Set<(entry: LogEntry) => void>();

/** Receives every log entry (including debug) exactly as the console sees it, minus colours. */
export function addLogSink(sink: (entry: LogEntry) => void): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Starts a JSON-lines copy of everything logged from now on. */
export function startRunLog(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  runLogFile = path;
}

const clock = (): string => new Date().toISOString().slice(11, 23);

function record(level: Level, kind: Kind | "block", message: string, station?: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const plain = stripAnsi(message);
  for (const sink of sinks) sink({ ts, level, kind, ...(station ? { station } : {}), message: plain });

  if (!runLogFile) return;
  const entry = { ts, level, kind, ...(station ? { station } : {}), message: plain, ...(data !== undefined ? { data } : {}) };
  try {
    appendFileSync(runLogFile, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    runLogFile = undefined;
  }
}

function emit(kind: Kind, message: string, station?: string, data?: unknown): void {
  const tag = TAGS[kind];
  const level = tag.level;
  record(level, kind, message, station, data);
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;

  const label = tag.label ? tag.color(tag.label.padEnd(5)) : "";
  const where = station ? `${bold(`[${station}]`)} ` : "";
  const continuation = "\n" + " ".repeat(21);
  const line = `${dim(clock())}  ${label}  ${where}${message.replace(/\n/g, continuation)}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  banner(title: string, subtitle?: string): void {
    const bar = "═".repeat(Math.max(title.length + 4, 60));
    console.log("\n" + TAGS.banner.color(bar));
    console.log(TAGS.banner.color(`  ${title}`) + (subtitle ? dim(`  ${subtitle}`) : ""));
    console.log(TAGS.banner.color(bar));
    record("info", "banner", title, undefined, subtitle ? { subtitle } : undefined);
  },
  phase(index: number, total: number, name: string, description: string): void {
    console.log("\n" + TAGS.phase.color(`━━ PHASE ${index}/${total} · ${name} ━━ `) + dim(description));
    record("info", "phase", `${index}/${total} ${name}: ${description}`);
  },
  plan: (message: string, station?: string): void => emit("plan", message, station),
  do: (message: string, station?: string): void => emit("do", message, station),
  ok: (message: string, station?: string, data?: unknown): void => emit("ok", message, station, data),
  /** A check that found a problem (the tool itself worked). */
  issue: (message: string, station?: string, data?: unknown): void => emit("issue", message, station, data),
  /** Something actually went wrong: a tool error, a refused or failed station command. */
  fail: (message: string, station?: string, data?: unknown): void => emit("fail", message, station, data),
  agent: (message: string): void => emit("agent", message),
  ocpp: (message: string, station?: string, data?: unknown): void => emit("ocpp", message, station, data),
  info: (message: string, station?: string): void => emit("info", message, station),
  warn: (message: string, station?: string): void => emit("warn", message, station),
  error: (message: string, station?: string): void => emit("error", message, station),
  debug: (message: string, station?: string, data?: unknown): void => emit("debug", message, station, data),
  /** Indented continuation lines (tables, multi-line summaries). */
  block(text: string): void {
    for (const line of text.split("\n")) console.log(`${" ".repeat(21)}${line}`);
    record("info", "block", text);
  },
  dim,
  bold,
};
