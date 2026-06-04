import { collectErrorGraphCandidates, formatErrorMessage } from "../../../infra/errors.js";
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

type MutableSessionManager = {
  fileEntries?: Array<{ type?: string; id?: string; parentId?: string | null }>;
  byId?: Map<string, unknown>;
  leafId?: string | null;
  labelsById?: Map<string, unknown>;
  labelTimestampsById?: Map<string, unknown>;
  _rewriteFile?: () => void;
};

/**
 * After a failed model request, drop in-memory transcript and SessionManager tail entries
 * so the user turn that triggered a non-2xx HTTP error is not kept in the session file.
 */
export function revertEmbeddedSessionToPrePromptLeaf(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  sessionManager: unknown;
  prePromptMessageCount: number;
  prePromptLeafId: string | null;
  runId: string;
  sessionId: string;
}): void {
  const msgs = params.activeSession.agent.state.messages;
  if (msgs.length > params.prePromptMessageCount) {
    params.activeSession.agent.state.messages = msgs.slice(0, params.prePromptMessageCount);
  }

  const sm = params.sessionManager as MutableSessionManager;
  if (!Array.isArray(sm.fileEntries) || typeof sm._rewriteFile !== "function") {
    log.warn(
      `[http-error-session-revert] skip SessionManager rewrite (missing fileEntries/_rewriteFile) ` +
        `runId=${params.runId} sessionId=${params.sessionId}`,
    );
    return;
  }

  let guard = 0;
  while (sm.leafId !== params.prePromptLeafId && sm.fileEntries.length > 1 && guard < 10_000) {
    guard += 1;
    const last = sm.fileEntries.at(-1);
    if (!last || last.type === "session") {
      break;
    }
    sm.fileEntries.pop();
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
        `expectedLeaf=${params.prePromptLeafId ?? "null"} actualLeaf=${sm.leafId ?? "null"}`,
    );
  }

  sm._rewriteFile();
  log.info(
    `[http-error-session-revert] removed failed prompt turn from session transcript ` +
      `runId=${params.runId} sessionId=${params.sessionId} ` +
      `prePromptMessages=${params.prePromptMessageCount} prePromptLeaf=${params.prePromptLeafId ?? "null"}`,
  );
}
