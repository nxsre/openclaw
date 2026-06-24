// Initial cron delivery tests cover create-time default delivery resolution.
import { describe, expect, it } from "vitest";
import type { CronDelivery, CronJobCreate } from "../types.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";

const isolatedTurn = {
  name: "reminder",
  schedule: { kind: "at", at: "2026-06-25T22:16:00+08:00" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "remind me" },
} as unknown as CronJobCreate;

describe("resolveInitialCronDelivery", () => {
  it("returns the job's explicit delivery when set", () => {
    const explicit: CronDelivery = { mode: "announce", channel: "telegram", to: "123" };
    expect(
      resolveInitialCronDelivery({ ...isolatedTurn, delivery: explicit }, { mode: "none" }),
    ).toBe(explicit);
  });

  it("applies cron.defaultDelivery for isolated jobs without their own delivery", () => {
    const configDefault: CronDelivery = {
      mode: "announce",
      targets: [{ channel: "openclaw-weixin", to: "all" }],
    };
    const resolved = resolveInitialCronDelivery(isolatedTurn, configDefault);
    // Equal in value but a distinct object: the job must not alias the live config.
    expect(resolved).toEqual(configDefault);
    expect(resolved).not.toBe(configDefault);
  });

  it("falls back to plain announce when no config default is set", () => {
    expect(resolveInitialCronDelivery(isolatedTurn)).toEqual({ mode: "announce" });
  });

  it("does not apply the config default to main-session jobs", () => {
    const mainJob = {
      name: "wake",
      schedule: { kind: "at", at: "2026-06-25T22:16:00+08:00" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
    } as unknown as CronJobCreate;
    expect(resolveInitialCronDelivery(mainJob, { mode: "announce" })).toBeUndefined();
  });
});
