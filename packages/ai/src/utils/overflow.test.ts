import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import { isConfiguredContextSizeOverflowError, isContextOverflow } from "./overflow.js";

function errorMessage(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: 1,
  };
}

function successfulMessage(
  contextUsage?: AssistantMessage["usage"]["contextUsage"],
): AssistantMessage {
  return {
    ...errorMessage(""),
    usage: {
      input: 12,
      output: 15_104,
      cacheRead: 1_100_000,
      cacheWrite: 93_130,
      ...(contextUsage ? { contextUsage } : {}),
      totalTokens: 1_208_246,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    errorMessage: undefined,
  };
}

describe("configured context size overflow", () => {
  it.each([
    "400 Prompt has 256468 tokens, but the configured context size is 256000 tokens",
    "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
  ])("detects %s", (text) => {
    expect(isConfiguredContextSizeOverflowError(text)).toBe(true);
    expect(isContextOverflow(errorMessage(text), 256_000)).toBe(true);
  });
});

describe("empty-body HTTP overflow heuristics", () => {
  it("treats 413 status code (no body) as overflow for any provider", () => {
    expect(isContextOverflow(errorMessage("413 status code (no body)"), 128_000)).toBe(true);
  });

  it("does not treat bare 400 status code (no body) as overflow for non-cerebras providers", () => {
    // Regression: sensitive-word / business 400s often surface as
    // "400 status code (no body)" after OpenAI SDK body parse loss. Matching
    // that as overflow caused compact-and-retry loops on toxic turns.
    const msg = errorMessage("400 status code (no body)");
    msg.provider = "cloudphone_unicom_manual";
    expect(isContextOverflow(msg, 128_000)).toBe(false);
  });

  it("keeps bare 400 status code (no body) as overflow for cerebras only", () => {
    const msg = errorMessage("400 status code (no body)");
    msg.provider = "cerebras";
    expect(isContextOverflow(msg, 128_000)).toBe(true);
  });
});

describe("usage-based overflow", () => {
  it("prefers an available context snapshot over aggregate billing usage", () => {
    expect(
      isContextOverflow(
        successfulMessage({
          state: "available",
          promptTokens: 148_874,
          totalTokens: 163_978,
        }),
        1_000_000,
      ),
    ).toBe(false);
  });

  it("does not infer overflow from aggregate billing when context is unavailable", () => {
    expect(isContextOverflow(successfulMessage({ state: "unavailable" }), 1_000_000)).toBe(false);
  });
});
