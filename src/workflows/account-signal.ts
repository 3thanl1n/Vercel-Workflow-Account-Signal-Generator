import { WorkflowAgent } from "@ai-sdk/workflow";
import { isStepCount, tool } from "ai";
import { z } from "zod";
import { addDays } from "@/lib/dates";
import {
  type AccountReport,
  checkYearlyPace,
  type Decision,
  DecisionSchema,
  decisionReady,
  type ModelUsage,
  paceFacts,
  saveAgentUsage,
  saveDecision,
  saveEmailDraft,
  sumStepUsage,
} from "@/lib/decisions";
import { draftWithBaseten, draftWithClaude, type EmailDraft, type EmailDraftInput } from "@/lib/email-draft";
import { CLAUDE_MODEL } from "@/lib/models";
import { type AccountDetails, loadAccountDetails } from "@/lib/salesforce";
import { runPython } from "@/lib/sandbox";
import { loadAccountUsageCsv } from "@/lib/usage-store";
import { SUMMARY_LOOKBACK_DAYS } from "@/lib/usage-summary";

export type AccountSignalInput = {
  runId: string;
  day: string;
  decisionToken: string;
  account: {
    accountKey: string;
    name: string;
    play: string;
    priority: number;
    signals: string[];
    plan: string | null;
    committedSpend: number | null;
    /** The last 4 weeks, oldest first; the last one is this week. */
    weeklySpend: number[];
  };
};

// The constant part of the prompt comes first, so AI Gateway's automatic caching can reuse it.
const INSTRUCTIONS = `You're a revenue analyst at an AI inference company that sells model APIs billed by usage.
A rules engine flagged one account. Work out why its usage changed and what the account owner should do. Back every claim with numbers.

How to work:
1. The brief ends with facts computed by code: weekly spend, yearly pace, and pace against the commit. They're correct. Use these numbers as they are.
2. Call getAccount once for the CRM picture: plan, commit, renewal, contacts, open opportunities.
3. Call analyzeUsage with a short Python 3 script to find why usage changed (which models, which days, requests, errors), not to redo the yearly math. The file usage.csv has columns day, model, requests, gpu_hours, errors, p95_latency_ms, spend_usd: one row per model per day, 28 days, oldest first. Standard library only (csv, statistics, datetime); there is no network. Print only the few numbers you need. One or two calls is enough.
4. Call recordDecision once, then stop. If it's rejected, correct what the message names and call it again.

Yearly figures: take them from the facts. If you do convert, it's weekly × 52 or daily × 365.

Deciding:
- play: keep the suggested play, change it, or choose "ignore" if the numbers don't support acting.
- yearlyPaceUsd: the account's total yearly spend at its current pace, across all models (not the change). Code checks it against its own figures.
- why: 2 to 4 bullets, each one short sentence (under 25 words) with a number from the data.
- nextStep: one sentence (under 30 words) the account owner can act on this week.
- confidence: 0 to 1.
Be brief. Don't restate tool output, and don't write an email.`;

/**
 * One flagged account: the Claude agent investigates and records a decision, a
 * separate model drafts the email, then the child reports back to the daily run.
 * Any failure becomes a "failed" report, so the daily run never waits on a crash.
 */
