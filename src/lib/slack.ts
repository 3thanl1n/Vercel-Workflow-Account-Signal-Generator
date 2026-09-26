import { deleteTokenCacheEntry } from "@vercel/connect";
import { connectToken } from "@/lib/connect";
import { FatalError, RetryableError } from "workflow";

// Slack access through Vercel Connect: the bot token is minted at call time from the
// project's OIDC identity, so no Slack secret lives in env vars.
export const SLACK_CONNECTOR = process.env.SLACK_CONNECTOR ?? "slack/signal-gen-slack";
const CONNECT_PARAMS = { subject: { type: "app" as const } };

// Slack errors that retrying won't fix: missing scope, wrong or archived channel, bad payload.
const PERMANENT_ERRORS = new Set([
  "account_inactive",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_blocks",
  "msg_too_long",
]);
// Token problems: drop the cached token so the step's retry fetches a fresh one.
const TOKEN_ERRORS = new Set(["invalid_auth", "not_authed", "token_expired", "token_revoked"]);

export function alertsChannel(): string {
  const channel = process.env.SLACK_ALERTS_CHANNEL_ID;
  if (!channel) throw new FatalError("SLACK_ALERTS_CHANNEL_ID is not set.");
  return channel;
}

async function slackApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const { token } = await connectToken(SLACK_CONNECTOR, CONNECT_PARAMS);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after")) || 30;
    throw new RetryableError("Slack rate limit", { retryAfter: seconds * 1000 });
  }
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);

  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!data.ok) {
    const message = `Slack ${method} failed: ${data.error}`;
    if (TOKEN_ERRORS.has(data.error ?? "")) deleteTokenCacheEntry(SLACK_CONNECTOR, CONNECT_PARAMS);
    throw PERMANENT_ERRORS.has(data.error ?? "") ? new FatalError(message) : new Error(message);
  }
  return data;
}

export async function postSlackMessage(message: { channel: string; text: string }): Promise<{ channel: string; ts: string }> {
  const data = await slackApi<{ channel: string; ts: string }>("chat.postMessage", {
    ...message,
    unfurl_links: false,
    unfurl_media: false,
  });
  return { channel: data.channel, ts: data.ts };
}
