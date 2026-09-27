// Model IDs and list prices, in USD per 1M tokens (Baseten and AI Gateway, checked 2026-09-26).

export const GLM_FLASH = "zai-org/GLM-5.3-Flash"; // on Baseten
export const CLAUDE_SONNET = "anthropic/claude-sonnet-5"; // through AI Gateway
export const CLAUDE_OPUS = "anthropic/claude-opus-5.5"; // through AI Gateway

/**
 * The Claude model for the agent and the email fallback. Opus 5.5 was the plan, but it
 * returned 429 "No access to this model at this time" on this account (2026-09-27), so
 * Sonnet 5 runs instead: half the price, strong at tool use. Switch back here.
 */
export const CLAUDE_MODEL = CLAUDE_SONNET;

type Price = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

const PRICES: Record<string, Price> = {
  [GLM_FLASH]: { input: 0.15, output: 0.5 },
  [CLAUDE_SONNET]: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  [CLAUDE_OPUS]: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** `inputTokens` is the total, including cached tokens, which are billed at their own rates. */
export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/** Rough cost from list prices; null for a model without a known price. */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - read - write);
  return (
    (fresh * price.input +
      read * (price.cacheRead ?? price.input) +
      write * (price.cacheWrite ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