export async function accountSignal(input: AccountSignalInput) {
  "use workflow";

  let report: AccountReport;
  try {
    report = await investigate(input);
  } catch (error) {
    report = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  await reportToDailyRun(input.decisionToken, report);
  return report;
}

async function investigate({ runId, day, account }: AccountSignalInput): Promise<AccountReport> {
  const { accountKey } = account;
  const facts = paceFacts(account.weeklySpend);
  let details: AccountDetails | undefined;
  let saved: Decision | undefined;

  const agent = new WorkflowAgent({
    model: CLAUDE_MODEL,
    instructions: INSTRUCTIONS,
    // 1,024 cut off a turn on 2026-09-29 (finishReason "length"), and a cut-off turn's tool calls never run.
    maxOutputTokens: 4096,
    // Every turn must call a tool, so the agent can't end with prose; it finishes by calling
    // recordDecision, and the stop condition below watches for a saved decision.
    toolChoice: "required",
    providerOptions: { gateway: { caching: "auto" } },
    tools: {
      getAccount: tool({
        description: "The account's Salesforce record: plan, commit, renewal, contacts and open opportunities. Read-only.",
        inputSchema: z.object({}),
        execute: async () => (details = await getAccountStep(accountKey)),
      }),
      analyzeUsage: tool({
        description:
          "Runs a Python 3 script (standard library only, no network) in an isolated sandbox with usage.csv in the working directory, and returns what it prints.",
        inputSchema: z.object({ code: z.string().max(8_000).describe("The Python 3 script") }),
        execute: ({ code }) => analyzeUsageStep(accountKey, day, code),
      }),
      recordDecision: tool({
        description:
          "Records your decision for this account. Call it once, at the end. Code checks yearlyPaceUsd against its own figures and rejects one far from them.",
        inputSchema: DecisionSchema,
        execute: async (decision) => {
          // Checked here, not in the schema: the SDK hands tool schemas to the model-call step as
          // JSON Schema, which can't carry a zod refinement. A throw goes back to the agent as
          // the tool's result, so it can correct the figure and call again.
          const rejection = checkYearlyPace(decision.yearlyPaceUsd, facts);
          if (rejection) throw new Error(rejection);
          await saveDecisionStep(runId, day, accountKey, decision);
          saved = decision;
          return "Recorded. You're done.";
        },
      }),
    },
  });

  const result = await agent.stream({
    messages: [{ role: "user", content: accountBrief(account, day) }],
    // Stop once a decision is saved. Not hasToolCall("recordDecision"): a rejected call is
    // still a recordDecision call, and the agent needs another turn to correct it.
    stopWhen: [isStepCount(12), () => saved !== undefined],
  });

  // Keep the decision that was saved, not the first recordDecision call (it may have been rejected).
  if (!saved) {
    const lastText = result.steps.at(-1)?.text?.slice(0, 200) ?? "";
    throw new Error(`The agent stopped after ${result.steps.length} steps without recording a decision.${lastText ? ` Last message: ${lastText}` : ""}`);
  }
  const decision: Decision = saved;

  const agentUsage = sumStepUsage(CLAUDE_MODEL, result.steps);
  await saveAgentUsageStep(day, accountKey, agentUsage);

  if (decision.play === "ignore") return { status: "decided", decision, email: null, agentUsage, emailUsage: null };

  // The email: Baseten first; a failed check isn't retried (it's a FatalError), network
  // errors are retried by the step; then Claude; then no draft rather than a failed account.
  details ??= await getAccountStep(accountKey);
  const primary = details.contacts[0];
  const emailInput: EmailDraftInput = {
    accountName: details.name,
    contactName: primary?.name ?? "there",
    contactTitle: primary?.title ?? null,
    play: decision.play,
    why: decision.why,
    nextStep: decision.nextStep,
  };
  let draft: EmailDraft | null = null;
  try {
    draft = await draftWithBasetenStep(emailInput);
  } catch {
    try {
      draft = await draftWithClaudeStep(emailInput);
    } catch {
      draft = null;
    }
  }
  if (draft) await saveEmailDraftStep(day, accountKey, draft);

  return {
    status: "decided",
    decision,
    email: draft && { subject: draft.subject, body: draft.body, model: draft.model },
    agentUsage,
    emailUsage: draft && { model: draft.model, inputTokens: draft.inputTokens, outputTokens: draft.outputTokens },
  };
}

function accountBrief(account: AccountSignalInput["account"], day: string): string {
  const facts = paceFacts(account.weeklySpend);
  const weeks = account.weeklySpend;
  const commit =
    account.plan === "Committed" && account.committedSpend
      ? `- Commit: ${usd(account.committedSpend)}/yr. ${(facts.thisWeekYearly / account.committedSpend).toFixed(2)}x = pace ÷ commit ` +
        `(${usd(facts.thisWeekYearly)} ÷ ${usd(account.committedSpend)}), not week-over-week growth.`
      : `- Plan: ${account.plan ?? "not set"}, so there's no commit to compare against.`;
  return [
    `Account: ${account.name} (${account.accountKey}). Today is ${day}.`,
    `Suggested play: ${account.play}. Priority: $${account.priority.toLocaleString("en-US")}/yr at stake.`,
    "Signals the rules found:",
    ...account.signals.map((s) => `- ${s}`),
    "",
    "Facts computed by code (correct, don't recompute):",
    `- Weekly spend, last 4 weeks, oldest first (the last is this week): ${weeks.map(usd).join(" · ")}.`,
    `- Yearly pace = this week × 52: ${usd(facts.thisWeekYearly)}/yr.`,
    `- 4-week average × 52: ${usd(facts.fourWeekYearly)}/yr (average ${usd(facts.fourWeekYearly / 52)}/wk).`,
    commit,
  ].join("\n");
}

function usd(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

async function getAccountStep(accountKey: string) {
  "use step";
  return loadAccountDetails(accountKey);
}

/** Only this account's usage rows go into the sandbox: no keys, no network, nothing kept after it stops. */
async function analyzeUsageStep(accountKey: string, day: string, code: string) {
  "use step";
  const csv = await loadAccountUsageCsv(accountKey, addDays(day, -(SUMMARY_LOOKBACK_DAYS - 1)), day);
  return runPython(code, [{ path: "usage.csv", content: csv }]);
}

async function saveDecisionStep(runId: string, day: string, accountKey: string, decision: Decision) {
  "use step";
  await saveDecision(runId, day, accountKey, decision);
}

async function saveAgentUsageStep(day: string, accountKey: string, usage: ModelUsage) {
  "use step";
  await saveAgentUsage(day, accountKey, usage);
}

async function draftWithBasetenStep(input: EmailDraftInput) {
  "use step";
  return draftWithBaseten(input);
}

async function draftWithClaudeStep(input: EmailDraftInput) {
  "use step";
  return draftWithClaude(input);
}

async function saveEmailDraftStep(day: string, accountKey: string, draft: EmailDraft) {
  "use step";
  await saveEmailDraft(day, accountKey, draft);
}

/** Wakes the daily run. If it has already moved on (timed out), there's nobody to tell. */
async function reportToDailyRun(token: string, report: AccountReport) {
  "use step";
  try {
    await decisionReady.resume(token, report);
    return { delivered: true };
  } catch (error) {
    if (/not found|disposed|no hook/i.test(String(error))) return { delivered: false };
    throw error;
  }
}
