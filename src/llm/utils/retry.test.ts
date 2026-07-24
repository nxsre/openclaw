import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import { isRetryableAssistantError } from "./retry.js";

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

describe("isRetryableAssistantError", () => {
  it.each([
    "HTTP 503 Service Unavailable",
    "503 billing service unavailable; please retry your request",
    "gateway timeout (HTTP 504)",
    "provider timeout while waiting for upstream",
    "fetch failed: ECONNRESET",
    "socket hang up",
  ])("retries gateway-unavailable / timeout / network failures: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
  });

  it.each([
    "An error occurred while processing your request. You can retry your request.",
    "The system encountered an unexpected error. Try your request again.",
    "Temporary provider failure; please retry your request.",
    "HTTP 400 Bad Request: content filtered",
    "HTTP 429 too many requests",
    "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric requests per minute; please retry your request",
    "HTTP 500 Internal Server Error",
    "HTTP 502 Bad Gateway",
    "overloaded_error: The model is overloaded",
  ])("does not retry non-gateway failures: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });

  it("keeps concrete quota failures non-retryable", () => {
    expect(isRetryableAssistantError(errorMessage("429 insufficient_quota"))).toBe(false);
    expect(isRetryableAssistantError(errorMessage("Monthly usage limit reached"))).toBe(false);
  });
});
