import { collectErrorGraphCandidates, formatErrorMessage } from "../../../infra/errors.js";
import { redactSensitiveText } from "../../../logging/redact.js";
import {
  extractHttpStatusFromErrorText,
  extractLeadingHttpStatus,
  isNonOkHttpStatus,
} from "../../../shared/assistant-error-format.js";
import type { AgentMessage } from "../../runtime/index.js";
import { log } from "../logger.js";

function textIndicatesHttpStatus(text: string, status: number): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (extractLeadingHttpStatus(trimmed)?.code === status) {
    return true;
  }
  return (
    new RegExp(`\\b${status}\\s+status code\\b`, "i").test(trimmed) ||
    new RegExp(`\\bstatus code:\\s*${status}\\b`, "i").test(trimmed) ||
    new RegExp(`\\bhttp\\s*${status}\\b`, "i").test(trimmed)
  );
}

function textIndicatesHttp400(text: string): boolean {
  return textIndicatesHttpStatus(text, 400);
}

/** Best-effort HTTP status extraction from thrown provider / transport errors. */
export function resolveHttpStatusFromUnknown(err: unknown): number | undefined {
  for (const candidate of collectErrorGraphCandidates(err, (rec) => {
    const nested: unknown[] = [];
    const cause = rec.cause;
    if (cause) {
      nested.push(cause);
    }
    return nested;
  })) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const status = (candidate as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return Math.trunc(status);
    }
    const statusCode = (candidate as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
      return Math.trunc(statusCode);
    }
  }
  const formatted = formatErrorMessage(err);
  const leading = extractLeadingHttpStatus(formatted.trim());
  if (leading) {
    return leading.code;
  }
  if (textIndicatesHttp400(formatted)) {
    return 400;
  }
  return extractHttpStatusFromErrorText(formatted);
}

export function resolveNonOkHttpStatusFromUnknown(err: unknown): number | undefined {
  const status = resolveHttpStatusFromUnknown(err);
  return isNonOkHttpStatus(status) ? status : undefined;
}

export function assistantStopErrorIndicatesNonOkHttp(assistant: AgentMessage): boolean {
  if (assistant.role !== "assistant") {
    return false;
  }
  const rec = assistant as { stopReason?: unknown; errorMessage?: unknown };
  if (rec.stopReason !== "error") {
    return false;
  }
  const em = typeof rec.errorMessage === "string" ? rec.errorMessage : "";
  return isNonOkHttpStatus(extractHttpStatusFromErrorText(em));
}

export function assistantStopErrorIndicatesHttp400(assistant: AgentMessage): boolean {
  if (assistant.role !== "assistant") {
    return false;
  }
  const rec = assistant as { stopReason?: unknown; errorMessage?: unknown };
  if (rec.stopReason !== "error") {
    return false;
  }
  const em = typeof rec.errorMessage === "string" ? rec.errorMessage : "";
  if (textIndicatesHttp400(em)) {
    return true;
  }
  return extractLeadingHttpStatus(em.trim())?.code === 400;
}

