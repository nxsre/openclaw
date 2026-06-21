// Assistant error formatting helpers normalize assistant-visible error payloads.
// XCPH: 上游 LLM 任意异常时给客户端的统一兜底文案。
// 设置 OPENCLAW_LLM_ERROR_FALLBACK_TEXT 即启用并使用该文本；为空则保留原有按类型分类的英文提示
// （便于开发期排障）。所有通道（飞书 / 微信 / OpenIM / WebSocket / HTTP）拿到的 assistant
// message.content 都经过 formatRawAssistantErrorForUi() 这一层，故仅在此处 short-circuit。
// 详细日志（provider-http-error 等）仍按原样写到服务端，便于运维查问题。
const USER_FACING_FALLBACK_ENV = "OPENCLAW_LLM_ERROR_FALLBACK_TEXT";
// XCPH: 按 HTTP 状态码读 env 配置的面向用户兜底文案。
// 变量名 = OPENCLAW_LLM_ERROR_FALLBACK_TEXT_<status>(如 _402 _429 _500;放在 openclaw.json 的
// env.vars 里)。配了该状态码 → 返回对应文案(支持 %{http_code}/%{error_message} 等变量替换);
// 没配该状态码 / 取不到状态码 → 返回 null,调用方回退显示原始错误信息(不再有统一兜底文案)。
export function userFacingFallbackText(rawError?: string): string | null {
  if (typeof rawError !== "string") return null;
  const status =
    extractLeadingHttpStatus(rawError)?.code ?? extractHttpStatusFromErrorText(rawError);
  if (status === undefined || !Number.isFinite(status)) return null;
  const raw = process.env[`${USER_FACING_FALLBACK_ENV}_${status}`];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

const ERROR_PAYLOAD_PREFIX_RE =
  /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|apierror|openai\s*error|anthropic\s*error|gateway\s*error|codex\s*error)(?:\s+\d{3})?[:\s-]+/i;
const HTTP_STATUS_DELIMITER_RE = /(?:\s*:\s*|\s+)/;
const HTTP_STATUS_PREFIX_RE = new RegExp(
  `^(?:http\\s*)?(\\d{3})${HTTP_STATUS_DELIMITER_RE.source}(.+)$`,
  "i",
);
const HTTP_STATUS_CODE_PREFIX_RE = new RegExp(
  `^(?:http\\s*)?(\\d{3})(?:${HTTP_STATUS_DELIMITER_RE.source}([\\s\\S]+))?$`,
  "i",
);
const HTML_ERROR_PREFIX_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const HTML_CLOSE_RE = /<\/html>/i;
const CLOUDFLARE_HTML_ERROR_CODES = new Set([521, 522, 523, 524, 525, 526, 530]);
const STANDALONE_HTML_ERROR_HINT_RE =
  /\bcloudflare\b|cdn-cgi\/challenge-platform|challenge-error-text|enable javascript and cookies to continue|access denied|forbidden|service unavailable|bad gateway|web server is down|captcha|attention required/i;
const GENERIC_PROVIDER_INTERNAL_ERROR_RE = /an error occurred while processing your request/i;
const SUPPORT_REQUEST_ID_RE = /(?:request[\s_-]*id)\s*[:#]?\s*([a-z0-9][a-z0-9_-]{6,}[a-z0-9])/i;
const GENERIC_PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "The AI service returned an internal error. Please try again in a moment.";

export const MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE =
  "OpenClaw transport error: malformed_streaming_fragment";
const MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE =
  "LLM streaming response contained a malformed fragment. Please try again.";

type ErrorPayload = Record<string, unknown>;

type ApiErrorInfo = {
  httpCode?: string;
  type?: string;
  message?: string;
  requestId?: string;
};

function isErrorPayloadObject(payload: unknown): payload is ErrorPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as ErrorPayload;
  if (record.type === "error") {
    return true;
  }
  if (typeof record.request_id === "string" || typeof record.requestId === "string") {
    return true;
  }
  if ("error" in record) {
    const err = record.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const errRecord = err as ErrorPayload;
      if (
        typeof errRecord.message === "string" ||
        typeof errRecord.type === "string" ||
        typeof errRecord.code === "string"
      ) {
        return true;
      }
    }
    // Flat error payloads: {"error":"insufficient_balance","message":"..."}
    if (typeof err === "string" && typeof record.message === "string") {
      return true;
    }
  }
  return false;
}

