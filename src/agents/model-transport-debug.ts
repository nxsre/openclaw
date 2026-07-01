/**
 * Environment-driven debug controls for model transport logging.
 *
 * Model adapters share these helpers so payload, SSE, and transport diagnostics
 * interpret OpenClaw debug environment variables consistently.
 */
import type { createSubsystemLogger } from "../logging/subsystem.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ModelTransportDebugEnv = NodeJS.ProcessEnv;

/** Payload debug detail levels accepted by `OPENCLAW_DEBUG_MODEL_PAYLOAD`. */
type ModelPayloadDebugMode = "off" | "summary" | "tools" | "full-redacted";
/** SSE debug detail levels accepted by `OPENCLAW_DEBUG_SSE`. */
type ModelSseDebugMode = "off" | "events" | "peek";

function normalizeEnv(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isTruthyEnv(value: unknown): boolean {
  const normalized = normalizeEnv(value);
  return (
    normalized.length > 0 &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off" &&
    normalized !== "no"
  );
}

/** Resolves model payload debug verbosity from `OPENCLAW_DEBUG_MODEL_PAYLOAD`. */
function isFalsyEnv(value: unknown): boolean {
  const normalized = normalizeEnv(value);
  return (
    normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no"
  );
}

export function resolveModelPayloadDebugMode(
  env: ModelTransportDebugEnv = process.env,
): ModelPayloadDebugMode {
  const normalized = normalizeEnv(env.OPENCLAW_DEBUG_MODEL_PAYLOAD);
  if (normalized === "tools" || normalized === "full-redacted") {
    return normalized;
  }
  if (normalized === "summary") {
    return "summary";
  }
  return "off";
}

/** Resolves SSE stream debug verbosity from `OPENCLAW_DEBUG_SSE`. */
export function resolveModelSseDebugMode(
  env: ModelTransportDebugEnv = process.env,
): ModelSseDebugMode {
  const normalized = normalizeEnv(env.OPENCLAW_DEBUG_SSE);
  if (normalized === "peek") {
    return "peek";
  }
  if (normalized === "events" || isTruthyEnv(normalized)) {
    return "events";
  }
  return "off";
}

/** Returns whether any model transport debug channel is enabled. */
export const DEFAULT_MODEL_HTTP_ERROR_BODY_DEBUG_LIMIT_BYTES = 4 * 1024 * 1024;

export function isModelHttpErrorBodyDebugEnabled(
  env: ModelTransportDebugEnv = process.env,
): boolean {
  const raw = env.OPENCLAW_DEBUG_MODEL_HTTP_ERROR_BODY;
  if (typeof raw === "string" && raw.trim().length > 0) {
    if (isFalsyEnv(raw)) {
      return false;
    }
    return isTruthyEnv(raw) || normalizeEnv(raw) === "raw";
  }
  // Default on: operators can disable with OPENCLAW_DEBUG_MODEL_HTTP_ERROR_BODY=0|off|false|no
  return true;
}

export function resolveModelHttpErrorBodyReadLimitBytes(
  env: ModelTransportDebugEnv = process.env,
): number {
  const raw = normalizeEnv(env.OPENCLAW_DEBUG_MODEL_HTTP_ERROR_BODY_LIMIT_BYTES);
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MODEL_HTTP_ERROR_BODY_DEBUG_LIMIT_BYTES;
}

export function shouldRedactModelHttpErrorBody(env: ModelTransportDebugEnv = process.env): boolean {
  return normalizeEnv(env.OPENCLAW_DEBUG_MODEL_HTTP_ERROR_BODY) !== "raw";
}

export function isModelTransportDebugEnabled(env: ModelTransportDebugEnv = process.env): boolean {
  return (
    isTruthyEnv(env.OPENCLAW_DEBUG_MODEL_TRANSPORT) ||
    resolveModelPayloadDebugMode(env) !== "off" ||
    resolveModelSseDebugMode(env) !== "off" ||
    isTruthyEnv(env.OPENCLAW_DEBUG_CODE_MODE)
  );
}

function isModelFetchMetadataMessage(message: string): boolean {
  return message.startsWith("[model-fetch]");
}

/** Emits model-fetch metadata at info level by default; other diagnostics require debug env. */
export function emitModelTransportDebug(log: SubsystemLogger, message: string): void {
  if (isModelFetchMetadataMessage(message) || isModelTransportDebugEnabled()) {
    log.info(message);
    return;
  }
  log.debug(message);
}
