/** Higher-level agent scope helpers for model selection, fallbacks, skills, and workspaces. */
import fs from "node:fs";
import path from "node:path";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
export { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import {
  lowercasePreservingWhitespace,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { resolveEffectiveAgentSkillFilter } from "../skills/discovery/agent-filter.js";
import { resolveUserPath } from "../utils.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope-config.js";
export {
  listAgentEntries,
  listAgentIds,
  resolveAgentConfig,
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveDefaultAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  type ResolvedAgentConfig,
} from "./agent-scope-config.js";

/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s: string): string {
  return s.split("\0").join("");
}

/** Identity seed files copied into a per-group workspace (never memory). */
const GROUP_IDENTITY_SEED_FILES = ["AGENTS.md", "SOUL.md", "USER.md"] as const;

/**
 * Sanitize one path segment so it cannot escape the workspace root.
 * Keeps only [A-Za-z0-9_.-]; returns empty string when nothing remains.
 */
export function sanitizeSegment(value: string): string {
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9_.-]/g, "");
  // Guard against "." / ".." / leading-dot traversal once non-alnum chars are stripped.
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "";
  }
  return cleaned;
}

/**
 * Extract a group id from a session key of the form
 * `agent:<agentId>:<channel>:group:<gid...>` or `<channel>:group:<gid...>`
 * (also handles the `:channel:` peer kind). Returns the joined remainder after
 * the first group/channel marker, or undefined when no marker is present.
 */
export function extractGroupId(sessionKey: string | undefined | null): string | undefined {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return undefined;
  }
  const segments = raw.split(":");
  for (let i = 0; i < segments.length - 1; i += 1) {
    const marker = segments[i].toLowerCase();
    if (marker === "group" || marker === "channel") {
      // Everything after the marker forms the group id; peer ids can contain
      // their own separators, so keep the remainder and let sanitizeSegment
      // collapse it to a filesystem-safe token.
      const remainder = segments.slice(i + 1).join("_");
      return remainder || undefined;
    }
  }
  return undefined;
}

/** True when a session is a group/channel chat (by entry chatType or key shape). */
function isGroupLikeSession(params: {
  sessionKey?: string | null;
  chatType?: SessionEntry["chatType"];
}): boolean {
  if (params.chatType === "group" || params.chatType === "channel") {
    return true;
  }
  const raw = normalizeOptionalString(params.sessionKey);
  if (!raw) {
    return false;
  }
  const lowered = raw.toLowerCase();
  return lowered.includes(":group:") || lowered.includes(":channel:");
}

/**
 * Resolve the workspace directory for a session, isolating group/channel chats
 * into a per-group subdirectory (`<base>/groups/<gid>`) so each group has its
 * own memory/, MEMORY.md, and workspace files. Direct/main/non-group sessions
 * return the unchanged agent base workspace.
 *
 * On first access to a group workspace, the directory is created and identity
 * seed files (AGENTS.md/SOUL.md/USER.md) are copied from the base workspace if
 * missing — memory (MEMORY.md / memory/) is intentionally NOT copied so each
 * group starts with a blank, isolated memory. Any failure falls back to base.
 */
export function resolveSessionWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
  sessionKey?: string | null,
  sessionEntry?: Pick<SessionEntry, "chatType"> | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = resolveAgentWorkspaceDir(cfg, agentId, env);
  try {
    if (!isGroupLikeSession({ sessionKey, chatType: sessionEntry?.chatType })) {
      return base;
    }
    const gid = extractGroupId(sessionKey);
    const safeGid = gid ? sanitizeSegment(gid) : "";
    if (!safeGid) {
      return base;
    }
    const groupDir = stripNullBytes(path.join(base, "groups", safeGid));
    ensureGroupWorkspaceSeeded(base, groupDir);
    return groupDir;
  } catch {
    return base;
  }
}

/**
 * Resolve the filesystem-safe group token for a session key, or undefined for
 * direct/main/non-group sessions. This is a pure helper (no filesystem side
 * effects) used to scope per-group memory collections/caches in lockstep with
 * `resolveSessionWorkspaceDir`. Any malformed input collapses to undefined so
 * callers fall back to the unscoped (per-agent) path. Never throws.
 */
