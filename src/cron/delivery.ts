/** Sends cron announce payloads and best-effort failure notifications. */

import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../channels/message/runtime.js";
import { getLoadedChannelPluginForRead } from "../channels/plugins/registry-loaded.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { resolveSessionStorePathCore } from "../config/sessions/inbound.runtime.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { NormalizedOutboundPayload } from "../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getChildLogger } from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import { CRON_DIRECT_DELIVERY_CONTEXT_KIND } from "../shared/transcript-only-openclaw-assistant.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../utils/delivery-context.shared.js";
import {
  parseAllTarget,
  resolveCronDeliveryPlan,
  resolveCronDeliveryPlans,
  type CronDeliveryPlan,
} from "./delivery-plan.js";
import {
  appendAdmittedDirectCronDeliveryTranscriptMirror,
  commitDirectCronOutboundRoute,
  projectDeliveredDirectCronPayloadsForMirror,
  resolveCronDeliveryRouteSessionKey,
  resolveDirectCronTranscriptMirrorText,
} from "./isolated-agent/delivery-dispatch-awareness.js";
import { buildDirectCronDeliveryIdempotencyKey } from "./isolated-agent/delivery-dispatch-policy.js";
import {
  resolveDeliveryTarget,
  type DeliveryTargetResolution,
} from "./isolated-agent/delivery-target.js";
import { resolveCronNotificationSessionKey } from "./session-target.js";
import type { CronJob, CronMessageChannel } from "./types.js";
export { resolveCronDeliveryPlan, resolveCronDeliveryPlans };
export type { CronDeliveryPlan };

const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });

/** Channel target metadata used for cron announcements and failure notifications. */
type CronAnnounceTarget = {
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
  sessionKey?: string;
  inheritSessionThread?: boolean;
};

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;
type CronAnnounceDeliveryOutcome = Extract<
  Awaited<ReturnType<typeof sendDurableMessageBatchCore>>,
  { status: "sent" | "suppressed" }
>;

async function resolveCronAnnounceDelivery(params: {
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
}): Promise<
  | {
      ok: true;
      resolvedTarget: SuccessfulDeliveryTarget;
      session: ReturnType<typeof buildOutboundSessionContext>;
      identity: ReturnType<typeof resolveAgentOutboundIdentity>;
    }
  | { ok: false; error: Error }
> {
  // Resolve the target before building outbound identity/session so send errors
  // report the configured route, not only the cron job id.
  const targetResolutionOptions =
    params.target.inheritSessionThread === false ? { inheritSessionThread: false } : undefined;
  const resolvedTarget = await resolveDeliveryTarget(
    params.cfg,
    params.agentId,
    {
      channel: params.target.channel as CronMessageChannel | undefined,
      to: params.target.to,
      threadId: params.target.threadId,
      accountId: params.target.accountId,
      sessionKey: params.target.sessionKey,
    },
    targetResolutionOptions,
  );

  if (!resolvedTarget.ok) {
    return { ok: false, error: resolvedTarget.error };
  }

  const identity = resolveAgentOutboundIdentity(params.cfg, params.agentId);
  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: resolveCronNotificationSessionKey({
      jobId: params.jobId,
      sessionKey: params.target.sessionKey,
    }),
  });

  return {
    ok: true,
    resolvedTarget,
    session,
    identity,
  };
}

