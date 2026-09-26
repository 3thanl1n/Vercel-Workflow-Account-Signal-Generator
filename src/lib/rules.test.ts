import { describe, expect, it } from "vitest";
import { commitPace, errorSpike, newModels, rankAccounts, usageDrop, usageJump, type CrmAccount } from "./rules";
import type { UsageSummary } from "./usage-summary";

function usage(overrides: Partial<{ now: number; before: number; nowRate: number; beforeRate: number }> & { key?: string; newModels?: UsageSummary["newModels"] } = {}): UsageSummary {
  const { now = 5_000, before = 5_000, nowRate = 0.005, beforeRate = 0.005 } = overrides;
  return {
    accountKey: overrides.key ?? "acct_test",
    thisWeek: { spend: now, requests: 10_000, errors: Math.round(10_000 * nowRate) },
    lastWeek: { spend: before, requests: 10_000, errors: Math.round(10_000 * beforeRate) },
    newModels: overrides.newModels ?? [],
  };
}

function crm(overrides: Partial<CrmAccount> = {}): CrmAccount {
  return {
    accountKey: "acct_test",
    salesforceId: "001TEST",
    name: "Test Co",
    ownerName: "Owner",
    plan: "Pay as you go",
    committedSpend: null,
    renewalDate: null,
    hasOpenOpportunity: false,
    ...overrides,
  };
}

describe("usage jump", () => {
  it("fires at 1.5x with at least $1,000 this week, worth the weekly increase x 52", () => {
    expect(usageJump(usage({ now: 1_500, before: 1_000 }))).toMatchObject({ play: "expand", dollarsPerYear: 26_000 });
    expect(usageJump(usage({ now: 1_490, before: 1_000 }))).toBeNull();
    expect(usageJump(usage({ now: 999, before: 300 }))).toBeNull();
  });
});

describe("usage drop", () => {
  it("fires at 0.7x when last week was at least $1,000, worth the weekly decrease x 52", () => {
    expect(usageDrop(usage({ now: 700, before: 1_000 }))).toMatchObject({ play: "save", dollarsPerYear: 15_600 });
    expect(usageDrop(usage({ now: 710, before: 1_000 }))).toBeNull();
    expect(usageDrop(usage({ now: 100, before: 999 }))).toBeNull();
  });
});

describe("commit pace", () => {
  it("fires for committed accounts whose annualized week is at least 1.2x the commit, worth the overage", () => {
    const committed = crm({ plan: "Committed", committedSpend: 520_000 });
    expect(commitPace(usage({ now: 12_000 }), committed)).toMatchObject({ play: "expand", dollarsPerYear: 104_000 });
    expect(commitPace(usage({ now: 11_900 }), committed)).toBeNull();
    expect(commitPace(usage({ now: 12_000 }), crm({ plan: "Pay as you go", committedSpend: 520_000 }))).toBeNull();
  });
});

describe("new model", () => {
  it("fires for a new model with at least $500 this week, worth that spend x 52", () => {
    expect(newModels(usage({ newModels: [{ model: "flux-1-dev", spendThisWeek: 500 }] }))).toMatchObject([
      { play: "new_use_case", dollarsPerYear: 26_000 },
    ]);
    expect(newModels(usage({ newModels: [{ model: "flux-1-dev", spendThisWeek: 499.99 }] }))).toEqual([]);
  });
});

describe("error spike", () => {
  it("fires when the error rate at least doubles and reaches 2%, and carries no dollar value", () => {
    expect(errorSpike(usage({ nowRate: 0.02, beforeRate: 0.01 }))).toMatchObject({ play: null, dollarsPerYear: null });
    expect(errorSpike(usage({ nowRate: 0.015, beforeRate: 0.005 }))).toBeNull();
    expect(errorSpike(usage({ nowRate: 0.03, beforeRate: 0.02 }))).toBeNull();
  });
});

describe("ranking", () => {
  it("uses the largest dollar signal as priority, not the sum", () => {
    const { ranked } = rankAccounts(
      [crm({ plan: "Committed", committedSpend: 520_000 })],
      [usage({ now: 12_000, before: 8_000 })],
    );
    // usage jump = 4,000 x 52 = 208,000; commit pace = 624,000 - 520,000 = 104,000
    expect(ranked[0]).toMatchObject({ priority: 208_000, play: "expand" });
    expect(ranked[0].signals.map((s) => s.kind)).toEqual(["usage_jump", "commit_pace"]);
  });

  it("sorts by priority, breaks ties by sooner renewal then no open opportunity, and keeps the top 5", () => {
    const jump = (key: string, now: number) => usage({ key, now, before: 1_000 });
    const accounts = [
      crm({ accountKey: "a_small", name: "Small" }),
      crm({ accountKey: "b_tie_late", name: "Tie late", renewalDate: "2027-06-01" }),
      crm({ accountKey: "c_tie_soon", name: "Tie soon", renewalDate: "2026-12-01" }),
      crm({ accountKey: "d_tie_none", name: "Tie no renewal" }),
      crm({ accountKey: "e_tie_opp", name: "Tie with opp", hasOpenOpportunity: true }),
      crm({ accountKey: "f_big", name: "Big" }),
      crm({ accountKey: "g_errors_only", name: "Errors only" }),
      crm({ accountKey: "h_no_usage", name: "No usage rows" }),
    ];
    const summaries = [
      jump("a_small", 1_600),
      jump("b_tie_late", 3_000),
      jump("c_tie_soon", 3_000),
      jump("d_tie_none", 3_000),
      jump("e_tie_opp", 3_000),
      jump("f_big", 9_000),
      usage({ key: "g_errors_only", nowRate: 0.05, beforeRate: 0.005 }),
    ];

    const result = rankAccounts(accounts, summaries);

    expect(result.checked).toBe(7);
    expect(result.ranked.map((r) => r.accountKey)).toEqual([
      "f_big",
      "c_tie_soon",
      "b_tie_late",
      "d_tie_none",
      "e_tie_opp",
      "a_small",
    ]);
    expect(result.top.map((r) => r.accountKey)).toEqual(["f_big", "c_tie_soon", "b_tie_late", "d_tie_none", "e_tie_opp"]);
    expect(result.watch.map((w) => w.accountKey)).toEqual(["g_errors_only"]);
  });
});