export function resolveSessionMemoryGroupSegment(
  sessionKey?: string | null,
  sessionEntry?: Pick<SessionEntry, "chatType"> | null,
): string | undefined {
  try {
    if (!isGroupLikeSession({ sessionKey, chatType: sessionEntry?.chatType })) {
      return undefined;
    }
    const gid = extractGroupId(sessionKey);
    const safeGid = gid ? sanitizeSegment(gid) : "";
    return safeGid || undefined;
  } catch {
    return undefined;
  }
}

/** Create the group workspace and copy identity seeds from base when missing. */
function ensureGroupWorkspaceSeeded(baseDir: string, groupDir: string): void {
  try {
    fs.mkdirSync(groupDir, { recursive: true });
  } catch {
    // If we cannot create the directory, the caller falls back to base.
    throw new Error("group workspace mkdir failed");
  }
  for (const name of GROUP_IDENTITY_SEED_FILES) {
    try {
      const dest = path.join(groupDir, name);
      if (fs.existsSync(dest)) {
        continue;
      }
      const src = path.join(baseDir, name);
      if (!fs.existsSync(src)) {
        continue;
      }
      fs.copyFileSync(src, dest);
    } catch {
      // Best-effort seeding; a missing identity file must not break the run.
    }
  }
}

const AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_FALLBACK_PRIMARY_PROBE_MAX_KEYS = 4096;
const autoFallbackPrimaryProbeState = new Map<string, number>();

function autoFallbackPrimaryProbeStateKey(params: {
  sessionKey?: string | null;
  primaryProvider: string;
  primaryModel: string;
}): string {
  return [
    normalizeOptionalString(params.sessionKey) ?? "",
    `${params.primaryProvider}/${params.primaryModel}`,
  ].join("\0");
}

function pruneAutoFallbackPrimaryProbeState(params: {
  state: Map<string, number>;
  now: number;
  minIntervalMs: number;
  maxKeys?: number;
}): void {
  const maxKeys = Math.max(1, Math.trunc(params.maxKeys ?? AUTO_FALLBACK_PRIMARY_PROBE_MAX_KEYS));
  const staleBefore = params.now - params.minIntervalMs;
  for (const [key, lastProbeAt] of params.state) {
    if (!Number.isFinite(lastProbeAt) || lastProbeAt < staleBefore) {
      params.state.delete(key);
    }
  }
  if (params.state.size <= maxKeys) {
    return;
  }
  const removeCount = params.state.size - maxKeys;
  let removed = 0;
  for (const key of params.state.keys()) {
    params.state.delete(key);
    removed += 1;
    if (removed >= removeCount) {
      break;
    }
  }
}

/** Primary model probe metadata used to validate auto-fallback recovery. */
export type AutoFallbackPrimaryProbe = {
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackAuthProfileId?: string;
  fallbackAuthProfileIdSource?: "auto" | "user";
};

/** Detects old auto-fallback session entries that lack primary-origin metadata. */
export function hasLegacyAutoFallbackWithoutOrigin(
  entry:
    | Pick<
        SessionEntry,
        | "modelOverrideSource"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
      >
    | null
    | undefined,
): boolean {
  return (
    entry?.modelOverrideSource === "auto" &&
    (!normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) ||
      !normalizeOptionalString(entry.modelOverrideFallbackOriginModel))
  );
}

