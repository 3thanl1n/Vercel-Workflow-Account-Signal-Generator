import { defineHook } from "workflow";
import { z } from "zod";
import { getSql } from "@/lib/db";
import type { EmailDraft } from "@/lib/email-draft";
import { money } from "@/lib/rules";

/** What the agent records for one account. Validated before it's saved. */
export const DecisionSchema = z.object({
  play: z.enum(["expand", "save", "new_use_case", "ignore"]),
  yearlyPaceUsd: z
    .number()
    .nonnegative()
    .describe("The account's total yearly spend at its current pace, across all models, in USD. Not the change and not the amount at stake."),
  confidence: z.number().min(0).max(1),
  why: z.array(z.string().min(1).max(300)).min(2).max(4),
  nextStep: z.string().min(1).max(400),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** The two yearly figures code computes from the last 4 weekly spends (oldest first). */
export type PaceFacts = { thisWeekYearly: number; fourWeekYearly: number };

export function paceFacts(weeklySpend: number[]): PaceFacts {
  const thisWeek = weeklySpend.at(-1) ?? 0;
  const average = weeklySpend.reduce((sum, week) => sum + week, 0) / Math.max(weeklySpend.length, 1);
  return { thisWeekYearly: thisWeek * 52, fourWeekYearly: average * 52 };
}

/** How far the agent's yearly figure may sit from code's figures before the decision is rejected. */
export const PACE_TOLERANCE = 3;

/**
 * Checks the agent's yearly figure against code's. It passes when it's within 3x of either
 * figure: two figures, so an honest reading of a one-off spike (well under this week × 52)
 * still passes. Returns the message sent back to the agent, or null when it passes.
 */
export function checkYearlyPace(yearlyPaceUsd: number, facts: PaceFacts): string | null {
  const near = (figure: number) => yearlyPaceUsd >= figure / PACE_TOLERANCE && yearlyPaceUsd <= figure * PACE_TOLERANCE;
  if (near(facts.thisWeekYearly) || near(facts.fourWeekYearly)) return null;
  return (
    `Rejected, nothing saved: yearlyPaceUsd ${money(yearlyPaceUsd).text} is more than ${PACE_TOLERANCE}x away from both figures code computed: ` +
    `this week × 52 = ${money(facts.thisWeekYearly).text}/yr and the 4-week average × 52 = ${money(facts.fourWeekYearly).text}/yr. ` +
    "yearlyPaceUsd is the account's total yearly spend at its current pace, across all models (not the change). " +
    "Correct it and any why bullet built on it, then call recordDecision again."
  );
}

const UsageSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
});
export type ModelUsage = z.infer<typeof UsageSchema>;

type StepUsage = {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  };
};

/**
 * Adds up the agent's model calls one by one. The agent's own total (`totalUsage`) keeps
 * only input and output tokens and drops the cache split, which would price every cached
 * token at the full input rate.
 */
export function sumStepUsage(model: string, steps: readonly StepUsage[]): ModelUsage {
  const total = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const { usage } of steps) {
    total.inputTokens += usage?.inputTokens ?? 0;
    total.outputTokens += usage?.outputTokens ?? 0;
    total.cacheReadTokens += usage?.inputTokenDetails?.cacheReadTokens ?? 0;
    total.cacheWriteTokens += usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  }
  return total;
}

/** What each child run sends back to the daily run. */
export const AccountReportSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("decided"),
    decision: DecisionSchema,
    email: z.object({ subject: z.string(), body: z.string(), model: z.string() }).nullable(),
    agentUsage: UsageSchema,
    emailUsage: UsageSchema.nullable(),
  }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);
export type AccountReport = z.infer<typeof AccountReportSchema>;

/** A report, or "timed_out" when the child didn't answer before the daily run moved on. */
export type AccountTake = AccountReport | { status: "timed_out" };

/** The daily run waits on one of these per account; the child resumes it when done. */
export const decisionReady = defineHook({ schema: AccountReportSchema });

/** Keyed by run ID so two runs on the same day can't collide. */
export function decisionToken(runId: string, accountKey: string): string {
  return `decision:${runId}:${accountKey}`;
}

/** Every top account gets a take: its report, or "timed_out" if none arrived. */
export function collectTakes(accountKeys: string[], received: Record<string, AccountReport>): Record<string, AccountTake> {
  return Object.fromEntries(accountKeys.map((key) => [key, received[key] ?? { status: "timed_out" as const }]));
}

// Writes are keyed by (account_key, day), so a retried step updates the same row.

export async function saveDecision(runId: string, day: string, accountKey: string, decision: Decision) {
  const sql = getSql();
  await sql`
    insert into decisions (run_id, day, account_key, play, confidence, why, next_step)
    values (${runId}, ${day}::date, ${accountKey}, ${decision.play}, ${decision.confidence},
            ${JSON.stringify(decision.why)}::jsonb, ${decision.nextStep})
    on conflict (account_key, day) do update set
      run_id = excluded.run_id, play = excluded.play, confidence = excluded.confidence,
      why = excluded.why, next_step = excluded.next_step,
      email_subject = null, email_body = null, email_model = null,
      email_input_tokens = null, email_output_tokens = null,
      status = 'pending', updated_at = now()`;
}

export async function saveAgentUsage(day: string, accountKey: string, usage: ModelUsage) {
  const sql = getSql();
  await sql`
    update decisions set
      agent_model = ${usage.model}, agent_input_tokens = ${usage.inputTokens},
      agent_output_tokens = ${usage.outputTokens},
      agent_cache_read_tokens = ${usage.cacheReadTokens ?? 0},
      agent_cache_write_tokens = ${usage.cacheWriteTokens ?? 0},
      updated_at = now()
    where account_key = ${accountKey} and day = ${day}::date`;
}

export async function saveEmailDraft(day: string, accountKey: string, draft: EmailDraft) {
  const sql = getSql();
  await sql`
    update decisions set
      email_subject = ${draft.subject}, email_body = ${draft.body}, email_model = ${draft.model},
      email_input_tokens = ${draft.inputTokens}, email_output_tokens = ${draft.outputTokens},
      updated_at = now()
    where account_key = ${accountKey} and day = ${day}::date`;
}
