import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  resolveDefaultAgentWorkspaceDir,
  resolveStateDir,
  resolveUserPath,
  tryResolveLegacyDataOwner,
} from "./openclaw-runtime-paths.js";
import type { MemoryExtraPath } from "./types.js";
export { normalizeAgentId };

// Shared OpenClaw config helpers used by memory host and agent context code.

type DmScope = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
/** Citation injection behavior for memory search results. */
export type MemoryCitationsMode = "auto" | "on" | "off";

/** Top-level memory config shared by host and runtime callers. */
type MemoryConfig = {
  citations?: MemoryCitationsMode;
  search?: MemorySearchConfig;
};

/** Per-agent memory search enablement and extra collection paths. */
type MemorySearchConfig = {
  enabled?: boolean;
  rememberAcrossConversations?: boolean;
  extraPaths?: MemoryExtraPath[];
};

/** Trim and deduplicate configured extra-memory roots without losing pattern identity. */
export function normalizeConfiguredMemoryExtraPaths(
  extraPaths?: MemoryExtraPath[],
): MemoryExtraPath[] {
  const normalized = new Map<string, MemoryExtraPath>();
  for (const entry of extraPaths ?? []) {
    const configuredPath = (typeof entry === "string" ? entry : entry.path).trim();
    const pattern = typeof entry === "string" ? "" : entry.pattern?.trim() || "";
    if (configuredPath) {
      normalized.set(
        `${configuredPath}\0${pattern}`,
        pattern ? { path: configuredPath, pattern } : configuredPath,
      );
    }
  }
  return Array.from(normalized.values());
}

/** Agent context limits that bound memory file reads. */
type AgentContextLimitsConfig = {
  memoryGetMaxChars?: number;
};

/** Secret reference accepted by provider header config. */
type SecretInput =
  | string
  | {
      source: string;
      provider: string;
      id: string;
    };

/** Agent-level config fields consumed by memory host helpers. */
type AgentConfig = {
  id?: string;
  default?: boolean;
  workspace?: string;
  memory?: {
    search?: MemorySearchConfig;
  };
  contextLimits?: AgentContextLimitsConfig;
};

/** Narrow OpenClaw config shape consumed by memory host utilities. */
export type OpenClawConfig = {
  agents?: {
    ownership?: "explicit";
    defaults?: {
      workspace?: string;
      contextLimits?: AgentContextLimitsConfig;
    };
    entries?: Record<string, Omit<AgentConfig, "id">>;
    list?: AgentConfig[];
  };
  session?: {
    dmScope?: DmScope;
  };
  bindings?: unknown[];
  memory?: MemoryConfig;
  models?: {
    providers?: Record<
      string,
      {
        api?: string;
        baseUrl?: string;
        headers?: Record<string, SecretInput>;
      }
    >;
  };
};

export function resolveRememberAcrossConversations(cfg: OpenClawConfig, agentId: string): boolean {
  const defaults = cfg.memory?.search;
  const overrides = resolveAgentConfig(cfg, agentId)?.memory?.search;
  const explicit = overrides?.rememberAcrossConversations ?? defaults?.rememberAcrossConversations;
  if (explicit !== undefined) {
    return explicit;
  }
  // Recall is per-agent/private-shaped, not per-sender. Any DM isolation signals a
  // multi-user install, where silently recalling across senders would leak context.
  return (
    (cfg.session?.dmScope === undefined || cfg.session.dmScope === "main") &&
    !cfg.bindings?.some((binding) => {
      if (!binding || typeof binding !== "object") {
        return false;
      }
      const session = (binding as { session?: unknown }).session;
      return (
        Boolean(session) &&
        typeof session === "object" &&
        (session as { dmScope?: unknown }).dmScope !== undefined
      );
    })
  );
}

/** Root memory filename used in agent workspaces. */
export const MEMORY_HOST_ROOT_FILENAME = "MEMORY.md";

const DEFAULT_AGENT_ID = "main";

/** Return configured agent entries after dropping nullish placeholders. */
function listAgentEntries(cfg: OpenClawConfig): AgentConfig[] {
  if (cfg.agents?.entries) {
    return Object.entries(cfg.agents.entries).map(([id, entry]) => Object.assign({ id }, entry));
  }
  return Array.isArray(cfg.agents?.list)
    ? cfg.agents.list.filter((entry): entry is AgentConfig => Boolean(entry))
    : [];
}

/** Resolve the default agent id from explicit default marker or first agent entry. */
function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  const chosen = (agents.find((agent) => agent.default) ?? agents[0])?.id;
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