export function resolveAutoFallbackPrimaryProbe(params: {
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelOverrideSource"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
        | "authProfileOverride"
        | "authProfileOverrideSource"
        | "authProfileOverrideCompactionCount"
      >
    | null
    | undefined;
  sessionKey?: string | null;
  primaryProvider: string;
  primaryModel: string;
  now?: number;
  minIntervalMs?: number;
  maxTrackedProbeKeys?: number;
  probeState?: Map<string, number>;
}): AutoFallbackPrimaryProbe | undefined {
  const entry = params.entry;
  if (!entry) {
    return undefined;
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return undefined;
  }

  const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
  const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  const overrideProvider = normalizeOptionalString(entry.providerOverride);
  const overrideModel = normalizeOptionalString(entry.modelOverride);
  const primaryProvider = normalizeOptionalString(params.primaryProvider);
  const primaryModel = normalizeOptionalString(params.primaryModel);
  if (!originProvider || !originModel || !overrideProvider || !overrideModel) {
    return undefined;
  }
  if (!primaryProvider || !primaryModel) {
    return undefined;
  }
  if (originProvider !== primaryProvider || originModel !== primaryModel) {
    return undefined;
  }
  if (overrideProvider === originProvider && overrideModel === originModel) {
    return undefined;
  }

  const now = params.now ?? Date.now();
  const minIntervalMs = params.minIntervalMs ?? AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS;
  const state = params.probeState ?? autoFallbackPrimaryProbeState;
  pruneAutoFallbackPrimaryProbeState({
    state,
    now,
    minIntervalMs,
    maxKeys: params.maxTrackedProbeKeys,
  });
  const key = autoFallbackPrimaryProbeStateKey({
    sessionKey: params.sessionKey,
    primaryProvider: originProvider,
    primaryModel: originModel,
  });
  const lastProbeAt = state.get(key);
  if (
    typeof lastProbeAt === "number" &&
    Number.isFinite(lastProbeAt) &&
    now - lastProbeAt < minIntervalMs
  ) {
    return undefined;
  }
  const fallbackAuthProfileId = normalizeOptionalString(entry.authProfileOverride);
  const fallbackAuthProfileIdSource =
    entry.authProfileOverrideSource ??
    (entry.authProfileOverrideCompactionCount !== undefined ? "auto" : undefined);
  return {
    provider: originProvider,
    model: originModel,
    fallbackProvider: overrideProvider,
    fallbackModel: overrideModel,
    ...(fallbackAuthProfileId
      ? {
          fallbackAuthProfileId,
          ...(fallbackAuthProfileIdSource ? { fallbackAuthProfileIdSource } : {}),
        }
      : {}),
  };
}

export function markAutoFallbackPrimaryProbe(params: {
  probe: AutoFallbackPrimaryProbe;
  sessionKey?: string | null;
  now?: number;
  minIntervalMs?: number;
  maxTrackedProbeKeys?: number;
  probeState?: Map<string, number>;
}): void {
  const now = params.now ?? Date.now();
  const minIntervalMs = params.minIntervalMs ?? AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS;
  const state = params.probeState ?? autoFallbackPrimaryProbeState;
  pruneAutoFallbackPrimaryProbeState({
    state,
    now,
    minIntervalMs,
    maxKeys: params.maxTrackedProbeKeys,
  });
  const key = autoFallbackPrimaryProbeStateKey({
    sessionKey: params.sessionKey,
    primaryProvider: params.probe.provider,
    primaryModel: params.probe.model,
  });
  state.set(key, now);
  pruneAutoFallbackPrimaryProbeState({
    state,
    now,
    minIntervalMs,
    maxKeys: params.maxTrackedProbeKeys,
  });
}

export function entryMatchesAutoFallbackPrimaryProbe(
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelOverrideSource"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
      >
    | null
    | undefined,
  probe: AutoFallbackPrimaryProbe,
): boolean {
  if (!entry) {
    return false;
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return false;
  }
  return (
    normalizeOptionalString(entry.providerOverride) === probe.fallbackProvider &&
    normalizeOptionalString(entry.modelOverride) === probe.fallbackModel &&
    normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) === probe.provider &&
    normalizeOptionalString(entry.modelOverrideFallbackOriginModel) === probe.model
  );
}

export function clearAutoFallbackPrimaryProbeSelection(
  entry: SessionEntry,
  now = Date.now(),
): void {
  delete entry.providerOverride;
  delete entry.modelOverride;
  delete entry.modelOverrideSource;
  delete entry.modelOverrideFallbackOriginProvider;
  delete entry.modelOverrideFallbackOriginModel;
  if (
    entry.authProfileOverrideSource === "auto" ||
    (entry.authProfileOverrideSource === undefined &&
      entry.authProfileOverrideCompactionCount !== undefined)
  ) {
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
  }
  delete entry.fallbackNoticeSelectedModel;
  delete entry.fallbackNoticeActiveModel;
  delete entry.fallbackNoticeReason;
  entry.updatedAt = now;
}

export { resolveAgentIdFromSessionKey };

export function resolveSessionAgentIds(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string;
  fallbackAgentId?: string;
}): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
  const explicitAgentIdRaw = normalizeLowercaseStringOrEmpty(params.agentId);
  const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
  const fallbackAgentIdRaw = normalizeLowercaseStringOrEmpty(params.fallbackAgentId);
  const fallbackAgentId = fallbackAgentIdRaw ? normalizeAgentId(fallbackAgentIdRaw) : null;
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? normalizeLowercaseStringOrEmpty(sessionKey) : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  const sessionAgentId =
    explicitAgentId ??
    (parsed?.agentId ? normalizeAgentId(parsed.agentId) : (fallbackAgentId ?? defaultAgentId));
  return { defaultAgentId, sessionAgentId };
}

