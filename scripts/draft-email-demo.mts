// Drafts one email for a fictional account with a real model and shows what it cost.
//   npm run email:demo            -> GLM 5.3 Flash on Baseten
//   npm run email:demo -- claude  -> Claude through AI Gateway (the fallback)
import { draftCostUsd, draftWithBaseten, draftWithClaude, wordCount, type EmailDraftInput } from "@/lib/email-draft";

const INPUT: EmailDraftInput = {
  accountName: "Kestrel Code",
  contactName: "Aiden Mercer",
  contactTitle: "VP Infrastructure",
  play: "expand",
  why: [
    "Weekly spend rose from $57.2k to $92.9k in a week (1.62x)",
    "On pace for about $4.83M a year against a $2.92M annual commit",
    "Renewal is on 2027-02-28 and there is an open renewal opportunity",
  ],
  nextStep: "Offer a larger committed plan before the renewal, and check their capacity needs for Q4",
};

const useClaude = process.argv[2] === "claude";
const started = performance.now();
try {
  const draft = await (useClaude ? draftWithClaude(INPUT) : draftWithBaseten(INPUT));
  const seconds = (performance.now() - started) / 1000;
  const cost = draftCostUsd(draft);
  console.log(`Model:   ${draft.model}`);
  console.log(`Subject: ${draft.subject} (${draft.subject.length} chars)`);
  console.log(`Body (${wordCount(draft.body)} words):\n${draft.body}\n`);
  console.log(`Tokens:  ${draft.inputTokens} in, ${draft.outputTokens} out`);
  console.log(`Time:    ${seconds.toFixed(1)}s`);
  console.log(`Cost:    ${cost === null ? "unknown" : `$${cost.toFixed(6)}`}`);
} catch (error) {
  // Print only what's safe: never the request or its headers.
  const e = error as { name?: string; message?: string; statusCode?: number; responseBody?: string };
  console.error(`FAILED after ${((performance.now() - started) / 1000).toFixed(1)}s: ${e.name}${e.statusCode ? ` (HTTP ${e.statusCode})` : ""}`);
  console.error(String(e.message).slice(0, 300));
  if (e.responseBody) console.error(`Response: ${e.responseBody.slice(0, 300)}`);
  process.exitCode = 1;
}
