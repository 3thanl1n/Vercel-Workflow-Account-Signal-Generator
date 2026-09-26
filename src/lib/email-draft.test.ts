import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { FatalError } from "workflow";
import {
  BASETEN_MODEL,
  CLAUDE_MODEL,
  DraftCheckError,
  draftCostUsd,
  draftEmail,
  draftLabel,
  draftWithBaseten,
  draftWithClaude,
  type EmailDraftInput,
} from "./email-draft";

const INPUT: EmailDraftInput = {
  accountName: "Kestrel Code",
  contactName: "Aiden Mercer",
  contactTitle: "VP Infrastructure",
  play: "expand",
  why: ["Weekly spend rose from $57.2k to $92.9k (1.62x)", "On pace for $4.83M/yr against a $2.92M commit"],
  nextStep: "Offer a larger committed plan before the Feb 28 renewal",
};

const GOOD = {
  subject: "Kestrel Code: room to grow before your February renewal",
  body: "Hi Aiden, your usage grew 62% in the last week, putting you on pace well above your current commit. Worth a 20-minute call this week to size a plan that fits?",
};

/** A fake model that replies with `text` and reports fixed token counts. */
function model(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 180, noCache: 180, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 70, text: 70, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

const failingModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("503 Service Unavailable");
    },
  });

describe("email drafts", () => {
  it("returns a draft that passes the checks, with the model and token counts", async () => {
    await expect(draftWithBaseten(INPUT, model(JSON.stringify(GOOD)))).resolves.toEqual({
      ...GOOD,
      model: BASETEN_MODEL,
      inputTokens: 180,
      outputTokens: 70,
    });
  });

  it("rejects drafts that break the rules, without retrying", async () => {
    const bad = {
      subject: "A".repeat(81),
      body: `${"word ".repeat(151)}and no digits anywhere`,
    };
    const error = await draftWithBaseten(INPUT, model(JSON.stringify(bad))).catch((e) => e);
    expect(error).toBeInstanceOf(DraftCheckError);
    expect(error.message).toBe(
      `${BASETEN_MODEL} draft failed the check: subject is over 80 characters; body is over 150 words; body mentions no number`,
    );
    // Workflow steps don't retry FatalErrors, so a failed check goes straight to the fallback.
    expect(FatalError.is(error)).toBe(true);
  });

  it("treats a reply that isn't the JSON shape as a failed check", async () => {
    const error = await draftWithBaseten(INPUT, model("Sure! Here's a draft email for Aiden...")).catch((e) => e);
    expect(error).toBeInstanceOf(DraftCheckError);
  });

  it("falls back to Claude when Baseten fails the check or errors, and gives up after both", async () => {
    const claude = (input: EmailDraftInput) => draftWithClaude(input, model(JSON.stringify(GOOD)));

    const afterBadDraft = await draftEmail(INPUT, {
      primary: (input) => draftWithBaseten(input, model(JSON.stringify({ ...GOOD, body: "No numbers here." }))),
      fallback: claude,
    });
    expect(afterBadDraft.draft?.model).toBe(CLAUDE_MODEL);
    expect(afterBadDraft.failures).toEqual([`${BASETEN_MODEL} draft failed the check: body mentions no number`]);

    const afterError = await draftEmail(INPUT, { primary: (input) => draftWithBaseten(input, failingModel()), fallback: claude });
    expect(afterError.draft?.model).toBe(CLAUDE_MODEL);
    expect(afterError.failures[0]).toContain("503");

    const neither = await draftEmail(INPUT, {
      primary: (input) => draftWithBaseten(input, failingModel()),
      fallback: (input) => draftWithClaude(input, failingModel()),
    });
    expect(neither).toMatchObject({ draft: null });
    expect(neither.failures).toHaveLength(2);
  });

  it("labels and prices each draft by model", () => {
    expect(draftLabel(BASETEN_MODEL)).toBe("Draft: GLM 5.3 Flash on Baseten");
    expect(draftLabel(CLAUDE_MODEL)).toBe("Draft: Claude (fallback)");
    // 180 in x $0.15/M + 70 out x $0.50/M
    expect(draftCostUsd({ model: BASETEN_MODEL, inputTokens: 180, outputTokens: 70 })).toBeCloseTo(0.000062, 9);
  });
});
