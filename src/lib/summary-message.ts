import { usd, type Play, type Ranking } from "@/lib/rules";

const PLAY_LABELS: Record<Play, string> = { expand: "Expand", save: "Save", new_use_case: "New use case" };

/** The plain daily Slack summary (Slack mrkdwn). The agent's analysis replaces this on Sunday. */
export function formatSummary(day: string, ranking: Ranking): string {
  const date = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const lines = [
    `*Signal Gen · ${date}*: ${ranking.checked} accounts checked, ${ranking.ranked.length} flagged.`,
  ];

  if (ranking.top.length === 0) lines.push("No account crossed a rule today.");

  ranking.top.forEach((account, i) => {
    lines.push(
      "",
      `${i + 1}. *${account.name}* · ${PLAY_LABELS[account.play]} · ${usd(account.priority)}/yr at stake`,
      ...account.signals.map((s) => `      • ${s.detail}`),
      `      Owner: ${account.ownerName ?? "unassigned"} · Renewal: ${account.renewalDate ?? "none (pay as you go)"} · Open opportunity: ${account.hasOpenOpportunity ? "yes" : "no"}`,
    );
  });

  const rest = ranking.ranked.slice(ranking.top.length);
  if (rest.length > 0) {
    lines.push("", `Also flagged (logged): ${rest.map((a) => `${a.name} (${PLAY_LABELS[a.play]}, ${usd(a.priority)})`).join(", ")}`);
  }
  if (ranking.watch.length > 0) {
    lines.push("", `Watching: ${ranking.watch.map((w) => `${w.name} (${w.signals.map((s) => s.detail).join("; ")})`).join(", ")}`);
  }
  return lines.join("\n");
}