export function resolveSessionAgentId(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string;
  fallbackAgentId?: string;
}): string {
  return resolveSessionAgentIds(params).sessionAgentId;
}

export function resolveAgentExecutionContract(
  cfg: OpenClawConfig | undefined,
  agentId?: string | null,
): NonNullable<NonNullable<AgentDefaultsConfig["embeddedAgent"]>["executionContract"]> | undefined {
  const defaultContract = cfg?.agents?.defaults?.embeddedAgent?.executionContract;
  if (!cfg || !agentId) {
    return defaultContract;
  }
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const agentContract = agentConfig?.embeddedAgent?.executionContract;
  return agentContract ?? defaultContract;
}

export function resolveAgentSkillsFilter(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  return resolveEffectiveAgentSkillFilter(cfg, agentId);
}

export function resolveAgentExplicitModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  return resolvePrimaryStringValue(raw);
}

export function resolveAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  return (
    resolveAgentExplicitModelPrimary(cfg, agentId) ??
    resolvePrimaryStringValue(cfg.agents?.defaults?.model)
  );
}

function findMutableAgentEntry(cfg: OpenClawConfig, agentId: string): AgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  return cfg.agents?.list?.find((entry) => normalizeAgentId(entry?.id) === id);
}

function updateAgentModelPrimary(
  existing: AgentModelConfig | undefined,
  primary: string,
): AgentModelConfig {
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return { ...existing, primary };
  }
  return primary;
}

export type AgentModelPrimaryWriteTarget = "agent" | "defaults";

export function setAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
  primary: string,
): AgentModelPrimaryWriteTarget {
  const id = normalizeAgentId(agentId);
  if (resolveAgentExplicitModelPrimary(cfg, id)) {
    const entry = findMutableAgentEntry(cfg, id);
    if (entry) {
      entry.model = updateAgentModelPrimary(entry.model, primary);
      return "agent";
    }
  }
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.model = updateAgentModelPrimary(cfg.agents.defaults.model, primary);
  return "defaults";
}

/** @deprecated Prefer explicit/effective helpers at new call sites. */
export function resolveAgentModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined {
  return resolveAgentExplicitModelPrimary(cfg, agentId);
}

export function resolveAgentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  return resolveSelectedModelFallbacksOverride(resolveAgentConfig(cfg, agentId)?.model);
}

function resolveSelectedModelFallbacksOverride(
  raw: AgentModelConfig | undefined,
): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === "string") {
    return resolvePrimaryStringValue(raw) ? [] : undefined;
  }
  // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
  if (!Object.hasOwn(raw, "fallbacks")) {
    return Object.hasOwn(raw, "primary") && resolvePrimaryStringValue(raw) ? [] : undefined;
  }
  return Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined;
}

function resolveFirstModelFallbacksOverride(
  candidates: Array<AgentModelConfig | undefined>,
): string[] | undefined {
  for (const candidate of candidates) {
    const fallbackOverride = resolveSelectedModelFallbacksOverride(candidate);
    if (fallbackOverride !== undefined) {
      return fallbackOverride;
    }
  }
  return undefined;
}

export type SubagentModelConfigSelectionSource = "subagent" | "agent" | "default-subagent";

export type SubagentModelConfigSelectionResult = {
  raw: AgentModelConfig;
  source: SubagentModelConfigSelectionSource;
};

export function resolveSubagentModelConfigSelectionResult(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): SubagentModelConfigSelectionResult | undefined {
  const agentConfig =
    params.agentConfigOverride ??
    (params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined);
  const candidates: SubagentModelConfigSelectionResult[] = [
    ...(agentConfig?.subagents?.model
      ? [{ raw: agentConfig.subagents.model, source: "subagent" as const }]
      : []),
    ...(agentConfig?.model ? [{ raw: agentConfig.model, source: "agent" as const }] : []),
    ...(params.cfg.agents?.defaults?.subagents?.model
      ? [
          {
            raw: params.cfg.agents.defaults.subagents.model,
            source: "default-subagent" as const,
          },
        ]
      : []),
  ];
  return candidates.find((candidate) => resolvePrimaryStringValue(candidate.raw));
}

