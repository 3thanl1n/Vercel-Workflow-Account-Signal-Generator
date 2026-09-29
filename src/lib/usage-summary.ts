import { addDays, daysBetween } from "@/lib/dates";

// Turns raw daily rows into the per-account numbers the rules need. The
// workflow step returns these summaries, never the raw rows, so step results stay small.

export type UsageRowLike = { accountKey: string; day: string; model: string; requests: number; errors: number; spendUsd: number };

export type WeekTotals = { spend: number; requests: number; errors: number };

export type UsageSummary = {
  accountKey: string;
  thisWeek: WeekTotals;
  lastWeek: WeekTotals;
  /** Spend in each of the last 4 weeks, oldest first; the last one is this week. */
  weeklySpend: number[];
  /** Models used this week with no usage in the 21 days before this week. */
  newModels: { model: string; spendThisWeek: number }[];
};

/** Days of history the summary reads: this week, last week, and the 21 days before this week. */
export const SUMMARY_LOOKBACK_DAYS = 28;

export function summarizeUsage(rows: UsageRowLike[], day: string): UsageSummary[] {
  const thisWeekStart = addDays(day, -6);
  const lastWeekStart = addDays(day, -13);
  const priorStart = addDays(day, -(SUMMARY_LOOKBACK_DAYS - 1));

  const byAccount = new Map<string, { summary: UsageSummary; thisWeekModels: Map<string, number>; priorModels: Set<string> }>();

  for (const row of rows) {
    if (row.day > day || row.day < priorStart) continue;
    let entry = byAccount.get(row.accountKey);
    if (!entry) {
      entry = {
        summary: { accountKey: row.accountKey, thisWeek: emptyWeek(), lastWeek: emptyWeek(), weeklySpend: [0, 0, 0, 0], newModels: [] },
        thisWeekModels: new Map(),
        priorModels: new Set(),
      };
      byAccount.set(row.accountKey, entry);
    }
    entry.summary.weeklySpend[3 - Math.floor(daysBetween(row.day, day) / 7)] += row.spendUsd;

    if (row.day >= thisWeekStart) {
      addTo(entry.summary.thisWeek, row);
      entry.thisWeekModels.set(row.model, (entry.thisWeekModels.get(row.model) ?? 0) + row.spendUsd);
    } else {
      entry.priorModels.add(row.model);
      if (row.day >= lastWeekStart) addTo(entry.summary.lastWeek, row);
    }
  }

  return [...byAccount.values()].map(({ summary, thisWeekModels, priorModels }) => ({
    ...summary,
    thisWeek: roundWeek(summary.thisWeek),
    lastWeek: roundWeek(summary.lastWeek),
    weeklySpend: summary.weeklySpend.map(cents),
    newModels: [...thisWeekModels]
      .filter(([model]) => !priorModels.has(model))
      .map(([model, spend]) => ({ model, spendThisWeek: cents(spend) })),
  }));
}

function emptyWeek(): WeekTotals {
  return { spend: 0, requests: 0, errors: 0 };
}

function addTo(week: WeekTotals, row: UsageRowLike) {
  week.spend += row.spendUsd;
  week.requests += row.requests;
  week.errors += row.errors;
}

function roundWeek(week: WeekTotals): WeekTotals {
  return { ...week, spend: cents(week.spend) };
}

function cents(amount: number): number {
  return Math.round(amount * 100) / 100;
}
