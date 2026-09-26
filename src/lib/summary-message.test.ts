import { describe, expect, it } from "vitest";
import { rankAccounts, type CrmAccount } from "./rules";
import { formatSummary } from "./summary-message";
import type { UsageSummary } from "./usage-summary";

function usage(key: string, now: number, before: number, errorRate = 0.005): UsageSummary {
  return {
    accountKey: key,
    thisWeek: { spend: now, requests: 10_000, errors: Math.round(10_000 * errorRate) },
    lastWeek: { spend: before, requests: 10_000, errors: 50 },
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
