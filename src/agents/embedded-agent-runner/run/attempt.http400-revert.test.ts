import { describe, expect, it } from "vitest";
import {
  formatNonOkHttpStatusUserMessage,
  formatRawAssistantErrorForUi,
} from "../../../shared/assistant-error-format.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  assistantStopErrorIndicatesHttp400,
  assistantStopErrorIndicatesNonOkHttp,
  resolveHttpStatusFromUnknown,
  resolveNonOkHttpStatusFromUnknown,
} from "./attempt.http400-revert.js";

describe("attempt.http-error-revert helpers", () => {
  it("detects non-ok HTTP status from thrown provider errors", () => {
    expect(resolveNonOkHttpStatusFromUnknown({ status: 502 })).toBe(502);
    expect(resolveNonOkHttpStatusFromUnknown({ status: 200 })).toBeUndefined();
    expect(resolveNonOkHttpStatusFromUnknown(new Error("502 status code (no body)"))).toBe(502);
    expect(resolveHttpStatusFromUnknown(new Error("HTTP 400: bad request"))).toBe(400);
  });

  it("detects non-ok assistant stop errors", () => {
    const assistant = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "429 status code: rate limit exceeded",
    } as AgentMessage;
    expect(assistantStopErrorIndicatesNonOkHttp(assistant)).toBe(true);
    expect(assistantStopErrorIndicatesHttp400(assistant)).toBe(false);
  });

  it("formats friendly user-facing HTTP error copy", () => {
    const formatted = formatRawAssistantErrorForUi("502 status code (no body)");
    expect(formatted).toContain("temporarily unavailable (HTTP 502)");
    expect(formatted).toContain("Your message was not saved");
    expect(formatted).toContain("模型服务暂时不可用");
    expect(formatted).toContain("本条消息未保存");
    expect(formatNonOkHttpStatusUserMessage(429)).toContain("rate-limiting");
    expect(formatNonOkHttpStatusUserMessage(429)).toContain("限流");
  });
});
