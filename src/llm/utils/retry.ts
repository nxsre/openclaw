import { extractHttpStatusFromErrorText } from "../../shared/assistant-error-format.js";
import type { AssistantMessage } from "../types.js";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
  "insufficient_quota",
  "out of budget",
]);

/** Only gateway-unavailable statuses are eligible for outer auto-retry. */
const RETRYABLE_HTTP_STATUSES = new Set([503, 504]);

const RETRYABLE_NETWORK_ERROR_PATTERN = buildProviderErrorPattern([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "websocket.?closed",
  "websocket.?error",
]);

const RETRYABLE_TIMEOUT_ERROR_PATTERN = buildProviderErrorPattern([
  "request timeout",
  "provider timeout",
  "timed? out",
  "timeout",
  "http2 request did not get a response",
]);

/**
 * Classify transient provider/transport failures for outer retry policy.
 * Only 503/504, timeouts, and network exceptions retry. Client errors (4xx),
 * rate limits, and generic 5xx/application failures fail closed without retry.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) {
    return false;
  }
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message.errorMessage)) {
    return false;
  }
  const text = message.errorMessage;
  // A concrete non-retryable status wins over timeout/network substrings in the
  // same message (for example "HTTP 429 ... retry after timeout").
  const status = extractHttpStatusFromErrorText(text);
  if (status !== undefined) {
    return RETRYABLE_HTTP_STATUSES.has(status);
  }
  if (/\b(?:HTTP\s*)?(?:503|504)\b/i.test(text)) {
    return true;
  }
  if (RETRYABLE_TIMEOUT_ERROR_PATTERN.test(text)) {
    return true;
  }
  return RETRYABLE_NETWORK_ERROR_PATTERN.test(text);
}
