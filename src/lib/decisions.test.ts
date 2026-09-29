import { describe, expect, it } from "vitest";
import { collectTakes, DecisionSchema, decisionToken, sumStepUsage } from "./decisions";
import { CLAUDE_OPUS, costUsd } from "./models";

const DECISION = {
  play: "expand",
  confidence: 0.8,
  why: ["Weekly spend up 62% ($57.2k to $92.9k)", "On pace for $4.83M/yr vs a $2.92M commit"],
  nextStep: "Propose a larger commit before the Feb 28 renewal.",
};

describe("decisions", () => {
  it("accepts a well-formed decision and rejects bad ones", () => {
    expect(DecisionSchema.safeParse(DECISION).success).toBe(true);
    expect(DecisionSchema.safeParse({ ...DECISION, why: ["only one reason"] }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...DECISION, why: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...DECISION, confidence: 1.2 }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...DECISION, play: "upsell" }).success).toBe(false);
  });

  it("keys hook tokens by run so two runs on one day can't collide", () => {
    expect(decisionToken("wrun_A", "acct_x")).not.toBe(decisionToken("wrun_B", "acct_x"));
  });

  it("marks top accounts with no report as timed out", () => {
    const failed = { status: "failed" as const, error: "boom" };
    expect(collectTakes(["a", "b"], { a: failed })).toEqual({ a: failed, b: { status: "timed_out" } });
  });

  it("adds up the agent's model calls, keeping the cache split", () => {
    const steps = [
      // Quarrystone's first call on 2026-09-29
      { usage: { inputTokens: 1_563, outputTokens: 1_024, inputTokenDetails: { cacheReadTokens: 1_237, cacheWriteTokens: 314 } } },
      { usage: { inputTokens: 2_000, outputTokens: 300, inputTokenDetails: { cacheReadTokens: 1_500 } } },
      { usage: { inputTokens: 500, outputTokens: 50 } },
    ];
    expect(sumStepUsage(CLAUDE_OPUS, steps)).toEqual({
      model: CLAUDE_OPUS,
      inputTokens: 4_063,
      outputTokens: 1_374,
      cacheReadTokens: 2_737,
      cacheWriteTokens: 314,
    });
  });

  it("prices the agent's tokens, with cached input at the cache rate", () => {
    // 10k fresh x $4 + 20k cache reads x $0.20 + 5k cache writes x $5 + 2k output x $20, per 1M
    const cost = costUsd(CLAUDE_OPUS, { inputTokens: 35_000, outputTokens: 2_000, cacheReadTokens: 20_000, cacheWriteTokens: 5_000 });
    expect(cost).toBeCloseTo(0.04 + 0.004 + 0.025 + 0.04, 9);
  });
});
