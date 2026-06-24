// Fan-out delivery tests cover broadcasting one cron announce to many targets.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronDeliveryPlan } from "./delivery-plan.js";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
  sendDurableMessageBatch: vi.fn(),
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({ kind: "identity" }),
  buildOutboundSessionContext: vi.fn().mockReturnValue({ kind: "session" }),
  createOutboundSendDeps: vi.fn().mockReturnValue({ kind: "deps" }),
  listSessionEntries: vi.fn(() => [] as Array<{ sessionKey: string; entry: unknown }>),
  getLoadedChannelPluginForRead: vi.fn(() => undefined as unknown),
  warn: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

vi.mock("../config/sessions/store.js", () => ({
  listSessionEntries: mocks.listSessionEntries,
}));

vi.mock("../channels/plugins/registry-loaded-read.js", () => ({
  getLoadedChannelPluginForRead: mocks.getLoadedChannelPluginForRead,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: { kind: "runtime" },
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatch: mocks.sendDurableMessageBatch,
}));

vi.mock("../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: mocks.resolveAgentOutboundIdentity,
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: mocks.buildOutboundSessionContext,
}));

vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: mocks.createOutboundSendDeps,
}));

vi.mock("../logging.js", () => ({
  getChildLogger: vi.fn(() => ({ warn: mocks.warn })),
}));

const { fanOutAdditionalCronAnnounceTargets, expandCronDeliveryPlans } =
  await import("./delivery.js");

function announcePlan(channel: string, to: string): CronDeliveryPlan {
  return { mode: "announce", channel, to, source: "delivery", requested: true };
}

function sessionEntry(channel: string, to: string, accountId?: string) {
  return {
    sessionKey: `k:${to}`,
    entry: { lastChannel: channel, lastTo: to, lastAccountId: accountId },
  };
}

function callFanOut(additionalPlans: CronDeliveryPlan[]) {
  return fanOutAdditionalCronAnnounceTargets({
    deps: {} as never,
    cfg: {} as never,
    agentId: "main",
    jobId: "job-1",
    message: "take medication",
    additionalPlans,
    abortSignal: new AbortController().signal,
  });
}

describe("fanOutAdditionalCronAnnounceTargets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDeliveryTarget.mockImplementation(
      async (_cfg: unknown, _agentId: unknown, target: { channel?: string; to?: string }) => ({
        ok: true,
        channel: target.channel,
        to: target.to,
        accountId: undefined,
        threadId: undefined,
        mode: "explicit",
      }),
    );
    mocks.sendDurableMessageBatch.mockResolvedValue({ status: "ok" });
  });

  it("delivers the same message to every announce target", async () => {
    const result = await callFanOut([
      announcePlan("telegram", "111"),
      announcePlan("slack", "C42"),
    ]);

    expect(result).toEqual({ attempted: true, delivered: 2, failures: [] });
    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledTimes(2);
    const channels = mocks.sendDurableMessageBatch.mock.calls.map(
      ([request]) => (request as { channel?: string }).channel,
    );
    expect(channels).toEqual(["telegram", "slack"]);
  });

  it("continues past a failing target and records the failure", async () => {
    mocks.sendDurableMessageBatch
      .mockResolvedValueOnce({ status: "failed", error: new Error("slack down") })
      .mockResolvedValueOnce({ status: "ok" });

    const result = await callFanOut([
      announcePlan("slack", "C42"),
      announcePlan("telegram", "111"),
    ]);

    expect(result.attempted).toBe(true);
    expect(result.delivered).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("slack");
    // The second target is still attempted after the first one fails.
    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledTimes(2);
  });

  it("skips non-announce plans without attempting delivery", async () => {
    const result = await callFanOut([{ mode: "none", source: "delivery", requested: false }]);

    expect(result).toEqual({ attempted: false, delivered: 0, failures: [] });
    expect(mocks.sendDurableMessageBatch).not.toHaveBeenCalled();
  });
});

describe("expandCronDeliveryPlans", () => {
  const ctx = { cfg: {} as never, agentId: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLoadedChannelPluginForRead.mockReturnValue(undefined);
    mocks.listSessionEntries.mockReturnValue([]);
  });

  it("passes non-wildcard plans through unchanged", async () => {
    const plans = [announcePlan("telegram", "111"), announcePlan("slack", "C42")];
    expect(await expandCronDeliveryPlans(plans, ctx)).toEqual(plans);
  });

  it("expands to=all via the channel directory roster when available", async () => {
    mocks.getLoadedChannelPluginForRead.mockReturnValue({
      directory: {
        listPeers: vi.fn().mockResolvedValue([
          { kind: "user", id: "alice" },
          { kind: "user", id: "bob" },
        ]),
      },
    });
    const result = await expandCronDeliveryPlans([announcePlan("slack", "all")], ctx);
    expect(result.map((p) => p.to)).toEqual(["alice", "bob"]);
    expect(mocks.listSessionEntries).not.toHaveBeenCalled();
  });

  it("falls back to session peers when the channel has no directory", async () => {
    mocks.listSessionEntries.mockReturnValue([
      sessionEntry("openclaw-weixin", "a@im.wechat"),
      sessionEntry("openclaw-weixin", "b@im.wechat"),
      sessionEntry("openim", "user:zoe"), // other channel, excluded
    ]);
    const result = await expandCronDeliveryPlans([announcePlan("openclaw-weixin", "all")], ctx);
    expect(result.map((p) => p.to)).toEqual(["a@im.wechat", "b@im.wechat"]);
  });

  it("filters by addressing prefix for <prefix>:all", async () => {
    mocks.listSessionEntries.mockReturnValue([
      sessionEntry("openim", "user:alice"),
      sessionEntry("openim", "user:bob"),
      sessionEntry("openim", "group:team"),
    ]);
    const result = await expandCronDeliveryPlans([announcePlan("openim", "user:all")], ctx);
    expect(result.map((p) => p.to)).toEqual(["user:alice", "user:bob"]);
  });

  it("dedupes an explicit target overlapping an expanded all-target", async () => {
    mocks.listSessionEntries.mockReturnValue([
      sessionEntry("openim", "user:alice"),
      sessionEntry("openim", "user:bob"),
    ]);
    const result = await expandCronDeliveryPlans(
      [announcePlan("openim", "user:alice"), announcePlan("openim", "all")],
      ctx,
    );
    expect(result.map((p) => p.to)).toEqual(["user:alice", "user:bob"]);
  });

  it("drops an all-target without a concrete channel", async () => {
    const result = await expandCronDeliveryPlans([announcePlan("last", "all")], ctx);
    expect(result).toEqual([]);
  });
});
