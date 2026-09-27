import { getSql } from "@/lib/db";
import type { UsageRow } from "@/lib/usage-generator";
import type { UsageRowLike } from "@/lib/usage-summary";

/**
 * Inserts rows that don't exist yet. Rows are deterministic, so skipping existing
 * ones (instead of overwriting) is equivalent and makes retries free.
 * One statement with array parameters, however many rows.
 */
export async function insertUsage(rows: UsageRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getSql();
  const inserted = await sql`
    insert into usage_daily (account_key, day, model, requests, gpu_hours, errors, p95_latency_ms, spend_usd)
    select * from unnest(
      ${rows.map((r) => r.accountKey)}::text[],
      ${rows.map((r) => r.day)}::date[],
      ${rows.map((r) => r.model)}::text[],
      ${rows.map((r) => r.requests)}::integer[],
      ${rows.map((r) => r.gpuHours)}::numeric[],
      ${rows.map((r) => r.errors)}::integer[],
      ${rows.map((r) => r.p95LatencyMs)}::integer[],
      ${rows.map((r) => r.spendUsd)}::numeric[]
    )
    on conflict (account_key, day, model) do nothing
    returning 1`;
  return inserted.length;
}

export async function loadUsageRows(fromDay: string, toDay: string): Promise<UsageRowLike[]> {
  const sql = getSql();
  const rows = await sql`
    select account_key, day::text as day, model, requests, errors, spend_usd::float8 as spend_usd
    from usage_daily
    where day between ${fromDay}::date and ${toDay}::date`;
  return rows.map((r) => ({
    accountKey: r.account_key,
    day: r.day,
    model: r.model,
    requests: r.requests,
    errors: r.errors,
    spendUsd: r.spend_usd,
  }));
}

/** One account's daily usage as CSV, the only data the agent's sandboxed Python can see. */
export async function loadAccountUsageCsv(accountKey: string, fromDay: string, toDay: string): Promise<string> {
  const sql = getSql();
  const rows = await sql`
    select day::text as day, model, requests, gpu_hours::float8 as gpu_hours, errors, p95_latency_ms, spend_usd::float8 as spend_usd
    from usage_daily
    where account_key = ${accountKey} and day between ${fromDay}::date and ${toDay}::date
    order by day, model`;
  const header = "day,model,requests,gpu_hours,errors,p95_latency_ms,spend_usd";
  return [header, ...rows.map((r) => [r.day, r.model, r.requests, r.gpu_hours, r.errors, r.p95_latency_ms, r.spend_usd].join(","))].join("\n");
}
