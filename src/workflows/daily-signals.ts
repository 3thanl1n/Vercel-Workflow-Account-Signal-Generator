import { getWorkflowMetadata, sleep } from "workflow";
import { start } from "workflow/api";
import { addDays } from "@/lib/dates";
import { type AccountReport, type AccountTake, collectTakes, decisionReady, decisionToken } from "@/lib/decisions";
import { failRun, finishRun, getRunSlackMessage, saveRunSlackMessage, startRun } from "@/lib/run-log";
import { rankAccounts, type CrmAccount, type Ranking } from "@/lib/rules";
import { loadCrmAccounts } from "@/lib/salesforce";
import { alertsChannel, postSlackMessage } from "@/lib/slack";
import { formatSummary } from "@/lib/summary-message";
import { generateUsage } from "@/lib/usage-generator";
import { insertUsage, loadUsageRows } from "@/lib/usage-store";
import { SUMMARY_LOOKBACK_DAYS, summarizeUsage, type UsageSummary } from "@/lib/usage-summary";
import { accountSignal } from "@/workflows/account-signal";

/** How long the daily run waits for the agents before posting what it has. */
const AGENT_WAIT = "30m";

export type DailySignalsInput = { day: string; trigger: "cron" | "manual" };

// The daily run. The workflow function only orders the steps; each step does the
// I/O, saves its result, and retries on its own if it throws.
export async function dailySignals({ day, trigger }: DailySignalsInput) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  await logRunStarted(workflowRunId, day, trigger);

  try {
    await generateTodaysUsage(day);
    const accounts = await loadSalesforceAccounts();
    const usage = await loadUsageSummaries(day);
    const ranking = await prioritize(accounts, usage);
    const takes = await investigateTopAccounts(workflowRunId, day, ranking);
    const slack = await postSummary(workflowRunId, day, ranking, takes);
    const decided = Object.values(takes).filter((t) => t.status === "decided").length;
    await logRunFinished(workflowRunId, ranking, slack.ts === "dry-run" ? 0 : 1, { decided, failed: ranking.top.length - decided });
    return {
      day,
      checked: ranking.checked,
      flagged: ranking.ranked.length,
      agents: Object.fromEntries(Object.entries(takes).map(([key, take]) => [key, take.status])),
      slack,
    };
  } catch (error) {
    await logRunFailed(workflowRunId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Fork and wait: one child run per top account, all working at once. Each child resumes
 * its own hook when it's done, and nothing runs while the daily run waits. After 30 minutes
 * it moves on with whatever came back. Never throws: if the fork itself breaks, the digest
 * still posts with the rule lines.
 */
async function investigateTopAccounts(runId: string, day: string, ranking: Ranking): Promise<Record<string, AccountTake>> {
  const received: Record<string, AccountReport> = {};
  try {
    const children = ranking.top.map(async (account) => {
      const token = decisionToken(runId, account.accountKey);
      // Create the hook before starting the child, so its report can't arrive first.
      const hook = decisionReady.create({ token });
      try {
        await start(accountSignal, [
          {
            runId,
            day,
            decisionToken: token,
            account: {
              accountKey: account.accountKey,
              name: account.name,
              play: account.play,
              priority: account.priority,
              signals: account.signals.map((s) => s.detail),
            },
          },
        ]);
      } catch (error) {
        received[account.accountKey] = { status: "failed", error: `couldn't start: ${error instanceof Error ? error.message : String(error)}` };
        return;
      }
      received[account.accountKey] = await hook;
    });
    await Promise.race([Promise.allSettled(children), sleep(AGENT_WAIT)]);
  } catch {
    // Keep whatever arrived; the rest show as timed out.
  }
  return collectTakes(ranking.top.map((a) => a.accountKey), received);
}

async function logRunStarted(runId: string, day: string, trigger: DailySignalsInput["trigger"]) {
  "use step";
  await startRun(runId, day, trigger);
}

/** Fills any missing day in the last 30, today included. Rows are deterministic, so reruns add nothing. */
async function generateTodaysUsage(day: string) {
  "use step";
  const rows = generateUsage(addDays(day, -29), day);
  return { generated: rows.length, inserted: await insertUsage(rows) };
}

async function loadSalesforceAccounts(): Promise<CrmAccount[]> {
  "use step";
  return loadCrmAccounts();
}

/** Reads 28 days of raw rows and returns one small summary per account. */
async function loadUsageSummaries(day: string): Promise<UsageSummary[]> {
  "use step";
  const rows = await loadUsageRows(addDays(day, -(SUMMARY_LOOKBACK_DAYS - 1)), day);
  return summarizeUsage(rows, day);
}

async function prioritize(accounts: CrmAccount[], usage: UsageSummary[]): Promise<Ranking> {
  "use step";
  return rankAccounts(accounts, usage);
}

/** Checks the run log before posting, so a retry after a successful post doesn't post twice. */
async function postSummary(runId: string, day: string, ranking: Ranking, takes: Record<string, AccountTake>) {
  "use step";
  const existing = await getRunSlackMessage(runId);
  if (existing) return existing;
  const text = formatSummary(day, ranking, takes);
  // Local end-to-end tests: print the digest instead of posting it.
  if (process.env.SIGNAL_GEN_DRY_RUN === "1") {
    console.log(`[dry run] Slack digest not posted:\n${text}`);
    const dryRun = { channel: "dry-run", ts: "dry-run" };
    await saveRunSlackMessage(runId, dryRun, text);
    return dryRun;
  }
  const message = await postSlackMessage({ channel: alertsChannel(), text });
  await saveRunSlackMessage(runId, message, text);
  return message;
}

async function logRunFinished(runId: string, ranking: Ranking, alertsPosted: number, agent: { decided: number; failed: number }) {
  "use step";
  await finishRun(runId, ranking, alertsPosted, agent);
}

async function logRunFailed(runId: string, error: string) {
  "use step";
  await failRun(runId, error);
}
