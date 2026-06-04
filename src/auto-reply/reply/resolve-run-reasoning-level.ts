import { resolveAgentConfig } from "../../agents/agent-scope-config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { ReasoningLevel } from "../thinking.js";
import { parseInlineDirectives, type InlineDirectives } from "./directive-handling.parse.js";

export type ResolveRunReasoningLevelParams = {
  message: string;
  cfg: OpenClawConfig;
  agentId: string;
  sessionEntry?: SessionEntry | null;
  canUseReasoningState: boolean;
};

export type ResolveRunReasoningLevelResult = {
  reasoningLevel: ReasoningLevel;
  directives: InlineDirectives;
  shouldPersistReasoningToSession: boolean;
  reasoningLevelFromDirective?: ReasoningLevel;
};

/** Mirrors chat.send reasoning resolution in get-reply-directives. */
export function resolveRunReasoningLevel(
  params: ResolveRunReasoningLevelParams,
): ResolveRunReasoningLevelResult {
  const directives = parseInlineDirectives(params.message);
  const agentCfg = params.cfg.agents?.defaults;
  const agentEntry = resolveAgentConfig(params.cfg, params.agentId);
  const configuredReasoningDefault =
    (agentEntry?.reasoningDefault as ReasoningLevel | undefined) ??
    (agentCfg?.reasoningDefault as ReasoningLevel | undefined);
  const rawSessionReasoningLevel = params.sessionEntry?.reasoningLevel as
    | ReasoningLevel
    | null
    | undefined;
  const sessionReasoningLevel = params.canUseReasoningState ? rawSessionReasoningLevel : undefined;
  const reasoningUsesConfiguredDefault =
    directives.reasoningLevel === undefined &&
    sessionReasoningLevel == null &&
    configuredReasoningDefault != null;
  let reasoningLevel: ReasoningLevel =
    directives.reasoningLevel ?? sessionReasoningLevel ?? configuredReasoningDefault ?? "off";
  if (
    reasoningUsesConfiguredDefault &&
    !params.canUseReasoningState &&
    configuredReasoningDefault !== "stream"
  ) {
    reasoningLevel = "off";
  }
  return {
    reasoningLevel,
    directives,
    shouldPersistReasoningToSession:
      params.canUseReasoningState &&
      directives.hasReasoningDirective &&
      directives.reasoningLevel !== undefined,
    reasoningLevelFromDirective: directives.reasoningLevel,
  };
}

export function resolveAgentReasoningStateAccess(params: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: string[];
}): boolean {
  if (params.senderIsOwner === true) {
    return true;
  }
  const scopes = params.gatewayClientScopes;
  return Array.isArray(scopes) && scopes.includes("operator.admin");
}
