import { getSql } from "@/lib/db";
import type { Ranking } from "@/lib/rules";

// The `runs` table is the durable run history (Hobby deletes workflow run data after 1 day).
// Every write is keyed by run_id, so a retried step never creates a second row.

export async function startRun(runId: string, day: string, trigger: "cron" | "manual") {
  const sql = getSql();
  await sql`
    insert into runs (run_id, day, trigger, status)
    values (${runId}, ${day}::date, ${trigger}, 'running')
    on conflict (run_id) do nothing`;
}

export async function finishRun(runId: string, ranking: Ranking, alertsPosted: number) {
  const sql = getSql();
  await sql`
    update runs set
      status = 'succeeded', finished_at = now(), error = null,
      accounts_checked = ${ranking.checked},
      flagged = ${ranking.ranked.length},
      alerts_posted = ${alertsPosted},
      ranking = ${JSON.stringify({ ranked: ranking.ranked, watch: ranking.watch })}::jsonb
    where run_id = ${runId}`;
}

export async function failRun(runId: string, error: string) {
  const sql = getSql();
  await sql`
    update runs set status = 'failed', finished_at = now(), error = ${error.slice(0, 2000)}
    where run_id = ${runId}`;
}

export async function getRunSlackMessage(runId: string): Promise<{ channel: string; ts: string } | null> {
  const sql = getSql();
  const [row] = await sql`select slack_channel, slack_ts from runs where run_id = ${runId}`;
  return row?.slack_ts ? { channel: row.slack_channel, ts: row.slack_ts } : null;
}

export async function saveRunSlackMessage(runId: string, message: { channel: string; ts: string }) {
  const sql = getSql();
  await sql`update runs set slack_channel = ${message.channel}, slack_ts = ${message.ts} where run_id = ${runId}`;
}

/** Returns false if this day was already claimed by an earlier cron delivery. */
export async function claimCronDay(day: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`insert into cron_days (day) values (${day}::date) on conflict (day) do nothing returning day`;
  return rows.length > 0;
}

export async function releaseCronDay(day: string) {
  const sql = getSql();
  await sql`delete from cron_days where day = ${day}::date`;
}
