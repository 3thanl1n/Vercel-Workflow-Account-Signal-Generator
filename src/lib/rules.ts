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
    detail:
      `Usage jump: ${money(before).text} → ${money(now).text} a week ` +
      `(${ratio(now, before, money(now).value, money(before).value)}; fires at 1.5x+ with $1k+ this week) → ` +
      `${weeklyChange("+", before, now)} × 52 ${yearly(now - before)}/yr`,
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
    detail:
      `Usage drop: ${money(before).text} → ${money(now).text} a week ` +
      `(${ratio(now, before, money(now).value, money(before).value)}; fires at 0.7x or less with $1k+ last week) → ` +
      `${weeklyChange("−", now, before)} × 52 ${yearly(before - now)}/yr at risk`,
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
    detail:
      `Commit pace: ${money(u.thisWeek.spend).text}/wk × 52 ${yearly(u.thisWeek.spend, annualized)}/yr ` +
      `vs a ${money(crm.committedSpend).text} commit ` +
      `(${ratio(annualized, crm.committedSpend, money(annualized).value, money(crm.committedSpend).value)}; fires at 1.2x+) → ` +
      `${difference(annualized, crm.committedSpend)}/yr over commit`,
  };
}

export function newModels(u: UsageSummary): Signal[] {
  return u.newModels
    .filter((m) => m.spendThisWeek >= 500)
    .map((m) => ({
      kind: "new_model" as const,
      play: "new_use_case" as const,
      dollarsPerYear: m.spendThisWeek * WEEKS_PER_YEAR,
      detail:
        `New model: ${m.model}, ${money(m.spendThisWeek).text} this week, unused the 21 days before ` +
        `(fires at $500+) → × 52 ${yearly(m.spendThisWeek)}/yr`,
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
    detail:
      `Error spike: ${percent(before).text} → ${percent(now).text} of requests failed ` +
      `(${ratio(now, before, percent(now).value, percent(before).value)}; fires at 2x+ and 2%+) · context only, no $ value`,
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

// Display helpers. Each line should let a reader redo the math from the numbers shown,
// so every rounded number carries the value a reader would take from it, and a step
// uses "≈" instead of "=" (or a leading "≈") when the shown numbers don't work out exactly.

type Shown = { text: string; value: number };

/** Dollars to 3 significant figures: $840, $7.00k, $23.6k, $645k, $1.91M. Always unsigned. */
export function money(amount: number): Shown {
  const abs = Math.abs(amount);
  if (abs >= 999_500) {
    const m = Math.round(abs / 10_000) / 100;
    return { text: `$${m.toFixed(2)}M`, value: m * 1_000_000 };
  }
  if (abs >= 99_950) {
    const k = Math.round(abs / 1_000);
    return { text: `$${k}k`, value: k * 1_000 };
  }
  if (abs >= 9_995) {
    const k = Math.round(abs / 100) / 10;
    return { text: `$${k.toFixed(1)}k`, value: k * 1_000 };
  }
  if (abs >= 999.5) {
    const k = Math.round(abs / 10) / 100;
    return { text: `$${k.toFixed(2)}k`, value: k * 1_000 };
  }
  return { text: `$${Math.round(abs)}`, value: Math.round(abs) };
}

/** A rate as a percentage with 2 decimals: 0.24%, 3.47%. */
function percent(rate: number): Shown {
  const p = Math.round(rate * 10_000) / 100;
  return { text: `${p.toFixed(2)}%`, value: p / 100 };
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/** "1.53x" from the real values; "≈" when dividing the shown values gives a different figure. */
function ratio(a: number, b: number, shownA: number, shownB: number): string {
  if (b <= 0) return "new";
  const digits = a / b >= 10 ? 1 : 2;
  const text = (a / b).toFixed(digits);
  return `${text === (shownA / shownB).toFixed(digits) ? "" : "≈"}${text}x`;
}

/** "+$12.4k/wk": the weekly change, "≈" first when it isn't the difference of the shown numbers. */
function weeklyChange(sign: "+" | "−", smaller: number, larger: number): string {
  const change = money(larger - smaller);
  const exact = same(money(larger).value - money(smaller).value, change.value);
  return `${exact ? "" : "≈"}${sign}${change.text}/wk`;
}

/** "= $104k" or "≈ $645k": a weekly amount times 52, compared with the shown weekly amount x 52. */
function yearly(weekly: number, annual = weekly * WEEKS_PER_YEAR): string {
  return `${same(money(weekly).value * WEEKS_PER_YEAR, money(annual).value) ? "=" : "≈"} ${money(annual).text}`;
}

/** "$1.91M" for a - b, with "≈" first when it isn't the difference of the shown numbers. */
function difference(a: number, b: number): string {
  const diff = money(a - b);
  return `${same(money(a).value - money(b).value, diff.value) ? "" : "≈"}${diff.text}`;
}
