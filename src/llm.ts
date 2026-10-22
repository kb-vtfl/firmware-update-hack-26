import {
  AZURE_FOUNDRY_API_KEY,
  AZURE_FOUNDRY_DEPLOYMENT,
  RESPONSES_API,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
} from "./config.js";
import { log } from "./logger.js";
import type { LLMResponse, ResponseOutput } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

export function assertLlmConfigured(): void {
  if (!AZURE_FOUNDRY_API_KEY) throw new Error("AZURE_FOUNDRY_API_KEY is not set (see .env.example)");
  if (!/^https?:\/\/[^/]+/.test(RESPONSES_API)) {
    throw new Error("Set AZURE_FOUNDRY_ENDPOINT or AZURE_FOUNDRY_RESPONSES_URL (see .env.example)");
  }
}

async function callResponses(body: Record<string, unknown>): Promise<LLMResponse> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RESPONSES_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": AZURE_FOUNDRY_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if ((res.status === 429 || res.status >= 500) && attempt < RETRY_MAX_ATTEMPTS) {
      const delay = retryDelayMs(res, attempt);
      log.warn(`Foundry returned HTTP ${res.status}, retrying in ${delay} ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
      await sleep(delay);
      continue;
    }

    const text = await res.text();
    let data: LLMResponse;
    try {
      data = JSON.parse(text) as LLMResponse;
    } catch {
      throw new Error(`Foundry returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok || data.error) {
      throw new Error(`Foundry API error ${res.status}: ${data.error?.message ?? text.slice(0, 300)}`);
    }
    return data;
  }
}

export async function chatLLM(input: unknown[], tools: unknown[], instructions: string): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model: AZURE_FOUNDRY_DEPLOYMENT,
    input,
    instructions,
  };
  if (tools.length > 0) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }
  return callResponses(body);
}

export function extractToolCalls(response: LLMResponse): ResponseOutput[] {
  return (response.output ?? []).filter((item) => item.type === "function_call");
}

export function extractText(response: LLMResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}
