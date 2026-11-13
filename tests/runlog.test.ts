import { describe, expect, it } from "vitest";
import { callCostUsd, modelEnvSuffix, pricesForModel, pricesFromEnv, totalCost } from "@/lib/runlog";

describe("prices and cost", () => {
  const env = {
    GEMINI_MODEL_ID: "gemini-main",
    PRICE_INPUT_PER_MTOK_USD: "0.75",
    PRICE_OUTPUT_PER_MTOK_USD: "3.75",
    "PRICE_INPUT_PER_MTOK_USD__GEMINI_3_5_FLASH_LITE": "0.30",
    "PRICE_OUTPUT_PER_MTOK_USD__GEMINI_3_5_FLASH_LITE": "2.50",
  };

  it("reads prices only from env and never invents them", () => {
    expect(pricesFromEnv(env)).toEqual({ inputPerMTokUsd: 0.75, outputPerMTokUsd: 3.75 });
    expect(pricesFromEnv({})).toBeNull();
    expect(pricesFromEnv({ PRICE_INPUT_PER_MTOK_USD: "abc", PRICE_OUTPUT_PER_MTOK_USD: "1" })).toBeNull();
  });

  it("uses per-model prices, and plain prices only for the configured model", () => {
    expect(modelEnvSuffix("gemini-3.5-flash-lite")).toBe("GEMINI_3_5_FLASH_LITE");
    expect(pricesForModel("gemini-3.5-flash-lite", env)).toEqual({ inputPerMTokUsd: 0.3, outputPerMTokUsd: 2.5 });
    expect(pricesForModel("gemini-main", env)).toEqual({ inputPerMTokUsd: 0.75, outputPerMTokUsd: 3.75 });
    expect(pricesForModel("some-other-model", env)).toBeNull();
  });

  it("computes cost from tokens", () => {
    const p = { inputPerMTokUsd: 1, outputPerMTokUsd: 10 };
    expect(callCostUsd({ inputTokens: 1_000_000, outputTokens: 100_000 }, p)).toBeCloseTo(2);
    const calls = [
      { stage: "observe" as const, model_id: "m", input_tokens: 10_000, output_tokens: 2_000, retries: 0, wall_ms: 1 },
      { stage: "verify" as const, model_id: "m", input_tokens: 1_000, output_tokens: 500, retries: 1, wall_ms: 1 },
    ];
    expect(totalCost(calls, p)).toBeCloseTo(0.036);
    expect(totalCost(calls, null)).toBeNull();
  });
});
