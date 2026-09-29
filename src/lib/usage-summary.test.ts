import { describe, expect, it } from "vitest";
import { summarizeUsage, type UsageRowLike } from "./usage-summary";

const DAY = "2026-09-26";

function row(day: string, model: string, spendUsd: number): UsageRowLike {
  return { accountKey: "acct_test", day, model, requests: 100, errors: 1, spendUsd };
}

describe("summarizeUsage", () => {
  it("splits this week (last 7 days), last week (the 7 before) and the 21-day new-model window", () => {
    const [summary] = summarizeUsage(
      [
        row("2026-09-26", "a", 1), // this week (today)
        row("2026-09-20", "a", 2), // this week (6 days ago)
        row("2026-09-19", "a", 4), // last week (7 days ago)
        row("2026-09-13", "a", 8), // last week (13 days ago)
        row("2026-09-12", "a", 16), // new-model window only
        row("2026-08-29", "a", 32), // new-model window only (27 days ago)
        row("2026-08-28", "old", 64), // outside every window
        row("2026-09-27", "a", 128), // after the run day
        row("2026-09-23", "fresh", 10), // new this week
        row("2026-09-24", "returning", 5), // used this week...
        row("2026-09-05", "returning", 5), // ...and in the window before, so not new
        row("2026-09-25", "old", 20), // last seen outside the window, so new again
      ],
      DAY,
    );

    expect(summary.thisWeek).toEqual({ spend: 1 + 2 + 10 + 5 + 20, requests: 500, errors: 5 });
    expect(summary.lastWeek).toEqual({ spend: 4 + 8, requests: 200, errors: 2 });
    expect(summary.newModels).toEqual([
      { model: "fresh", spendThisWeek: 10 },
      { model: "old", spendThisWeek: 20 },
    ]);
  });

  it("adds up spend for each of the last 4 weeks, oldest first", () => {
    const [summary] = summarizeUsage(
      [
        row("2026-09-26", "a", 100), // this week (today)
        row("2026-09-20", "b", 50), // this week (6 days ago)
        row("2026-09-19", "a", 40), // last week (7 days ago)
        row("2026-09-12", "a", 30), // 2 weeks back (14 days ago)
        row("2026-09-06", "a", 5), // 2 weeks back (20 days ago)
        row("2026-09-05", "a", 20), // 3 weeks back (21 days ago)
        row("2026-08-30", "a", 10), // 3 weeks back (27 days ago, the first day read)
        row("2026-08-29", "a", 999), // outside the 28 days
        row("2026-09-27", "a", 999), // after the run day
      ],
      DAY,
    );

    expect(summary.weeklySpend).toEqual([30, 35, 40, 150]);
    // The last two weeks are the rules' last week and this week.
    expect(summary.weeklySpend.slice(2)).toEqual([summary.lastWeek.spend, summary.thisWeek.spend]);
  });
});
