import { describe, expect, it } from "vitest";
import { rankAccounts, type CrmAccount } from "./rules";
import { formatSummary } from "./summary-message";
import type { UsageSummary } from "./usage-summary";

function usage(key: string, now: number, before: number, errorRate = 0.005): UsageSummary {
  return {
    accountKey: key,
    thisWeek: { spend: now, requests: 10_000, errors: Math.round(10_000 * errorRate) },
    lastWeek: { spend: before, requests: 10_000, errors: 50 },
    weeklySpend: [before, before, before, now],
    newModels: [],
  };
}

function crm(key: string, name: string, overrides: Partial<CrmAccount> = {}): CrmAccount {
  return {
    accountKey: key,
    salesforceId: key,
    name,
    ownerName: "Ethan Lin",
    plan: "Pay as you go",
    committedSpend: null,
    renewalDate: null,
    hasOpenOpportunity: false,
    ...overrides,
  };
}

describe("formatSummary", () => {
  const ranking = rankAccounts(
    [
      crm("a", "Kestrel", { plan: "Committed", committedSpend: 520_000, renewalDate: "2027-02-28", hasOpenOpportunity: true }),
      crm("b", "Bravo", { renewalDate: "2026-12-01" }),
      crm("c", "Charlie", { renewalDate: "2027-01-01" }),
      crm("d", "Delta", { renewalDate: "2027-02-01" }),
      crm("e", "Echo", { renewalDate: "2027-03-01" }),
      crm("f", "Foxtrot"),
      crm("g", "Golf"),
    ],
    [
      usage("a", 12_000, 8_000), // usage jump $208k (priority) + commit pace $104k
      usage("b", 3_000, 1_000),
      usage("c", 3_000, 1_000),
      usage("d", 3_000, 1_000),
      usage("e", 3_000, 1_000),
      usage("f", 1_600, 1_000), // ranked 6th: also flagged
      usage("g", 5_000, 5_000, 0.03), // error spike only: watching
    ],
  );
  const lines = formatSummary("2026-09-26", ranking).split("\n");

  it("opens with the counts and how priority works", () => {
    expect(lines[0]).toBe("*Signal Gen · Sat, Sep 26*: 7 accounts checked, 6 flagged.");
    expect(lines[1]).toBe("Priority = each account's biggest signal in $/yr, not the sum.");
  });

  it("shows every signal with its math and marks the one that sets priority", () => {
    const start = lines.indexOf("1. *Kestrel* · Expand · $208k/yr at stake");
    expect(lines.slice(start + 1, start + 4)).toEqual([
      "      • Usage jump: $8.00k → $12.0k a week (1.50x; fires at 1.5x+ with $1k+ this week) → +$4.00k/wk × 52 = $208k/yr  ← priority",
      "      • Commit pace: $12.0k/wk × 52 = $624k/yr vs a $520k commit (1.20x; fires at 1.2x+) → $104k/yr over commit",
      "      Owner: Ethan Lin · Renewal: 2027-02-28 · Open opportunity: yes",
    ]);
    expect(lines.filter((l) => l.endsWith("← priority"))).toHaveLength(6);
  });

  it("gives also-flagged and watched accounts the same signal lines", () => {
    const also = lines.indexOf("*Also flagged* (logged, outside the top 5):");
    expect(lines.slice(also + 1, also + 4)).toEqual([
      "6. *Foxtrot* · Expand · $31.2k/yr at stake",
      "      • Usage jump: $1.00k → $1.60k a week (1.60x; fires at 1.5x+ with $1k+ this week) → +$600/wk × 52 = $31.2k/yr  ← priority",
      "      Owner: Ethan Lin · Renewal: none (pay as you go) · Open opportunity: no",
    ]);
    const watching = lines.indexOf("*Watching* (no $ signal, so not ranked):");
    expect(lines.slice(watching + 1)).toEqual([
      "• *Golf*",
      "      • Error spike: 0.50% → 3.00% of requests failed (6.00x; fires at 2x+ and 2%+) · context only, no $ value",
    ]);
  });
});

describe("formatSummary with the agent's take", () => {
  const ranking = rankAccounts(
    ["a", "b", "c", "d", "e"].map((key) => crm(key, key.toUpperCase())),
    ["a", "b", "c", "d", "e"].map((key, i) => usage(key, 3_000 + i * 100, 1_000)),
  );
  const why = ["Weekly spend up 3x ($1.00k to $3.40k)", "No open opportunity"];
  const decided = (play: "expand" | "ignore", email: { subject: string; body: string; model: string } | null) => ({
    status: "decided" as const,
    decision: { play, yearlyPaceUsd: 170_000, confidence: 0.8, why, nextStep: "Call them this week." },
    email,
    agentUsage: { model: "anthropic/claude-opus-5.5", inputTokens: 1, outputTokens: 1 },
    emailUsage: null,
  });
  const text = formatSummary("2026-09-27", ranking, {
    e: decided("expand", { subject: "Room to grow", body: "Hi Pat,\nUsage tripled.", model: "zai-org/GLM-5.3-Flash" }),
    d: decided("ignore", null),
    c: decided("expand", null),
    b: { status: "failed", error: "Salesforce 503" },
    a: { status: "timed_out" },
  });

  it("keeps each account's rule lines and puts the agent's take, email and model under them", () => {
    const lines = text.split("\n");
    const start = lines.indexOf("1. *E* · Expand · $125k/yr at stake");
    expect(lines.slice(start + 2, start + 10)).toEqual([
      "      Owner: Ethan Lin · Renewal: none (pay as you go) · Open opportunity: no",
      "      *Agent:* Expand · confidence 0.80",
      "         – Weekly spend up 3x ($1.00k to $3.40k)",
      "         – No open opportunity",
      "         Next step: Call them this week.",
      "      *Email:* Room to grow",
      "> Hi Pat,",
      "> Usage tripled.",
    ]);
    expect(lines[start + 10]).toBe("      _Draft: GLM 5.3 Flash on Baseten_");
  });

  it("flags an agent play that overrides the rules' play, and only then", () => {
    const lines = text.split("\n");
    expect(lines).toContain("      *Agent:* Ignore · confidence 0.80 · overrides the rules' expand");
    expect(lines.filter((l) => l.includes("overrides the rules'"))).toHaveLength(1);
  });

  it("says so when the agent ignores, has no draft, fails or times out", () => {
    expect(text).toContain("      *Agent:* Ignore · confidence 0.80");
    expect(text).toContain("      *Email:* no draft (both models failed)");
    expect(text).toContain("      *Agent:* failed (Salesforce 503); the rule lines above still stand.");
    expect(text).toContain("      *Agent:* no answer within 30 minutes; the rule lines above still stand.");
    // Every top account still shows its rule line.
    expect(text.match(/• Usage jump:/g)).toHaveLength(5);
  });
});
