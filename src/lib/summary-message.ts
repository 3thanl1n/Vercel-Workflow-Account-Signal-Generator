import { money, TOP_N, type Play, type RankedAccount, type Ranking } from "@/lib/rules";

const PLAY_LABELS: Record<Play, string> = { expand: "Expand", save: "Save", new_use_case: "New use case" };
const INDENT = "      ";

/**
 * The daily Slack summary (Slack mrkdwn). Each signal line shows its inputs, the threshold
 * it crossed and the $/yr math, so a reader can check it by hand. When the agent is added,
 * its take goes under each account's signal lines; the signal lines stay.
 */
export function formatSummary(day: string, ranking: Ranking): string {
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
  ranking.top.forEach((account, i) => lines.push("", ...accountLines(account, i + 1)));

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
