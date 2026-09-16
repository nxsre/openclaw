import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/realtime-transcription";
import {
  readXfyunPluginConfig,
  resolveXfyunCredentials,
  resolveXfyunIstSpConfig,
  resolveXfyunRtasrConfig,
  XFYUN_RTASR_RELAY_PROVIDER_CONFIG,
} from "./config.js";
import { createXfyunIstSpSession } from "./ist-sp-session.js";
import { createXfyunRtasrLlmSession } from "./rtasr-llm-session.js";

const CREDENTIAL_PATHS = {
  appId: "plugins.entries.xfyun.config.appId",
  apiKey: "plugins.entries.xfyun.config.apiKey",
  apiSecret: "plugins.entries.xfyun.config.apiSecret",
  accessKeyId: "plugins.entries.xfyun.config.accessKeyId",
  accessKeySecret: "plugins.entries.xfyun.config.accessKeySecret",
};

function readNestedConfig(
  rawConfig: RealtimeTranscriptionProviderConfig,
  providerKey: string,
): Record<string, unknown> {
  const raw = readXfyunPluginConfig(rawConfig);
  const providers = raw.providers as Record<string, unknown> | undefined;
  const nested =
    (providers?.[providerKey] as Record<string, unknown> | undefined) ??
    (raw[providerKey] as Record<string, unknown> | undefined) ??
    raw;
  return nested;
}

function requireCredentials(rawConfig: RealtimeTranscriptionProviderConfig) {
  const credentials = resolveXfyunCredentials(readXfyunPluginConfig(rawConfig), CREDENTIAL_PATHS);
  if (!credentials) {
    throw new Error(
      "XFYun credentials missing. Set XFYUN_APP_ID, XFYUN_API_KEY, and XFYUN_API_SECRET.",
    );
  }
  return credentials;
}

export function buildXfyunRtasrRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "xfyun",
    label: "XFYun RTASR LLM",
    aliases: ["iflytek-rtasr", "xfyun-rtasr", "讯飞转写"],
    defaultModel: "rtasr-llm",
    autoSelectOrder: 42,
    resolveConfig: ({ rawConfig }) => ({
      ...XFYUN_RTASR_RELAY_PROVIDER_CONFIG,
      ...resolveXfyunRtasrConfig(readNestedConfig(rawConfig, "xfyun")),
    }),
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveXfyunCredentials(readXfyunPluginConfig(providerConfig), CREDENTIAL_PATHS)),
    createSession: (req) =>
      createXfyunRtasrLlmSession({
        ...req,
        credentials: requireCredentials(req.providerConfig),
        rtasr: resolveXfyunRtasrConfig(readNestedConfig(req.providerConfig, "xfyun")),
      }),
  };
}

export function buildXfyunIstSpRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "xfyun-ist-sp",
    label: "XFYun IST-SP",
    aliases: ["iflytek-ist", "xfyun-sp", "讯飞实时转写SP"],
    defaultModel: "ist-sp",
    autoSelectOrder: 43,
    resolveConfig: ({ rawConfig }) => ({
      ...XFYUN_RTASR_RELAY_PROVIDER_CONFIG,
      ...resolveXfyunIstSpConfig(readNestedConfig(rawConfig, "xfyun")),
    }),
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveXfyunCredentials(readXfyunPluginConfig(providerConfig), CREDENTIAL_PATHS)),
    createSession: (req) =>
      createXfyunIstSpSession({
        ...req,
        credentials: requireCredentials(req.providerConfig),
        ist: resolveXfyunIstSpConfig(readNestedConfig(req.providerConfig, "xfyun")),
      }),
  };
}
