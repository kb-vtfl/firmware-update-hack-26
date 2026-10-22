import { MAX_AGENT_STEPS, MAX_COMPLETION_NUDGES } from "./config.js";
import * as dashboard from "./dashboard.js";
import { chatLLM, extractText, extractToolCalls } from "./llm.js";
import { log } from "./logger.js";
import { summarizeToolResult } from "./summaries.js";
import { executeTool, getRecommendations, getTickets } from "./tools.js";
import type { ResponseOutput, ToolDefinition } from "./types.js";

export interface AgentTask {
  instructions: string;
  query: string;
  tools: ToolDefinition[];
  /** Work the agent still owes; while non-empty, a premature finish is answered with a reminder. */
  pending: () => string[];
  reminder: (pending: string[]) => string;
}

export interface AgentRun {
  text: string;
  steps: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
}

/** Any message text the model emits alongside tool calls is its own commentary on what it is doing. */
function commentary(output: ResponseOutput[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text?.trim()) parts.push(part.text.trim());
    }
  }
  return parts.join(" ");
}

async function runToolCall(call: ResponseOutput, allowed: Set<string>): Promise<{ output: string }> {
  const name = call.name ?? "";
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    log.fail(`${name}: arguments are not valid JSON`);
    return { output: JSON.stringify({ error: "Arguments were not valid JSON." }) };
  }

  const { intent, ...toolArgs } = args;
  const station = typeof toolArgs["stationId"] === "string" ? toolArgs["stationId"] : undefined;
  const plan = typeof intent === "string" && intent.trim() ? intent.trim() : `(no intent given) calling ${name}`;
  log.plan(plan, station);

  // Short scalar arguments only; long texts and lists (reasons, summaries) stay in the JSON run log.
  const shownArgs = Object.entries(toolArgs)
    .filter(([key, value]) => key !== "stationId" && ["string", "number", "boolean"].includes(typeof value))
    .filter(([, value]) => String(value).length <= 40)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  log.do(`${name}${shownArgs ? ` ${log.dim(shownArgs)}` : ""}`, station);

  if (!allowed.has(name)) {
    log.fail(`${name} is not available in this phase`, station);
    return { output: JSON.stringify({ error: `Tool ${name} is not available in this phase.` }) };
  }

  const started = Date.now();
  dashboard.toolStarted(station, name, plan, toolArgs);
  try {
    const result = await executeTool(name, toolArgs);
    dashboard.toolFinished(station, name, result, {
      recommendation: getRecommendations().find((r) => r.stationId === station),
      ticket: getTickets().find((t) => t.stationId === station),
    });
    const outcome = summarizeToolResult(name, result);
    const took = log.dim(`(${Date.now() - started} ms)`);
    log[outcome.level](`${outcome.text} ${took}`, station, { args: toolArgs, result });
    return { output: JSON.stringify(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.fail(`${name} threw: ${message}`, station);
    dashboard.toolFinished(station, name, { error: message }, {});
    return { output: JSON.stringify({ error: message }) };
  }
}

export async function runAgent(task: AgentTask): Promise<AgentRun> {
  const input: unknown[] = [{ role: "user", content: task.query }];
  const allowed = new Set(task.tools.map((t) => t.name));
  const run: AgentRun = { text: "", steps: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
  let nudges = 0;

  for (let step = 1; step <= MAX_AGENT_STEPS; step++) {
    run.steps = step;
    log.agent(log.dim(`reasoning… (step ${step})`));
    const started = Date.now();
    dashboard.agentThinking(step, true);
    const response = await chatLLM(input, task.tools, task.instructions).finally(() => dashboard.agentThinking(step, false));
    run.tokensIn += response.usage?.input_tokens ?? 0;
    run.tokensOut += response.usage?.output_tokens ?? 0;
    log.debug(
      `LLM step ${step}: ${Date.now() - started} ms, tokens in=${response.usage?.input_tokens ?? 0} out=${response.usage?.output_tokens ?? 0}`,
    );

    for (const item of response.output) input.push(item);
    const toolCalls = extractToolCalls(response);

    if (toolCalls.length === 0) {
      const pending = task.pending();
      if (pending.length > 0 && nudges < MAX_COMPLETION_NUDGES) {
        nudges++;
        log.warn(`Agent tried to finish with work left (${pending.join(", ")}) — reminding it`);
        input.push({ role: "user", content: task.reminder(pending) });
        continue;
      }
      run.text = extractText(response) || "Done.";
      return run;
    }

    const said = commentary(response.output);
    if (said) log.agent(said);
    log.agent(`decided to run ${toolCalls.length} tool call(s): ${[...new Set(toolCalls.map((c) => c.name))].join(", ")}`);

    for (const call of toolCalls) {
      run.toolCalls++;
      const { output } = await runToolCall(call, allowed);
      input.push({ type: "function_call_output", call_id: call.call_id, output });
    }
  }

  throw new Error(`Max steps (${MAX_AGENT_STEPS}) reached without finishing`);
}
