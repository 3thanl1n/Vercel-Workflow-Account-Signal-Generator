import { baseten } from "@ai-sdk/baseten";
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { FatalError } from "workflow";
import { z } from "zod";

// Two models, two jobs. Claude does the account analysis (hard reasoning with tools);
// an open model on Baseten writes the follow-up email, a short, repeated writing job
// where a small fast model is cheaper and quicker. Claude drafts only if Baseten fails.

export const BASETEN_MODEL = "zai-org/GLM-5.3-Flash";
export const CLAUDE_MODEL = "anthropic/claude-opus-5.5";
const BASETEN_TIMEOUT_MS = 30_000;

/** List prices in USD per 1M tokens (Baseten and AI Gateway, checked 2026-09-26). */
export const PRICES_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  [BASETEN_MODEL]: { input: 0.15, output: 0.5 },
  [CLAUDE_MODEL]: { input: 4, output: 20 },
};

export type EmailDraftInput = {
  accountName: string;
  contactName: string;
  contactTitle: string | null;
  play: "expand" | "save" | "new_use_case";
  /** The agent's 2-4 "why" bullets, with numbers. */
  why: string[];
  nextStep: string;
};

export type EmailDraft = { subject: string; body: string; model: string; inputTokens: number; outputTokens: number };

/** What the model is asked to return. Loose on purpose, so the checks below give clear reasons. */
const DraftShape = z.object({ subject: z.string(), body: z.string() });

/** Every draft must pass these before anyone sees it. */
export const DraftCheck = z.object({
  subject: z.string().trim().min(1, "subject is empty").max(80, "subject is over 80 characters"),
  body: z
    .string()
    .trim()
    .min(1, "body is empty")
    .refine((body) => wordCount(body) <= 150, "body is over 150 words")
    .refine((body) => /\d/.test(body), "body mentions no number"),
});

/**
 * A draft that failed the checks. It's a FatalError, so a workflow step doesn't retry it
 * (the same prompt would likely fail the same way); the Claude fallback takes over instead.
 */
export class DraftCheckError extends FatalError {
  constructor(model: string, reasons: string[]) {
    super(`${model} draft failed the check: ${reasons.join("; ")}`);
    this.name = "DraftCheckError";
  }
}

const SYSTEM = `You draft short follow-up emails for an account owner at an AI inference company that sells model APIs billed by usage.
Rules:
- Subject: specific to the account, 80 characters or less.
- Body: under 120 words. Greet the contact by first name.
- Mention at least one concrete number from the facts you're given, framed as something useful to the customer.
- Never mention internal scores, rules, signals, or that this email was generated.
- Fit the play: expand = help them grow (capacity, committed pricing); save = check in on reliability and offer help; new_use_case = ask about the new workload and offer support.
- End with one clear ask, such as a short call. No signature block and no placeholders.
Return JSON with "subject" and "body".`;

function formatInput(input: EmailDraftInput): string {
  return [
    `Account: ${input.accountName}`,
    `Contact: ${input.contactName}${input.contactTitle ? `, ${input.contactTitle}` : ""}`,
    `Play: ${input.play}`,
    "Why:",
    ...input.why.map((line) => `- ${line}`),
    `Next step: ${input.nextStep}`,
  ].join("\n");
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function draft(model: LanguageModel, modelId: string, input: EmailDraftInput, timeout?: number): Promise<EmailDraft> {
  let result;
  try {
    result = await generateText({
      model,
      system: SYSTEM,
      prompt: formatInput(input),
      output: Output.object({ schema: DraftShape }),
      // The workflow step owns retries, so they show up in the run history.
      maxRetries: 0,
      timeout,
    });
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new DraftCheckError(modelId, ["reply wasn't a JSON object with a subject and body"]);
    }
    throw error;
  }

  const checked = DraftCheck.safeParse(result.output);
  if (!checked.success) throw new DraftCheckError(modelId, checked.error.issues.map((issue) => issue.message));
  return {
    ...checked.data,
    model: modelId,
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
  };
}

/** GLM 5.3 Flash on Baseten, with a 30-second limit. `model` is only overridden in tests. */
export function draftWithBaseten(input: EmailDraftInput, model: LanguageModel = baseten(BASETEN_MODEL)): Promise<EmailDraft> {
  return draft(model, BASETEN_MODEL, input, BASETEN_TIMEOUT_MS);
}

/** Claude through AI Gateway (OIDC, no key). The fallback writer. */
export function draftWithClaude(input: EmailDraftInput, model: LanguageModel = CLAUDE_MODEL): Promise<EmailDraft> {
  return draft(model, CLAUDE_MODEL, input);
}

export type DraftOutcome = { draft: EmailDraft | null; failures: string[] };

type Drafter = (input: EmailDraftInput) => Promise<EmailDraft>;

/**
 * Baseten first. On any failure (timeout, API error, failed check), Claude. If both
 * fail, no draft: the account still gets its alert, just without an email.
 */
export async function draftEmail(
  input: EmailDraftInput,
  drafters: { primary: Drafter; fallback: Drafter } = { primary: draftWithBaseten, fallback: draftWithClaude },
): Promise<DraftOutcome> {
  const failures: string[] = [];
  for (const drafter of [drafters.primary, drafters.fallback]) {
    try {
      return { draft: await drafter(input), failures };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { draft: null, failures };
}

/** The line shown under each email in the Slack digest. */
export function draftLabel(model: string): string {
  return model === BASETEN_MODEL ? "Draft: GLM 5.3 Flash on Baseten" : "Draft: Claude (fallback)";
}

export function draftCostUsd(draft: Pick<EmailDraft, "model" | "inputTokens" | "outputTokens">): number | null {
  const price = PRICES_PER_M_TOKENS[draft.model];
  return price ? (draft.inputTokens * price.input + draft.outputTokens * price.output) / 1_000_000 : null;
}
