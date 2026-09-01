import { classifyFailoverSignal } from "../../agents/failover/classify.js";
import { INCOMPLETE_ASSISTANT_STREAM_RE } from "../../agents/failover/message-patterns.js";
import {
  extractFailoverHttpStatus,
  hasTransientRetryEvidence,
  shouldRetryFailoverSignal,
} from "../../agents/failover/retry-evidence.js";
import { isTransientNetworkError } from "../../infra/retryable-network-errors.js";
import { extractHttpStatusFromErrorText } from "../../shared/assistant-error-format.js";
import {
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
  type AssistantMessage,
} from "../types.js";

/** Only gateway-unavailable statuses are eligible for outer auto-retry. */
const RETRYABLE_HTTP_STATUSES = new Set([503, 504]);
const RETRYABLE_TIMEOUT_ERROR_PATTERN =
  /request timeout|provider timeout|timed?\s*out|\btimeout\b|http2 request did not get a response/i;
const RETRYABLE_NETWORK_ERROR_PATTERN =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|socket connection was closed|websocket.?closed|websocket.?error/i;

const REPLAY_UNSAFE_ASSISTANT_ERROR_CODES = new Set([
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
]);

/** True when replaying the failed assistant request could duplicate unknown provider output. */
export function isReplayUnsafeAssistantError(
  message: Pick<AssistantMessage, "errorCode"> | null | undefined,
): boolean {
  return Boolean(message?.errorCode && REPLAY_UNSAFE_ASSISTANT_ERROR_CODES.has(message.errorCode));
}

/**
 * Classify transient provider/transport failures for outer retry policy.
 * Only 503/504, timeouts, and network exceptions retry. Client errors (4xx),
 * rate limits, and generic 5xx/application failures fail closed without retry.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (
    message.stopReason !== "error" ||
    !message.errorMessage ||
    isReplayUnsafeAssistantError(message)
  ) {
    return false;
  }
  const errorMessage = message.errorMessage.trim();
  // A concrete non-retryable status wins over timeout/network substrings in the
  // same message (for example "HTTP 429 ... retry after timeout").
  const status =
    extractFailoverHttpStatus(errorMessage) ?? extractHttpStatusFromErrorText(errorMessage);
  if (status !== undefined && !RETRYABLE_HTTP_STATUSES.has(status)) {
    return false;
  }
  if (status === 503 || status === 504) {
    return true;
  }
  if (INCOMPLETE_ASSISTANT_STREAM_RE.test(errorMessage)) {
    return true;
  }
  if (RETRYABLE_TIMEOUT_ERROR_PATTERN.test(errorMessage)) {
    return true;
  }
  if (
    RETRYABLE_NETWORK_ERROR_PATTERN.test(errorMessage) ||
    isTransientNetworkError({ code: message.errorCode })
  ) {
    return true;
  }
  const signal = {
    message: errorMessage,
    provider: message.provider,
    code: message.errorCode,
    errorType: message.errorType,
  };
  const classification = classifyFailoverSignal(signal);
  const reason = classification?.kind === "reason" ? classification.reason : undefined;
  if (reason === "rate_limit" || reason === "billing" || reason === "overloaded") {
    return false;
  }
  return (
    reason === "timeout" &&
    shouldRetryFailoverSignal({
      classification,
      hasTransientEvidence: hasTransientRetryEvidence(signal),
      signal,
    })
  );
}
