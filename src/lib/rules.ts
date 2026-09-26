import type { UsageSummary } from "@/lib/usage-summary";

// Rule-based triage from HANDOFF.md section 5. No weights, no ML, no AI: each rule
// is an if-then check, and every ranked signal is expressed as dollars per year at stake.
// The thresholds are starting guesses; there is no real history to tune them against.

export type Play = "expand" | "save" | "new_use_case";

export type SignalKind = "usage_jump" | "usage_drop" | "commit_pace" | "new_model" | "error_spike";

export type Signal = {
  kind: SignalKind;
  /** null for context-only signals (error spike) that aren't ranked. */
  play: Play | null;
  dollarsPerYear: number | null;
  detail: string;
};

export type CrmAccount = {
  accountKey: string;
  salesforceId: string;
  name: string;
  ownerName: string | null;
  plan: "Pay as you go" | "Committed" | null;
  committedSpend: number | null;
  renewalDate: string | null;
  hasOpenOpportunity: boolean;
};

export type RankedAccount = {
  accountKey: string;
  name: string;
  ownerName: string | null;
  priority: number;
  play: Play;
  renewalDate: string | null;
  hasOpenOpportunity: boolean;
  signals: Signal[];
};

export type Ranking = {
  checked: number;
  /** Every account with at least one dollar signal, highest priority first. */
  ranked: RankedAccount[];
  top: RankedAccount[];
  /** Accounts with only context signals (error spikes): logged, not ranked. */
  watch: { accountKey: string; name: string; signals: Signal[] }[];
};

const WEEKS_PER_YEAR = 52;
export const TOP_N = 5;

export function usageJump(u: UsageSummary): Signal | null {
  const now = u.thisWeek.spend;
  const before = u.lastWeek.spend;
  if (now < 1.5 * before || now < 1_000) return null;
  return {
    kind: "usage_jump",
    play: "expand",
    dollarsPerYear: (now - before) * WEEKS_PER_YEAR,
    detail: `Weekly spend ${usd(before)} to ${usd(now)} (${ratio(now, before)})`,
  };
}

export function usageDrop(u: UsageSummary): Signal | null {
  const now = u.thisWeek.spend;
  const before = u.lastWeek.spend;
  if (now > 0.7 * before || before < 1_000) return null;
  return {
    kind: "usage_drop",
    play: "save",
    dollarsPerYear: (before - now) * WEEKS_PER_YEAR,
    detail: `Weekly spend ${usd(before)} to ${usd(now)} (${ratio(now, before)})`,
  };
}

export function commitPace(u: UsageSummary, crm: CrmAccount): Signal | null {
  if (crm.plan !== "Committed" || !crm.committedSpend) return null;
  const annualized = u.thisWeek.spend * WEEKS_PER_YEAR;
  if (annualized < 1.2 * crm.committedSpend) return null;
  return {
    kind: "commit_pace",
    play: "expand",
    dollarsPerYear: annualized - crm.committedSpend,
    detail: `On pace for ${usd(annualized)}/yr against a ${usd(crm.committedSpend)} commit${crm.renewalDate ? `, renews ${crm.renewalDate}` : ""}`,
  };
}

export function newModels(u: UsageSummary): Signal[] {
  return u.newModels
    .filter((m) => m.spendThisWeek >= 500)
    .map((m) => ({
      kind: "new_model" as const,
      play: "new_use_case" as const,
      dollarsPerYear: m.spendThisWeek * WEEKS_PER_YEAR,
      detail: `New model ${m.model}: ${usd(m.spendThisWeek)} this week, unused in the 21 days before`,
    }));
}

export function errorSpike(u: UsageSummary): Signal | null {
  const now = rate(u.thisWeek.errors, u.thisWeek.requests);
  const before = rate(u.lastWeek.errors, u.lastWeek.requests);
  if (now < 2 * before || now < 0.02) return null;
  return {
    kind: "error_spike",
    play: null,
    dollarsPerYear: null,
    detail: `Error rate ${pct(before)} to ${pct(now)} week over week`,
  };
}

export function checkAccount(u: UsageSummary, crm: CrmAccount): Signal[] {
  return [usageJump(u), usageDrop(u), commitPace(u, crm), ...newModels(u), errorSpike(u)].filter(
    (s): s is Signal => s !== null,
  );
}

/**
 * Priority is an account's single largest dollar value, not the sum, because a usage
 * jump and commit pace often describe the same growth. Ties go to the sooner renewal,
 * then to accounts with no open opportunity, then alphabetically so order is stable.
 */
export function rankAccounts(accounts: CrmAccount[], usage: UsageSummary[]): Ranking {
  const usageByKey = new Map(usage.map((u) => [u.accountKey, u]));
  const ranked: RankedAccount[] = [];
  const watch: Ranking["watch"] = [];
  let checked = 0;

  for (const crm of accounts) {
    const u = usageByKey.get(crm.accountKey);
    if (!u) continue;
    checked++;
    const signals = checkAccount(u, crm);
    const best = signals
      .filter((s) => s.dollarsPerYear !== null)
      .sort((a, b) => b.dollarsPerYear! - a.dollarsPerYear!)[0];
    if (best) {
      ranked.push({
        accountKey: crm.accountKey,
        name: crm.name,
        ownerName: crm.ownerName,
        priority: Math.round(best.dollarsPerYear!),
        play: best.play!,
        renewalDate: crm.renewalDate,
        hasOpenOpportunity: crm.hasOpenOpportunity,
        signals,
      });
    } else if (signals.length > 0) {
      watch.push({ accountKey: crm.accountKey, name: crm.name, signals });
    }
  }

  ranked.sort(
    (a, b) =>
      b.priority - a.priority ||
      compareRenewal(a.renewalDate, b.renewalDate) ||
      Number(a.hasOpenOpportunity) - Number(b.hasOpenOpportunity) ||
      a.accountKey.localeCompare(b.accountKey),
  );

  return { checked, ranked, top: ranked.slice(0, TOP_N), watch };
}

/** Sooner renewal first; accounts with no renewal date go last. */
function compareRenewal(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function rate(errors: number, requests: number): number {
  return requests > 0 ? errors / requests : 0;
}

export function usd(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

function ratio(now: number, before: number): string {
  return before > 0 ? `${(now / before).toFixed(2)}x` : "new";
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