export function parseApiErrorPayload(raw?: string): ErrorPayload | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const candidates = [trimmed];
  if (ERROR_PAYLOAD_PREFIX_RE.test(trimmed)) {
    candidates.push(trimmed.replace(ERROR_PAYLOAD_PREFIX_RE, "").trim());
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isErrorPayloadObject(parsed)) {
        return parsed;
      }
    } catch {
      // ignore parse errors
    }
  }
  return null;
}

export function extractLeadingHttpStatus(raw: string): { code: number; rest: string } | null {
  const match = raw.match(HTTP_STATUS_CODE_PREFIX_RE);
  if (!match) {
    return null;
  }
  const code = Number(match[1]);
  if (!Number.isFinite(code)) {
    return null;
  }
  return { code, rest: (match[2] ?? "").trim() };
}

export function isCloudflareOrHtmlErrorPage(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  if (
    HTML_ERROR_PREFIX_RE.test(trimmed) &&
    HTML_CLOSE_RE.test(trimmed) &&
    STANDALONE_HTML_ERROR_HINT_RE.test(trimmed)
  ) {
    return true;
  }

  const status = extractLeadingHttpStatus(trimmed);
  if (!status || status.code < 500) {
    return false;
  }

  if (CLOUDFLARE_HTML_ERROR_CODES.has(status.code)) {
    return true;
  }

  return (
    status.code < 600 && HTML_ERROR_PREFIX_RE.test(status.rest) && HTML_CLOSE_RE.test(status.rest)
  );
}

export function isGenericProviderInternalError(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return (
    GENERIC_PROVIDER_INTERNAL_ERROR_RE.test(trimmed) &&
    (/help\.openai\.com/i.test(trimmed) || SUPPORT_REQUEST_ID_RE.test(trimmed))
  );
}

export function parseApiErrorInfo(raw?: string): ApiErrorInfo | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let httpCode: string | undefined;
  let candidate = trimmed;

  const httpPrefixMatch = candidate.match(/^(\d{3})\s+(.+)$/s);
  if (httpPrefixMatch) {
    httpCode = httpPrefixMatch[1];
    candidate = httpPrefixMatch[2].trim();
  }

  const payload = parseApiErrorPayload(candidate);
  if (!payload) {
    return null;
  }

  const requestId =
    typeof payload.request_id === "string"
      ? payload.request_id
      : typeof payload.requestId === "string"
        ? payload.requestId
        : undefined;

  const topType = typeof payload.type === "string" ? payload.type : undefined;
  const topMessage = typeof payload.message === "string" ? payload.message : undefined;

  let errType: string | undefined;
  let errMessage: string | undefined;
  if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
    const err = payload.error as Record<string, unknown>;
    if (typeof err.type === "string") {
      errType = err.type;
    }
    if (typeof err.code === "string" && !errType) {
      errType = err.code;
    }
    if (typeof err.message === "string") {
      errMessage = err.message;
    }
  } else if (typeof payload.error === "string") {
    // Flat error payloads: {"error":"insufficient_balance","message":"..."}
    errType = payload.error;
  }

  return {
    httpCode,
    type: errType ?? topType,
    message: errMessage ?? topMessage,
    requestId,
  };
}

export function isNonOkHttpStatus(status: number | undefined): boolean {
  return typeof status === "number" && Number.isFinite(status) && (status < 200 || status >= 300);
}

function formatBilingualUserMessage(english: string, chinese: string): string {
  return `${english}\n\n${chinese}`;
}

export function formatNonOkHttpStatusUserMessage(status: number): string {
  if (status === 401 || status === 403) {
    return formatBilingualUserMessage(
      "Authentication failed while contacting the model provider. Your message was not saved. Check your API key or credentials and try again.",
      "联系模型服务时鉴权失败，本条消息未保存。请检查 API Key 或凭证后重试。",
    );
  }
  if (status === 404) {
    return formatBilingualUserMessage(
      "The requested model or endpoint was not found (HTTP 404). Your message was not saved. Check the configured model and try again.",
      "未找到请求的模型或接口（HTTP 404），本条消息未保存。请检查模型配置后重试。",
    );
  }
  if (status === 408 || status === 504) {
    return formatBilingualUserMessage(
      `The model request timed out (HTTP ${status}). Your message was not saved. Please try again in a moment.`,
      `模型请求超时（HTTP ${status}），本条消息未保存。请稍后再试。`,
    );
  }
  if (status === 429) {
    return formatBilingualUserMessage(
      "The model provider is rate-limiting requests (HTTP 429). Your message was not saved. Please wait a moment and try again.",
      "模型服务触发限流（HTTP 429），本条消息未保存。请稍后再试。",
    );
  }
  if (status >= 500) {
    return formatBilingualUserMessage(
      `The model service is temporarily unavailable (HTTP ${status}). Your message was not saved. Please try again in a moment.`,
      `模型服务暂时不可用（HTTP ${status}），本条消息未保存。请稍后再试。`,
    );
  }
  if (status === 400 || status === 422) {
    return formatBilingualUserMessage(
      "The model provider rejected this request. Your message was not saved. Adjust the request and try again.",
      "模型服务拒绝了本次请求，本条消息未保存。请调整请求内容后重试。",
    );
  }
  return formatBilingualUserMessage(
    `The model request failed (HTTP ${status}). Your message was not saved. Please try again.`,
    `模型请求失败（HTTP ${status}），本条消息未保存。请重试。`,
  );
}

