import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CallUsage } from "./vision/provider";

export const DEFAULT_RUN_LOG = path.join("runs", "log.jsonl");

export interface Prices {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

/** Reads prices from env. Returns null if either is missing or not a number, so no cost is invented. */
export function pricesFromEnv(env: Record<string, string | undefined> = process.env): Prices | null {
  const input = Number.parseFloat(env.PRICE_INPUT_PER_MTOK_USD ?? "");
  const output = Number.parseFloat(env.PRICE_OUTPUT_PER_MTOK_USD ?? "");
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { inputPerMTokUsd: input, outputPerMTokUsd: output };
}

export function callCostUsd(u: Pick<CallUsage, "inputTokens" | "outputTokens">, p: Prices): number {
  return (u.inputTokens * p.inputPerMTokUsd + u.outputTokens * p.outputPerMTokUsd) / 1_000_000;
}

export interface LoggedCall {
  stage: "observe" | "verify";
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  retries: number;
  wall_ms: number;
  error?: string;
}

export interface RunLogEntry {
  ts: string;
  run_id: string;
  provider: string | null;
  model_id: string | null;
  outcome: "ok" | "declined" | "error";
  error?: string;
  photos: { before: number; after: number };
  calls: LoggedCall[];
  stage_ms: Record<string, number>;
  total_ms: number;
  prices: Prices | null;
  /** Null when prices are not configured. */
  cost_usd: number | null;
  counts?: Record<string, number>;
}

export function toLoggedCall(stage: LoggedCall["stage"], u: CallUsage, error?: string): LoggedCall {
  return {
    stage,
    model_id: u.modelId,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    retries: u.retries,
    wall_ms: u.wallMs,
    ...(error ? { error } : {}),
  };
}

export function totalCost(calls: LoggedCall[], prices: Prices | null): number | null {
  if (!prices) return null;
  const usd = calls.reduce(
    (sum, c) => sum + callCostUsd({ inputTokens: c.input_tokens, outputTokens: c.output_tokens }, prices),
    0,
  );
  return Math.round(usd * 1e6) / 1e6;
}

/** Appends one JSON line. Never throws: a logging problem must not break a run. */
export async function appendRunLog(entry: RunLogEntry, file = process.env.RUN_LOG_PATH || DEFAULT_RUN_LOG) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("Could not write run log:", err);
  }
}