/** Sends a cron announce payload and throws if target resolution or delivery fails. */
export async function sendCronAnnouncePayloadStrict(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
  payload: ReplyPayload;
  abortSignal: AbortSignal;
  completion?: { job: CronJob; runStartedAt: number };
  onDeliveryAttempt?: (reachedRecipient: boolean) => void;
}): Promise<CronAnnounceDeliveryOutcome> {
  const delivery = await resolveCronAnnounceDelivery(params);
  if (!delivery.ok) {
    throw delivery.error;
  }
  const runSessionKey = resolveCronNotificationSessionKey({
    jobId: params.jobId,
    sessionKey: params.target.sessionKey,
  });
  const route =
    params.completion && delivery.resolvedTarget.mode === "explicit"
      ? (
          await resolveCronDeliveryRouteSessionKey({
            cfg: params.cfg,
            job: params.completion.job,
            agentId: params.agentId,
            agentSessionKey: runSessionKey,
            delivery: delivery.resolvedTarget,
            warningContext: "completion announcement mirror",
          })
        ).route
      : null;
  // Resolution can settle after its caller's deadline; never start plugin
  // delivery once the Gateway has released ownership of the timed-out work.
  params.abortSignal.throwIfAborted();

  // Cron delivery is durable and non-best-effort for primary announces; partial
  // channel failure must surface as a cron run failure.
  let recipientReached = false;
  const deliveredPayloads: NormalizedOutboundPayload[] = [];
  const send = await sendDurableMessageBatchCore({
    cfg: params.cfg,
    channel: delivery.resolvedTarget.channel,
    to: delivery.resolvedTarget.to,
    accountId: delivery.resolvedTarget.accountId,
    threadId: delivery.resolvedTarget.threadId,
    payloads: [params.payload],
    session: delivery.session,
    identity: delivery.identity,
    bestEffort: false,
    deps: createOutboundSendDeps(params.deps),
    signal: params.abortSignal,
    ...(route ? { onPayload: (payload) => deliveredPayloads.push(payload) } : {}),
    onDeliveryResult: () => {
      if (!recipientReached) {
        recipientReached = true;
        params.onDeliveryAttempt?.(true);
      }
    },
  });
  if (!recipientReached) {
    params.onDeliveryAttempt?.(durableMessageBatchMayHaveReachedRecipient(send));
  }
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  if (send.status === "sent" && route && params.completion) {
    await commitDirectCronOutboundRoute({
      cfg: params.cfg,
      runSessionKey,
      delivery: delivery.resolvedTarget,
      route,
    });
    await appendAdmittedDirectCronDeliveryTranscriptMirror({
      job: params.completion.job,
      abortSignal: params.abortSignal,
      mirror: {
        config: params.cfg,
        sessionKey: route.sessionKey,
        agentId: params.agentId,
        storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
          agentId: params.agentId,
        }),
        text: resolveDirectCronTranscriptMirrorText(
          projectDeliveredDirectCronPayloadsForMirror(deliveredPayloads),
        ),
        idempotencyKey: buildDirectCronDeliveryIdempotencyKey({
          jobId: params.jobId,
          runStartedAt: params.completion.runStartedAt,
          delivery: delivery.resolvedTarget,
        }),
        deliveryMirror: { kind: CRON_DIRECT_DELIVERY_CONTEXT_KIND },
      },
    });
  }
  return send;
}

/** Collects distinct recipient ids for a channel from this agent's session history. */
function collectSessionPeers(params: {
  agentId: string;
  channel: string;
  accountId?: string;
}): string[] {
  const seen = new Set<string>();
  for (const { entry } of listSessionEntriesCore({ agentId: params.agentId })) {
    const delivery = deliveryContextFromSession(entry);
    const channel = sessionDeliveryChannel(entry) ?? delivery?.channel;
    if (channel !== params.channel) {
      continue;
    }
    const accountId = delivery?.accountId;
    if (params.accountId && accountId && accountId !== params.accountId) {
      continue;
    }
    const to = delivery?.to;
    if (typeof to === "string" && to.trim()) {
      seen.add(to.trim());
    }
  }
  return [...seen];
}

/**
 * Lists every recipient on a channel for an `all` broadcast: the channel
 * directory roster first (real contacts/peers), falling back to recipients seen
 * in this agent's session history when the channel has no directory adapter
 * (e.g. weixin). An optional addressing prefix ("user", "c2c", ...) filters the
 * result to recipients whose target starts with `<prefix>:`.
 */
