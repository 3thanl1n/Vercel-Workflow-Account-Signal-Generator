import { getWorkflowMetadata } from "workflow";
import { addDays } from "@/lib/dates";
import { failRun, finishRun, getRunSlackMessage, saveRunSlackMessage, startRun } from "@/lib/run-log";
import { rankAccounts, type CrmAccount, type Ranking } from "@/lib/rules";
import { loadCrmAccounts } from "@/lib/salesforce";
import { alertsChannel, postSlackMessage } from "@/lib/slack";
import { formatSummary } from "@/lib/summary-message";
import { generateUsage } from "@/lib/usage-generator";
import { insertUsage, loadUsageRows } from "@/lib/usage-store";
import { SUMMARY_LOOKBACK_DAYS, summarizeUsage, type UsageSummary } from "@/lib/usage-summary";

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
    const slack = await postSummary(workflowRunId, day, ranking);
    await logRunFinished(workflowRunId, ranking);
    return { day, checked: ranking.checked, flagged: ranking.ranked.length, top: ranking.top.map((a) => a.name), slack };
  } catch (error) {
    await logRunFailed(workflowRunId, error instanceof Error ? error.message : String(error));
    throw error;
  }
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
async function postSummary(runId: string, day: string, ranking: Ranking) {
  "use step";
  const existing = await getRunSlackMessage(runId);
  if (existing) return existing;
  const message = await postSlackMessage({ channel: alertsChannel(), text: formatSummary(day, ranking) });
  await saveRunSlackMessage(runId, message);
  return message;
}

async function logRunFinished(runId: string, ranking: Ranking) {
  "use step";
  await finishRun(runId, ranking, 1);
}

async function logRunFailed(runId: string, error: string) {
  "use step";
  await failRun(runId, error);
}
