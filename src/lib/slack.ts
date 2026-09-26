import { FatalError, RetryableError } from "workflow";

// Slack errors that retrying won't fix: bad token, missing scope, wrong or unjoined channel.
const PERMANENT_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_blocks",
  "msg_too_long",
]);

export function alertsChannel(): string {
  const channel = process.env.SLACK_ALERTS_CHANNEL_ID;
  if (!channel) throw new FatalError("SLACK_ALERTS_CHANNEL_ID is not set.");
  return channel;
}

export async function postSlackMessage(message: { channel: string; text: string }): Promise<{ channel: string; ts: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new FatalError("SLACK_BOT_TOKEN is not set.");

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...message, unfurl_links: false, unfurl_media: false }),
  });
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after")) || 30;
    throw new RetryableError("Slack rate limit", { retryAfter: seconds * 1000 });
  }
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);

  const body = (await res.json()) as { ok: boolean; error?: string; channel: string; ts: string };
  if (!body.ok) {
    const message = `Slack chat.postMessage failed: ${body.error}`;
    throw PERMANENT_ERRORS.has(body.error ?? "") ? new FatalError(message) : new Error(message);
  }
  return { channel: body.channel, ts: body.ts };
}
