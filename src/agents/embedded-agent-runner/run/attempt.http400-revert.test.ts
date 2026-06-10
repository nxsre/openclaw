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
  revertEmbeddedSessionToPrePromptLeaf,
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

  it("strips the failed prompt turn AND task-generated tail, then rewrites the session file", () => {
    // 回归:此前 revert 检查的是 _rewriteFile(下划线),与 SessionManager 实际方法
    // rewriteFile 名字不符 → 一律 skip,失败回合(及任务中产生的工具/多模态数据)
    // 残留在 session 里污染下一次请求。这里用真实方法名,断言确实回滚 + 重写。
    let rewritten = 0;
    const fileEntries: Array<{ type?: string; id?: string; parentId?: string | null }> = [
      { type: "session", id: "s0", parentId: null },
      { type: "message", id: "u1", parentId: "s0" }, // pre-prompt leaf
      { type: "message", id: "u2", parentId: "u1" }, // 失败回合的用户消息
      { type: "message", id: "t3", parentId: "u2" }, // 任务中产生的工具结果(也要删)
    ];
    const sm = {
      fileEntries,
      byId: new Map<string, unknown>([
        ["u1", {}],
        ["u2", {}],
        ["t3", {}],
      ]),
      leafId: "t3",
      labelsById: new Map<string, unknown>(),
      labelTimestampsById: new Map<string, unknown>(),
      rewriteFile: () => {
        rewritten += 1;
      },
    };
    const activeSession = {
      agent: { state: { messages: [{}, {}, {}, {}] as unknown as AgentMessage[] } },
    };

    revertEmbeddedSessionToPrePromptLeaf({
      activeSession,
      sessionManager: sm,
      prePromptMessageCount: 2,
      prePromptLeafId: "u1",
      runId: "r",
      sessionId: "sess",
    });

    expect(sm.fileEntries.map((e) => e.id)).toEqual(["s0", "u1"]); // u2 + t3 都被删
    expect(sm.leafId).toBe("u1");
    expect(sm.byId.has("u2")).toBe(false);
    expect(sm.byId.has("t3")).toBe(false);
    expect(rewritten).toBe(1); // rewriteFile 真的被调用(修复前为 0)
    expect(activeSession.agent.state.messages).toHaveLength(2);
  });
});
