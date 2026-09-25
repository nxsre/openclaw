// Defines cron scheduling configuration types.

import type { z } from "zod";
import type { CronDelivery } from "../cron/types.js";
import type { SecretInput } from "./types.secrets.js";
import type { SsrFPolicyConfig } from "./types.ssrf.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

type CronSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.cron>>;

export type CronFailureAlertConfig = NonNullable<CronSchemaInput["failureAlert"]>;

export type CronFailureDestinationConfig = Pick<
  CronFailureAlertConfig,
  "channel" | "to" | "accountId" | "mode"
>;

export type CronConfig = Omit<CronSchemaInput, "webhookToken" | "webhookSsrfPolicy"> & {
  /** Bearer token for cron webhook POST delivery. */
  webhookToken?: SecretInput;
  /** SSRF policy for all outbound cron webhook deliveries. */
  webhookSsrfPolicy?: SsrFPolicyConfig;
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