async function enumerateChannelPeers(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: CronMessageChannel;
  accountId?: string;
  prefix?: string;
}): Promise<string[]> {
  let peers: string[] = [];
  const directory = getLoadedChannelPluginForRead(params.channel)?.directory;
  if (directory?.listPeers) {
    try {
      const entries = await directory.listPeers({
        cfg: params.cfg,
        accountId: params.accountId,
        limit: undefined,
        runtime: defaultRuntime,
      });
      peers = entries
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    } catch (err) {
      cronDeliveryLogger.warn(
        { channel: params.channel, err: formatErrorMessage(err) },
        "cron: directory listPeers failed; falling back to session peers",
      );
    }
  }
  if (peers.length === 0) {
    peers = collectSessionPeers({
      agentId: params.agentId,
      channel: params.channel,
      accountId: params.accountId,
    });
  }
  const prefix = params.prefix;
  const filtered = prefix ? peers.filter((to) => to.toLowerCase().startsWith(`${prefix}:`)) : peers;
  return [...new Set(filtered)];
}

/**
 * Expands announce plans whose recipient is the `all` wildcard into one concrete
 * plan per recipient (see {@link enumerateChannelPeers}). Non-wildcard plans pass
 * through unchanged. The result is deduped by channel+accountId+recipient so
 * overlapping explicit and wildcard targets never double-send.
 */
export async function expandCronDeliveryPlans(
  plans: CronDeliveryPlan[],
  ctx: { cfg: OpenClawConfig; agentId: string },
): Promise<CronDeliveryPlan[]> {
  const expanded: CronDeliveryPlan[] = [];
  const seen = new Set<string>();
  const pushUnique = (plan: CronDeliveryPlan) => {
    const key = `${plan.channel ?? ""}${plan.accountId ?? ""}${(plan.to ?? "").toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    expanded.push(plan);
  };
  for (const plan of plans) {
    const wildcard = parseAllTarget(plan.to);
    if (plan.mode !== "announce" || !wildcard.isAll) {
      pushUnique(plan);
      continue;
    }
    if (!plan.channel || plan.channel === "last") {
      cronDeliveryLogger.warn(
        { to: plan.to },
        "cron: ignoring all-target without a concrete channel",
      );
      continue;
    }
    const peers = await enumerateChannelPeers({
      cfg: ctx.cfg,
      agentId: ctx.agentId,
      channel: plan.channel,
      accountId: plan.accountId,
      prefix: wildcard.prefix,
    });
    if (peers.length === 0) {
      cronDeliveryLogger.warn(
        { channel: plan.channel, prefix: wildcard.prefix },
        "cron: all-target resolved to zero recipients",
      );
    }
    for (const to of peers) {
      pushUnique({ ...plan, to, requested: true });
    }
  }
  return expanded;
}

/** Aggregate outcome of fanning one announce text out to a job's extra targets. */
export type CronFanOutResult = {
  attempted: boolean;
  delivered: number;
  failures: string[];
};

/**
 * Fans the same announce text out to a job's additional delivery targets (every
 * announce plan after the primary). Each target is sent independently via the
 * durable announce path; one target's failure does not abort the others. Returns
 * per-run counts/failures so the caller can fold them into the run's delivery
 * status. Threaded delivery (threadId) is not carried on fan-out targets.
 */
export async function fanOutAdditionalCronAnnounceTargets(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  sessionKey?: string;
  message: string;
  additionalPlans: CronDeliveryPlan[];
  abortSignal: AbortSignal;
}): Promise<CronFanOutResult> {
  let attempted = false;
  let delivered = 0;
  const failures: string[] = [];
  for (const plan of params.additionalPlans) {
    if (plan.mode !== "announce" || !plan.requested) {
      continue;
    }
    attempted = true;
    try {
      await sendCronAnnouncePayloadStrict({
        deps: params.deps,
        cfg: params.cfg,
        agentId: params.agentId,
        jobId: params.jobId,
        target: {
          channel: plan.channel,
          to: plan.to,
          accountId: plan.accountId,
          sessionKey: params.sessionKey,
        },
        payload: { text: params.message },
        abortSignal: params.abortSignal,
      });
      delivered += 1;
    } catch (err) {
      const detail = formatErrorMessage(err);
      failures.push(`channel="${plan.channel ?? "?"}" to="${plan.to ?? "?"}": ${detail}`);
      cronDeliveryLogger.warn(
        { jobId: params.jobId, channel: plan.channel, to: plan.to, err: detail },
        "cron: fan-out announce target failed",
      );
    }
  }
  return { attempted, delivered, failures };
}
