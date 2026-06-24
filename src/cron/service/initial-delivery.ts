/** Resolves create-time default delivery for new cron jobs. */
import type { CronDelivery, CronJobCreate } from "../types.js";

/**
 * Resolves default cron delivery for new jobs when callers omit explicit
 * delivery config. An explicit per-job delivery always wins. For isolated
 * agentTurn/command jobs the operator-configured `cron.defaultDelivery` applies
 * when set, otherwise delivery falls back to plain announce.
 */
export function resolveInitialCronDelivery(
  input: CronJobCreate,
  configDefault?: CronDelivery,
): CronDelivery | undefined {
  if (input.delivery) {
    return input.delivery;
  }
  if (
    input.sessionTarget === "isolated" &&
    (input.payload.kind === "agentTurn" || input.payload.kind === "command")
  ) {
    return configDefault ?? { mode: "announce" };
  }
  return undefined;
}
