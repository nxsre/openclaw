import type { InteractiveReplyButton } from "../interactive/payload.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type { CommandExplanationSummary } from "./command-analysis/explain.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

type ApprovalPhase = "pending" | "resolved" | "expired";

/** Button/action shape shared by channel renderers for approval decisions. */
export type ApprovalActionView = {
  kind?: "command" | "decision";
  decision: ExecApprovalDecision;
  label: string;
  style: NonNullable<InteractiveReplyButton["style"]>;
  command: string;
};

/** Label/value metadata row shown with approval views. */
export type ApprovalMetadataView = {
  label: string;
  value: string;
};

type ApprovalViewBase = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  phase: ApprovalPhase;
  title: string;
  description?: string | null;
  metadata: ApprovalMetadataView[];
};

/** Shared exec approval fields used by pending/resolved/expired renderers. */
export type ExecApprovalViewBase = ApprovalViewBase & {
  approvalKind: "exec";
  ask?: string | null;
  agentId?: string | null;
  warningText?: string | null;
  commandAnalysis?: CommandExplanationSummary | null;
  commandText: string;
  commandPreview?: string | null;
  cwd?: string | null;
  envKeys?: readonly string[];
  host?: string | null;
  nodeId?: string | null;
  sessionKey?: string | null;
};

/** Pending exec approval view including available decision actions. */
export type ExecApprovalPendingView = ExecApprovalViewBase & {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

/** Resolved exec approval view after an operator decision. */
export type ExecApprovalResolvedView = ExecApprovalViewBase & {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

/** Expired exec approval view after the approval window closes. */
export type ExecApprovalExpiredView = ExecApprovalViewBase & {
  phase: "expired";
};

/** Shared plugin approval fields used by pending/resolved/expired renderers. */
export type PluginApprovalViewBase = ApprovalViewBase & {
  approvalKind: "plugin";
  agentId?: string | null;
  pluginId?: string | null;
  toolName?: string | null;
  severity: "info" | "warning" | "critical";
};

/** Pending plugin approval view including available decision actions. */
export type PluginApprovalPendingView = PluginApprovalViewBase & {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

/** Resolved plugin approval view after an operator decision. */
export type PluginApprovalResolvedView = PluginApprovalViewBase & {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

/** Expired plugin approval view after the approval window closes. */
export type PluginApprovalExpiredView = PluginApprovalViewBase & {
  phase: "expired";
};

export type PendingApprovalView = ExecApprovalPendingView | PluginApprovalPendingView;
export type ResolvedApprovalView = ExecApprovalResolvedView | PluginApprovalResolvedView;
export type ExpiredApprovalView = ExecApprovalExpiredView | PluginApprovalExpiredView;
export type ApprovalViewModel = PendingApprovalView | ResolvedApprovalView | ExpiredApprovalView;

export type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
export type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
