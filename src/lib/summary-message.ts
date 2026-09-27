import type { AccountTake } from "@/lib/decisions";
import { draftLabel } from "@/lib/email-draft";
import { money, TOP_N, type Play, type RankedAccount, type Ranking } from "@/lib/rules";

const PLAY_LABELS: Record<Play | "ignore", string> = { expand: "Expand", save: "Save", new_use_case: "New use case", ignore: "Ignore" };
const INDENT = "      ";

/**
 * The daily Slack summary (Slack mrkdwn). Each signal line shows its inputs, the threshold
 * it crossed and the $/yr math, so a reader can check it by hand. The agent's take (play,
 * why, email) goes under each top account's signal lines; the signal lines always stay.
 */
export function formatSummary(day: string, ranking: Ranking, takes?: Record<string, AccountTake>): string {
  const date = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const lines = [
    `*Signal Gen · ${date}*: ${ranking.checked} accounts checked, ${ranking.ranked.length} flagged.`,
    "Priority = each account's biggest signal in $/yr, not the sum.",
  ];

  if (ranking.top.length === 0) lines.push("", "No account crossed a rule today.");
  ranking.top.forEach((account, i) => {
    lines.push("", ...accountLines(account, i + 1));
    const take = takes?.[account.accountKey];
    if (take) lines.push(...takeLines(take));
  });

  const rest = ranking.ranked.slice(ranking.top.length);
  if (rest.length > 0) {
    lines.push("", `*Also flagged* (logged, outside the top ${TOP_N}):`);
    rest.forEach((account, i) => lines.push(...accountLines(account, ranking.top.length + i + 1)));
  }

  if (ranking.watch.length > 0) {
    lines.push("", "*Watching* (no $ signal, so not ranked):");
    for (const account of ranking.watch) {
      lines.push(`• *${account.name}*`, ...account.signals.map((s) => `${INDENT}• ${s.detail}`));
    }
  }
  return lines.join("\n");
}

/** The agent's take under an account's rule lines. The rule lines always stay. */
function takeLines(take: AccountTake): string[] {
  if (take.status === "timed_out") return [`${INDENT}*Agent:* no answer within 30 minutes; the rule lines above still stand.`];
  if (take.status === "failed") return [`${INDENT}*Agent:* failed (${take.error.slice(0, 160)}); the rule lines above still stand.`];

  const { decision, email } = take;
  const lines = [
    `${INDENT}*Agent:* ${PLAY_LABELS[decision.play]} · confidence ${decision.confidence.toFixed(2)}`,
    ...decision.why.map((reason) => `${INDENT}   – ${reason}`),
    `${INDENT}   Next step: ${decision.nextStep}`,
  ];
  if (decision.play === "ignore") return lines;
  if (!email) return [...lines, `${INDENT}*Email:* no draft (both models failed)`];
  return [
    ...lines,
    `${INDENT}*Email:* ${email.subject}`,
    ...email.body.split("\n").map((line) => `> ${line}`),
    `${INDENT}_${draftLabel(email.model)}_`,
  ];
}

function accountLines(account: RankedAccount, rank: number): string[] {
  // The signal the ranking used: the first with the account's priority as its (rounded) $/yr.
  const prioritySignal = account.signals.find(
    (s) => s.dollarsPerYear !== null && Math.round(s.dollarsPerYear) === account.priority,
  );
  return [
    `${rank}. *${account.name}* · ${PLAY_LABELS[account.play]} · ${money(account.priority).text}/yr at stake`,
    ...account.signals.map((s) => `${INDENT}• ${s.detail}${s === prioritySignal ? "  ← priority" : ""}`),
    `${INDENT}Owner: ${account.ownerName ?? "unassigned"} · Renewal: ${account.renewalDate ?? "none (pay as you go)"} · Open opportunity: ${account.hasOpenOpportunity ? "yes" : "no"}`,
  ];
}