export function formatHttpErrorForLog(text: string, limit = 300): string {
  const redacted = redactSensitiveText(text).replace(/\s+/g, " ").trim();
  if (!redacted) {
    return "<empty>";
  }
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit - 1)}…`;
}

type MutableSessionManager = {
  fileEntries?: Array<{ type?: string; id?: string; parentId?: string | null }>;
  byId?: Map<string, unknown>;
  leafId?: string | null;
  // Must stay in sync with leafId after strip. Leaving it on a popped node
  // writes leaf.appendParentId → missing id; later turns hang off an orphan
  // branch and prior short-term context disappears (sessionKey unchanged).
  appendParentId?: string | null;
  labelsById?: Map<string, unknown>;
  labelTimestampsById?: Map<string, unknown>;
  // SessionManager 的方法名是 rewriteFile(私有,经类型转换访问;与 attempt.ts:691 一致)。
  // 之前误写成 _rewriteFile 导致下方一律走 skip 分支,失败回合从不回滚。
  rewriteFile?: (options?: { leafAppendParentId?: string | null }) => void;
};

/**
 * After a failed model request, drop only the failed turn's transcript tail
 * (the user message just submitted to the LLM, plus any turn-local assistant /
 * tool entries written for that attempt). Prior history is kept so the session
 * stays visible and continuable — this is not a full session reset.
 */
export function revertEmbeddedSessionToPrePromptLeaf(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  sessionManager: unknown;
  prePromptMessageCount: number;
  prePromptLeafId: string | null;
  runId: string;
  sessionId: string;
  httpStatus?: number;
  errorMessage?: string;
  provider?: string;
  modelId?: string;
  source?: "prompt-throw" | "assistant-stop";
}): void {
  const msgs = params.activeSession.agent.state.messages;
  const removedMessageCount = Math.max(0, msgs.length - params.prePromptMessageCount);
  if (removedMessageCount > 0) {
    params.activeSession.agent.state.messages = msgs.slice(0, params.prePromptMessageCount);
  }

  const statusLabel = params.httpStatus !== undefined ? String(params.httpStatus) : "unknown";
  const errorLabel = params.errorMessage ? formatHttpErrorForLog(params.errorMessage) : "<none>";
  const providerLabel = params.provider?.trim() || "unknown";
  const modelLabel = params.modelId?.trim() || "unknown";
  const sourceLabel = params.source ?? "unknown";

  const sm = params.sessionManager as MutableSessionManager;
  if (!Array.isArray(sm.fileEntries) || typeof sm.rewriteFile !== "function") {
    log.warn(
      `[http-error-session-revert] skip SessionManager rewrite (missing fileEntries/rewriteFile) ` +
        `runId=${params.runId} sessionId=${params.sessionId} ` +
        `provider=${providerLabel} model=${modelLabel} ` +
        `httpStatus=${statusLabel} source=${sourceLabel} ` +
        `removedMessages=${removedMessageCount} error=${errorLabel}`,
    );
    return;
  }

  let removedEntries = 0;
  let guard = 0;
  while (sm.leafId !== params.prePromptLeafId && sm.fileEntries.length > 1 && guard < 10_000) {
    guard += 1;
    const last = sm.fileEntries.at(-1);
    if (!last || last.type === "session") {
      break;
    }
    sm.fileEntries.pop();
    removedEntries += 1;
    if (last.id) {
      sm.byId?.delete(last.id);
      sm.labelsById?.delete(last.id);
      sm.labelTimestampsById?.delete(last.id);
    }
    sm.leafId = last.parentId ?? null;
  }

  if (sm.leafId !== params.prePromptLeafId) {
    log.warn(
      `[http-error-session-revert] leaf mismatch after strip (session may need manual repair) ` +
        `runId=${params.runId} sessionId=${params.sessionId} ` +
        `provider=${providerLabel} model=${modelLabel} ` +
        `httpStatus=${statusLabel} source=${sourceLabel} ` +
        `expectedLeaf=${params.prePromptLeafId ?? "null"} actualLeaf=${sm.leafId ?? "null"} ` +
        `removedEntries=${removedEntries} removedMessages=${removedMessageCount} ` +
        `error=${errorLabel}`,
    );
    sm.rewriteFile();
  } else {
    // Align with SessionManager.removeTrailingEntries: leafId + appendParentId
    // both point at the retained pre-prompt node before rewriteFile emits leaf.
    // Without this, leaf.appendParentId keeps the popped turn id → orphan branch
    // and the next user message loses prior short-term context.
    sm.appendParentId = params.prePromptLeafId;
    sm.rewriteFile({ leafAppendParentId: params.prePromptLeafId });
  }
  // 400/敏感词等非 2xx 失败时丢弃本轮 tail,避免毒内容反复提交。
  log.info(
    `[http-error-session-revert] discarded failed prompt turn from session transcript ` +
      `runId=${params.runId} sessionId=${params.sessionId} ` +
      `provider=${providerLabel} model=${modelLabel} ` +
      `httpStatus=${statusLabel} source=${sourceLabel} ` +
      `removedEntries=${removedEntries} removedMessages=${removedMessageCount} ` +
      `prePromptMessages=${params.prePromptMessageCount} ` +
      `prePromptLeaf=${params.prePromptLeafId ?? "null"} ` +
      `error=${errorLabel}`,
  );
}