export function extractHttpStatusFromErrorText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const leading = extractLeadingHttpStatus(trimmed);
  if (leading) {
    return leading.code;
  }
  const statusCodeMatch = trimmed.match(/\bstatus code:\s*(\d{3})\b/i);
  if (statusCodeMatch?.[1]) {
    return Number.parseInt(statusCodeMatch[1], 10);
  }
  const httpMatch = trimmed.match(/\bhttp\s*(\d{3})\b/i);
  if (httpMatch?.[1]) {
    return Number.parseInt(httpMatch[1], 10);
  }
  return undefined;
}

// applyFallbackVars 把兜底文案里的 curl 风格变量 %{name} 替换为本次错误的真实值。
// 支持:%{http_code}（HTTP 状态码）、%{error_type}、%{error_message}、%{request_id}。
// 未知变量原样保留;无 %{...} 时零开销直接返回。
export function applyFallbackVars(template: string, rawErr: string): string {
  if (!template.includes("%{")) {
    return template;
  }
  const info = parseApiErrorInfo(rawErr);
  const status = extractHttpStatusFromErrorText(rawErr) ?? extractLeadingHttpStatus(rawErr)?.code;
  const vars: Record<string, string> = {
    http_code: status !== undefined ? String(status) : (info?.httpCode ?? ""),
    error_type: info?.type ?? "",
    error_message: info?.message ?? "",
    request_id: info?.requestId ?? "",
  };
  return template.replace(/%\{(\w+)\}/g, (match, name: string) =>
    name in vars ? vars[name] : match,
  );
}

export function formatRawAssistantErrorForUi(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  const fallback = userFacingFallbackText(trimmed);
  if (fallback !== null) {
    // 该状态码已在 env.vars 配置兜底文案 → 用它;%{http_code} 等变量替换为真实值;
    // 原始详情仍在 provider-http-error 日志可查。未配置的状态码不走这里,落到下方原始错误。
    return applyFallbackVars(fallback, trimmed);
  }
  if (!trimmed) {
    return "LLM request failed with an unknown error.";
  }

  if (trimmed === MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE) {
    return MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE;
  }

  if (isGenericProviderInternalError(trimmed)) {
    return GENERIC_PROVIDER_INTERNAL_ERROR_USER_MESSAGE;
  }

  const leadingStatus = extractLeadingHttpStatus(trimmed);
  const isHtmlChallenge = isCloudflareOrHtmlErrorPage(trimmed);
  // XCPH: 未在 env.vars 配置该状态码 → 不再用硬编码的英文/中文按类文案,直接落到下方
  // 解析出的「HTTP <code> <type>: <provider 真实 message>」即原始错误信息。
  if (leadingStatus && isHtmlChallenge) {
    return `The AI service is temporarily unavailable (HTTP ${leadingStatus.code}). Please try again in a moment.`;
  }

  if (isHtmlChallenge) {
    return (
      "The provider returned an HTML error page instead of an API response. " +
      "This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. " +
      "Retry in a moment or check provider status."
    );
  }

  const httpMatch = trimmed.match(HTTP_STATUS_PREFIX_RE);
  if (httpMatch) {
    const rest = httpMatch[2].trim();
    if (!rest.startsWith("{")) {
      return `HTTP ${httpMatch[1]}: ${rest}`;
    }
  }

  const info = parseApiErrorInfo(trimmed);
  if (info?.message) {
    const prefix = info.httpCode ? `HTTP ${info.httpCode}` : "LLM error";
    const type = info.type ? ` ${info.type}` : "";
    return `${prefix}${type}: ${info.message}`;
  }

  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}
