// Cron delivery plan tests cover delivery target planning rules.
import { describe, expect, it } from "vitest";
import {
  hasExplicitCronDeliveryTarget,
  parseAllTarget,
  resolveCronDeliveryPlan,
  resolveCronDeliveryPlans,
} from "./delivery-plan.js";
import { makeCronJob } from "./delivery.test-helpers.js";

describe("resolveCronDeliveryPlan", () => {
  it("preserves explicit message target context for delivery.mode=none", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        name: "Cron Target Context",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: {
          mode: "none",
          channel: "telegram",
          to: "123:topic:42",
          threadId: 42,
          accountId: "ops",
        },
      }),
    );

    expect(plan).toEqual({
      mode: "none",
      channel: "telegram",
      to: "123:topic:42",
      threadId: 42,
      accountId: "ops",
      source: "delivery",
      requested: false,
    });
  });

  it("treats numeric zero thread id as an explicit target", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: {
          mode: "none",
          threadId: 0,
        },
      }),
    );

    expect(plan.threadId).toBe(0);
    expect(hasExplicitCronDeliveryTarget(plan)).toBe(true);
  });
});

describe("resolveCronDeliveryPlans", () => {
  it("returns a single plan when no targets are set", () => {
    const plans = resolveCronDeliveryPlans(
      makeCronJob({ delivery: { mode: "announce", channel: "telegram", to: "111" } }),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ mode: "announce", channel: "telegram", to: "111" });
  });

  it("expands announce delivery.targets into one plan per target", () => {
    const plans = resolveCronDeliveryPlans(
      makeCronJob({
        delivery: {
          mode: "announce",
          // Top-level channel/to is ignored once targets are present.
          channel: "last",
          targets: [
            { channel: "telegram", to: "111", accountId: "ops" },
            { channel: "slack", to: "C42" },
          ],
        },
      }),
    );
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "111",
      accountId: "ops",
      requested: true,
    });
    expect(plans[1]).toMatchObject({
      mode: "announce",
      channel: "slack",
      to: "C42",
      requested: true,
    });
  });

  it("ignores targets when delivery mode is not announce", () => {
    const plans = resolveCronDeliveryPlans(
      makeCronJob({
        delivery: { mode: "none", targets: [{ channel: "telegram", to: "111" }] },
      }),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.mode).toBe("none");
  });
});

describe("parseAllTarget", () => {
  it("recognizes the bare all wildcard", () => {
    expect(parseAllTarget("all")).toEqual({ isAll: true });
    expect(parseAllTarget("ALL")).toEqual({ isAll: true });
  });

  it("recognizes a prefixed all wildcard and returns the prefix", () => {
    expect(parseAllTarget("user:all")).toEqual({ isAll: true, prefix: "user" });
    expect(parseAllTarget("c2c:all")).toEqual({ isAll: true, prefix: "c2c" });
  });

  it("treats concrete recipients and empties as not-all", () => {
    expect(parseAllTarget("user:alice").isAll).toBe(false);
    expect(parseAllTarget("alice").isAll).toBe(false);
    expect(parseAllTarget(undefined).isAll).toBe(false);
    expect(parseAllTarget("").isAll).toBe(false);
  });
});
