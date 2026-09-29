import { describe, expect, it } from "vitest";
import { checkYearlyPace, collectTakes, DecisionSchema, decisionToken, paceFacts, sumStepUsage } from "./decisions";
import { CLAUDE_OPUS, costUsd } from "./models";

const DECISION = {
  play: "expand",
  yearlyPaceUsd: 4_830_000,
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
    expect(DecisionSchema.safeParse({ ...DECISION, yearlyPaceUsd: -1 }).success).toBe(false);
  });

  it("computes this week x 52 and the 4-week average x 52", () => {
    expect(paceFacts([10_000, 10_000, 10_000, 50_000])).toEqual({ thisWeekYearly: 2_600_000, fourWeekYearly: 1_040_000 });
  });

  describe("checking the agent's yearly figure against code's", () => {
    // Quarrystone on 2026-09-29: $17.4k this week x 52 = $905k/yr; about $1.02M/yr on the 4-week average.
    const quarrystone = { thisWeekYearly: 905_000, fourWeekYearly: 1_020_000 };

    it("rejects a figure more than 3x from both, and the message gives code's figures", () => {
      const message = checkYearlyPace(146_000, quarrystone);
      expect(message).toContain("$146k");
      expect(message).toContain("this week × 52 = $905k/yr");
      expect(message).toContain("the 4-week average × 52 = $1.02M/yr");
    });

    it("accepts the correct figure", () => {
      expect(checkYearlyPace(905_000, quarrystone)).toBeNull();
    });

    it("accepts an honest estimate after a one-off spike: half the 4-week figure", () => {
      const spike = paceFacts([10_000, 10_000, 10_000, 50_000]); // $2.6M/yr this week, $1.04M/yr on average
      expect(checkYearlyPace(520_000, spike)).toBeNull();
      // More than 3x under this week x 52, so it passes on the 4-week figure alone.
      expect(checkYearlyPace(520_000, { thisWeekYearly: spike.thisWeekYearly, fourWeekYearly: spike.thisWeekYearly })).not.toBeNull();
    });
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