/** Find one agent config by canonical id. */
function resolveAgentConfig(cfg: OpenClawConfig, agentId: string): AgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

/** Remove null bytes before paths are handed to filesystem APIs. */
function stripNullBytes(value: string): string {
  return value.replaceAll("\0", "");
}

/** Resolve the workspace directory for an agent id and config defaults. */
export function resolveMemoryHostAgentWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) {
    return stripNullBytes(resolveUserPath(configured, env));
  }
  const fallback = cfg.agents?.defaults?.workspace?.trim();
  // Legacy reader inputs keep first-agent inheritance. Explicit ownership uses
  // the same legacy data owner as search, independently of the runtime default.
  const inheritedWorkspaceAgentId =
    cfg.agents?.ownership === "explicit"
      ? tryResolveLegacyDataOwner(cfg)
      : resolveDefaultAgentId(cfg);
  if (id === inheritedWorkspaceAgentId) {
    return stripNullBytes(
      fallback ? resolveUserPath(fallback, env) : resolveDefaultAgentWorkspaceDir(env),
    );
  }
  if (fallback) {
    return stripNullBytes(path.join(resolveUserPath(fallback, env), id));
  }
  return stripNullBytes(path.join(resolveStateDir(env), `workspace-${id}`));
}

/**
 * Sanitize one path segment so it cannot escape the workspace root. Mirrors the
 * host `sanitizeSegment` (src/agents/agent-scope.ts) exactly so the qmd group
 * collection directory matches the reply/dispatch group workspace bit-for-bit.
 */
function sanitizeGroupSegment(value: string): string {
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9_.-]/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "";
  }
  return cleaned;
}

/** Extract a group id from a session key. Mirrors the host `extractGroupId`. */
function extractGroupIdFromSessionKey(sessionKey: string | undefined | null): string | undefined {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return undefined;
  }
  const segments = raw.split(":");
  for (let i = 0; i < segments.length - 1; i += 1) {
    const marker = segments[i]?.toLowerCase();
    if (marker === "group" || marker === "channel") {
      const remainder = segments.slice(i + 1).join("_");
      return remainder || undefined;
    }
  }
  return undefined;
}

/** True when a session is a group/channel chat (by key shape). */
function isGroupLikeSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return false;
  }
  const lowered = raw.toLowerCase();
  return lowered.includes(":group:") || lowered.includes(":channel:");
}

/**
 * Resolve the workspace directory for a session, isolating group/channel chats
 * into a per-group subdirectory (`<base>/groups/<gid>`) so qmd indexes/recalls
 * that group's memory only. Mirrors the host `resolveSessionWorkspaceDir` path
 * convention (package-local to keep this SDK decoupled from the host config
 * type). Pure: no filesystem side effects — the dispatch path already seeds the
 * group dir. Direct/main/non-group sessions and malformed tokens return base.
 */
export function resolveSessionWorkspaceDir(
  _cfg: OpenClawConfig,
  _agentId: string,
  sessionKey?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = resolveDefaultAgentWorkspaceDir(env);
  try {
    if (!isGroupLikeSessionKey(sessionKey)) {
      return base;
    }
    const gid = extractGroupIdFromSessionKey(sessionKey);
    const safeGid = gid ? sanitizeGroupSegment(gid) : "";
    if (!safeGid) {
      return base;
    }
    return stripNullBytes(path.join(base, "groups", safeGid));
  } catch {
    return base;
  }
}

/** Resolve context limits for an agent with defaults fallback. */
export function resolveMemoryHostAgentContextLimits(
  cfg: OpenClawConfig | undefined,
  agentId?: string | null,
): AgentContextLimitsConfig | undefined {
  const defaults = cfg?.agents?.defaults?.contextLimits;
  if (!cfg || !agentId) {
    return defaults;
  }
  return resolveAgentConfig(cfg, agentId)?.contextLimits ?? defaults;
}

/** Resolve enabled memory search config plus deduplicated extra paths for an agent. */
export function resolveMemoryHostSearchPathConfig(
  cfg: OpenClawConfig,
  agentId: string,
): {
  enabled: boolean;
  rememberAcrossConversations: boolean;
  extraPaths: MemoryExtraPath[];
} | null {
  const defaults = cfg.memory?.search;
  const overrides = resolveAgentConfig(cfg, agentId)?.memory?.search;
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  const extraPaths = normalizeConfiguredMemoryExtraPaths([
    ...(defaults?.extraPaths ?? []),
    ...(overrides?.extraPaths ?? []),
  ]);
  return {
    enabled,
    rememberAcrossConversations: resolveRememberAcrossConversations(cfg, agentId),
    extraPaths,
  };
}
