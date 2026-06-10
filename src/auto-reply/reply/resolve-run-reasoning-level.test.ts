import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  resolveAgentReasoningStateAccess,
  resolveRunReasoningLevel,
} from "./resolve-run-reasoning-level.js";

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("resolveRunReasoningLevel", () => {
  it("uses session reasoningLevel when caller can access reasoning state", () => {
    const result = resolveRunReasoningLevel({
      message: "hello",
      cfg: {},
      agentId: "main",
      sessionEntry: makeSessionEntry({ reasoningLevel: "stream" }),
      canUseReasoningState: true,
    });
    expect(result.reasoningLevel).toBe("stream");
  });

  it("honors /reasoning stream directive over session default", () => {
    const result = resolveRunReasoningLevel({
      message: "/reasoning stream\n\nhi",
      cfg: {},
      agentId: "main",
      sessionEntry: makeSessionEntry({ reasoningLevel: "off" }),
      canUseReasoningState: true,
    });
    expect(result.reasoningLevel).toBe("stream");
    expect(result.shouldPersistReasoningToSession).toBe(true);
  });

  it("falls back to agents.defaults.reasoningDefault", () => {
    const cfg = {
      agents: {
        defaults: {
          reasoningDefault: "stream",
        },
      },
    } satisfies OpenClawConfig;
    const result = resolveRunReasoningLevel({
      message: "hello",
      cfg,
      agentId: "main",
      sessionEntry: makeSessionEntry(),
      canUseReasoningState: true,
    });
    expect(result.reasoningLevel).toBe("stream");
  });

  it("keeps configured stream default for unauthorized callers", () => {
    const cfg = {
      agents: {
        defaults: {
          reasoningDefault: "stream",
        },
      },
    } satisfies OpenClawConfig;
    const result = resolveRunReasoningLevel({
      message: "hello",
      cfg,
      agentId: "main",
      sessionEntry: makeSessionEntry(),
      canUseReasoningState: false,
    });
    expect(result.reasoningLevel).toBe("stream");
  });

  it("blocks non-stream configured defaults for unauthorized callers", () => {
    const cfg = {
      agents: {
        defaults: {
          reasoningDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const result = resolveRunReasoningLevel({
      message: "hello",
      cfg,
      agentId: "main",
      sessionEntry: makeSessionEntry(),
      canUseReasoningState: false,
    });
    expect(result.reasoningLevel).toBe("off");
  });
});

describe("resolveAgentReasoningStateAccess", () => {
  it("allows owner callers", () => {
    expect(resolveAgentReasoningStateAccess({ senderIsOwner: true })).toBe(true);
  });

  it("allows gateway operator.admin scopes", () => {
    expect(
      resolveAgentReasoningStateAccess({
        gatewayClientScopes: ["operator.read", "operator.admin"],
      }),
    ).toBe(true);
  });
});
