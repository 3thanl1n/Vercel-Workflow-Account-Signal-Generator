import { ACCOUNTS, MODELS, MODEL_IDS, type ModelId, type SeedAccount } from "@/data/accounts";
import { addDays, daysBetween, isWeekend } from "@/lib/dates";

// Dummy usage data. Every value is a pure function of (account, day, model), so
// regenerating a day always produces identical rows: safe to backfill and retry.

export type UsageRow = {
  accountKey: string;
  day: string;
  model: ModelId;
  requests: number;
  gpuHours: number;
  errors: number;
  p95LatencyMs: number;
  spendUsd: number;
};

export type StoryType = "commit_burn" | "payg_surge" | "churn_after_errors" | "new_model";

export type Episode = { type: StoryType; accountKey: string; startDay: string; model?: ModelId };

// A new story starts every 2 days, cycling through the four types.
const STORY_ORIGIN = "2026-07-01";
const STORY_EVERY_DAYS = 2;
const STORY_CYCLE: StoryType[] = ["commit_burn", "churn_after_errors", "new_model", "payg_surge"];
// An account stays busy for its whole story plus a quiet stretch, so stories never overlap.
const BUSY_DAYS = 40;
// Stories ease back to normal slowly; a sudden return would itself look like a 40% drop.
const RAMP_OUT_DAYS = 21;
const RECOVERY_DAYS = 18;
const NEW_MODEL_SETTLE_DAYS = 14;

function eligible(type: StoryType, account: SeedAccount): boolean {
  switch (type) {
    case "commit_burn":
      return account.plan === "Committed";
    case "payg_surge":
      return account.plan === "Pay as you go";
    case "new_model":
      return account.plan === "Pay as you go" && !account.openOpportunity;
    case "churn_after_errors":
      return true;
  }
}

/** Every story that has started on or before `throughDay`, oldest first. */
export function storyEpisodes(throughDay: string): Episode[] {
  const episodes: Episode[] = [];
  const slots = Math.floor(daysBetween(STORY_ORIGIN, throughDay) / STORY_EVERY_DAYS);

  for (let slot = 0; slot <= slots; slot++) {
    const startDay = addDays(STORY_ORIGIN, slot * STORY_EVERY_DAYS);
    const type = STORY_CYCLE[slot % STORY_CYCLE.length];
    const busy = (key: string) =>
      episodes.some((e) => e.accountKey === key && daysBetween(e.startDay, startDay) < BUSY_DAYS);
    const account = ACCOUNTS.filter((a) => eligible(type, a) && !busy(a.key)).sort(
      (a, b) => hash(`${startDay}|${a.key}`) - hash(`${startDay}|${b.key}`),
    )[0];
    if (!account) continue;

    const episode: Episode = { type, accountKey: account.key, startDay };
    if (type === "new_model") {
      const used = new Set<string>([
        ...Object.keys(account.mix),
        ...episodes.filter((e) => e.accountKey === account.key && e.model).map((e) => e.model!),
      ]);
      const options = MODEL_IDS.filter((m) => !used.has(m));
      if (options.length === 0) continue;
      episode.model = options[hash(`${startDay}|${account.key}|model`) % options.length];
    }
    episodes.push(episode);
  }
  return episodes;
}

type Effect = { spend: number; errors: number; latency: number; newModelShare: number };

/** 0 before the story, rises to 1 over 3 days, holds until day 12, then falls back to 0. */
function bump(k: number, rampOutDays: number): number {
  if (k < 0) return 0;
  if (k < 3) return (k + 1) / 3;
  if (k < 12) return 1;
  return Math.max(0, 1 - (k - 11) / rampOutDays);
}

/** How a story changes an account's usage `k` days after it starts. */
export function storyEffect(type: StoryType, k: number): Effect {
  const none: Effect = { spend: 1, errors: 1, latency: 1, newModelShare: 0 };
  if (k < 0) return none;
  switch (type) {
    case "commit_burn": // Committed account burning through its commit well before renewal.
      return { ...none, spend: 1 + 0.7 * bump(k, RAMP_OUT_DAYS) };
    case "payg_surge": // Pay-as-you-go account doubling its spend.
      return { ...none, spend: 1 + 1.0 * bump(k, RAMP_OUT_DAYS) };
    case "churn_after_errors": // Four days of errors and slow responses, then traffic drops ~45%.
      if (k < 4) return { spend: 1, errors: 20, latency: 2.5, newModelShare: 0 };
      if (k < 14) return { spend: 0.55, errors: 1.5, latency: 1, newModelShare: 0 };
      return { ...none, spend: Math.min(1, 0.55 + (0.45 * (k - 13)) / RECOVERY_DAYS) };
    case "new_model": // A new model goes live at 2x the account's usual spend (traffic triples), then settles at 1x.
      if (k < 12) return { ...none, newModelShare: 2 * bump(k, 1) };
      return { ...none, newModelShare: Math.max(1, 2 - (k - 11) / NEW_MODEL_SETTLE_DAYS) };
  }
}

/** Usage rows for every account on every day from `fromDay` to `toDay`, inclusive. */
export function generateUsage(fromDay: string, toDay: string): UsageRow[] {
  const episodes = storyEpisodes(toDay);
  const rows: UsageRow[] = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    for (const account of ACCOUNTS) rows.push(...accountDay(account, day, episodes));
  }
  return rows;
}

function accountDay(account: SeedAccount, day: string, episodes: Episode[]): UsageRow[] {
  let spendMult = 1;
  let errorMult = 1;
  let latencyMult = 1;
  const shares: Partial<Record<ModelId, number>> = { ...account.mix };

  for (const episode of episodes) {
    if (episode.accountKey !== account.key) continue;
    const effect = storyEffect(episode.type, daysBetween(episode.startDay, day));
    spendMult *= effect.spend;
    errorMult *= effect.errors;
    latencyMult *= effect.latency;
    if (episode.model && effect.newModelShare > 0) {
      shares[episode.model] = (shares[episode.model] ?? 0) + effect.newModelShare;
    }
  }

  const base = account.dailySpend * (isWeekend(day) ? 0.8 : 1);
  const rows: UsageRow[] = [];
  for (const [model, share] of Object.entries(shares) as [ModelId, number][]) {
    const profile = MODELS[model];
    const seed = `${account.key}|${day}|${model}`;
    const spend = base * share * spendMult * jitter(`${seed}|spend`, 0.08);
    if (spend < 1) continue;
    const requests = Math.round((spend / profile.usdPer1kRequests) * 1000);
    rows.push({
      accountKey: account.key,
      day,
      model,
      requests,
      gpuHours: round2(spend / profile.usdPerGpuHour),
      errors: Math.round(requests * profile.errorRate * errorMult * jitter(`${seed}|errors`, 0.3)),
      p95LatencyMs: Math.round(profile.p95LatencyMs * latencyMult * jitter(`${seed}|latency`, 0.1)),
      spendUsd: round2(spend),
    });
  }
  return rows;
}

/** FNV-1a with a final avalanche, as an unsigned 32-bit integer. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A deterministic multiplier in [1 - spread, 1 + spread]. */
function jitter(seed: string, spread: number): number {
  return 1 - spread + (2 * spread * hash(seed)) / 2 ** 32;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
