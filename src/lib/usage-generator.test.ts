import { describe, expect, it } from "vitest";
import { ACCOUNTS, committedSpend } from "@/data/accounts";
import { addDays, daysBetween } from "./dates";
import { rankAccounts, type CrmAccount, type SignalKind } from "./rules";
import { generateUsage, storyEpisodes, type StoryType } from "./usage-generator";
import { SUMMARY_LOOKBACK_DAYS, summarizeUsage } from "./usage-summary";

const FIRST_DAY = "2026-09-01";
const LAST_DAY = "2026-11-30";

const crmAccounts: CrmAccount[] = ACCOUNTS.map((a) => ({
  accountKey: a.key,
  salesforceId: a.key,
  name: a.name,
  ownerName: null,
  plan: a.plan,
  committedSpend: committedSpend(a),
  renewalDate: a.renewalDate ?? null,
  hasOpenOpportunity: Boolean(a.openOpportunity),
}));

const EXPECTED: Record<StoryType, SignalKind[]> = {
  commit_burn: ["commit_pace"],
  payg_surge: ["usage_jump"],
  churn_after_errors: ["error_spike", "usage_drop"],
  new_model: ["new_model"],
};

describe("usage generator", () => {
  it("is deterministic, so regenerating a day is safe to retry", () => {
    expect(generateUsage("2026-09-20", "2026-09-26")).toEqual(generateUsage("2026-09-20", "2026-09-26"));
  });

  it("fires every planted story's rule, and never flags an account outside a story", () => {
    const rows = generateUsage(addDays(FIRST_DAY, -SUMMARY_LOOKBACK_DAYS), LAST_DAY);
    const episodes = storyEpisodes(LAST_DAY);
    const seen = new Map<StoryType, Set<SignalKind>>();

    for (let day = FIRST_DAY; day <= LAST_DAY; day = addDays(day, 1)) {
      const { ranked, watch } = rankAccounts(crmAccounts, summarizeUsage(rows, day));
      for (const flagged of [...ranked, ...watch]) {
        // The account's most recent story that started within the last 40 days.
        const story = episodes
          .filter((e) => e.accountKey === flagged.accountKey && e.startDay <= day && daysBetween(e.startDay, day) < 40)
          .at(-1);
        expect(story, `${flagged.accountKey} flagged on ${day} without a story`).toBeDefined();
        const kinds = seen.get(story!.type) ?? new Set();
        flagged.signals.forEach((s) => kinds.add(s.kind));
        seen.set(story!.type, kinds);
      }
    }

    for (const [type, kinds] of Object.entries(EXPECTED) as [StoryType, SignalKind[]][]) {
      for (const kind of kinds) expect(seen.get(type)?.has(kind), `${type} should fire ${kind}`).toBe(true);
    }
  });
});
