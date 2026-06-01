import type { ChannelApprovalNativeTarget } from "../channels/plugins/approval-native.types.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";

/** Build the stable route key used to dedupe native approval targets across plugins. */
export function buildChannelApprovalNativeTargetKey(target: ChannelApprovalNativeTarget): string {
  return channelRouteDedupeKey({
    to: target.to,
    threadId: target.threadId,
  });
}
