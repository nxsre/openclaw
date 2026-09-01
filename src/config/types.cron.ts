// Defines cron scheduling configuration types.
import type { CronDelivery } from "../cron/types.js";
import type { SecretInput } from "./types.secrets.js";
import type { SsrFPolicyConfig } from "./types.ssrf.js";

export type CronFailureAlertConfig = {
  enabled?: boolean;
  after?: number;
  cooldownMs?: number;
  includeSkipped?: boolean;
  mode?: "announce" | "webhook";
  accountId?: string;
  channel?: string;
  to?: string;
};

export type CronFailureDestinationConfig = {
  channel?: string;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

export type CronConfig = {
  enabled?: boolean;
  triggers?: {
    enabled?: boolean;
  };
  /** Bearer token for cron webhook POST delivery. */
  webhookToken?: SecretInput;
  /** SSRF policy for all outbound cron webhook deliveries. */
  webhookSsrfPolicy?: SsrFPolicyConfig;
  /**
   * How long to retain completed cron run sessions before automatic pruning.
   * Accepts a duration string (e.g. "24h", "7d", "1h30m") or `false` to disable pruning.
   * A zero duration (e.g. "0h") also disables pruning; negative durations are invalid.
   * Default: "24h".
   */
  sessionRetention?: string | false;
  failureAlert?: CronFailureAlertConfig;
  /**
   * Default delivery applied to new isolated-like output jobs that are created
   * without their own `delivery` config. Lets operators broadcast scheduled
   * output to a fixed destination, e.g. every channel recipient via
   * `{ mode: "announce", targets: [{ channel: "openclaw-weixin", to: "all" }] }`.
   * Jobs that specify their own delivery always win. Limited to the primary
   * announce/none/webhook fields; per-job webhook completion/failure destinations
   * are not configurable as a global default.
   */
  defaultDelivery?: Pick<
    CronDelivery,
    "mode" | "channel" | "to" | "threadId" | "accountId" | "bestEffort" | "targets"
  >;
};