export function resolveSubagentModelConfigSelection(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): AgentModelConfig | undefined {
  return resolveSubagentModelConfigSelectionResult(params)?.raw;
}

export function resolveSubagentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const subagentFallbacks = resolveSelectedModelFallbacksOverride(agentConfig?.subagents?.model);
  if (subagentFallbacks !== undefined) {
    return subagentFallbacks;
  }
  const selection = resolveSubagentModelConfigSelectionResult({ cfg, agentId });
  if (selection?.source === "agent") {
    return resolveSelectedModelFallbacksOverride(agentConfig?.model);
  }
  if (selection?.source === "default-subagent") {
    return resolveSelectedModelFallbacksOverride(cfg.agents?.defaults?.subagents?.model);
  }
  return undefined;
}

function resolveSubagentSpawnModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  return resolveFirstModelFallbacksOverride([
    agentConfig?.subagents?.model,
    cfg.agents?.defaults?.subagents?.model,
    agentConfig?.model,
  ]);
}

export function resolveFallbackAgentId(params: {
  agentId?: string | null;
  sessionKey?: string | null;
}): string {
  const explicitAgentId = normalizeOptionalString(params.agentId) ?? "";
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  return resolveAgentIdFromSessionKey(params.sessionKey);
}

export function resolveRunModelFallbacksOverride(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): string[] | undefined {
  if (!params.cfg) {
    return undefined;
  }
  return resolveAgentModelFallbacksOverride(
    params.cfg,
    resolveFallbackAgentId({ agentId: params.agentId, sessionKey: params.sessionKey }),
  );
}

export function hasConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): boolean {
  const fallbacksOverride = resolveRunModelFallbacksOverride(params);
  const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
  return (fallbacksOverride ?? defaultFallbacks).length > 0;
}

export function resolveEffectiveModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string | null;
  hasSessionModelOverride: boolean;
  modelOverrideSource?: "auto" | "user";
  hasAutoFallbackProvenance?: boolean;
}): string[] | undefined {
  const agentFallbacksOverride = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
  if (!params.hasSessionModelOverride) {
    return agentFallbacksOverride;
  }
  const canUseConfiguredFallbacks =
    params.modelOverrideSource === "auto" ||
    (params.modelOverrideSource === undefined && params.hasAutoFallbackProvenance === true);
  if (!canUseConfiguredFallbacks) {
    return [];
  }
  const subagentFallbacksOverride = isSubagentSessionKey(params.sessionKey)
    ? resolveSubagentSpawnModelFallbacksOverride(params.cfg, params.agentId)
    : undefined;
  if (subagentFallbacksOverride !== undefined) {
    return subagentFallbacksOverride;
  }
  const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  return agentFallbacksOverride ?? defaultFallbacks;
}

function normalizePathForComparison(input: string): string {
  const resolved = path.resolve(stripNullBytes(resolveUserPath(input)));
  let normalized = resolved;
  // Prefer realpath when available to normalize aliases/symlinks (for example /tmp -> /private/tmp)
  // and canonical path case without forcing case-folding on case-sensitive macOS volumes.
  try {
    normalized = fs.realpathSync.native(resolved);
  } catch {
    // Keep lexical path for non-existent directories.
  }
  if (process.platform === "win32") {
    return lowercasePreservingWhitespace(normalized);
  }
  return normalized;
}

export function resolveAgentIdsByWorkspacePath(
  cfg: OpenClawConfig,
  workspacePath: string,
): string[] {
  const normalizedWorkspacePath = normalizePathForComparison(workspacePath);
  const ids = listAgentIds(cfg);
  const matches: Array<{ id: string; workspaceDir: string; order: number }> = [];

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const workspaceDir = normalizePathForComparison(resolveAgentWorkspaceDir(cfg, id));
    if (!isPathInside(workspaceDir, normalizedWorkspacePath)) {
      continue;
    }
    matches.push({ id, workspaceDir, order: index });
  }

  matches.sort((left, right) => {
    const workspaceLengthDelta = right.workspaceDir.length - left.workspaceDir.length;
    if (workspaceLengthDelta !== 0) {
      return workspaceLengthDelta;
    }
    return left.order - right.order;
  });

  return matches.map((entry) => entry.id);
}

export function resolveAgentIdByWorkspacePath(
  cfg: OpenClawConfig,
  workspacePath: string,
): string | undefined {
  return resolveAgentIdsByWorkspacePath(cfg, workspacePath)[0];
}
