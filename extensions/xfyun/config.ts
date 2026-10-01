import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type XfyunCredentials = {
  appId: string;
  apiKey: string;
  apiSecret: string;
  accessKeyId: string;
  accessKeySecret: string;
};

export type XfyunTtsConfig = {
  baseUrl: string;
  voice: string;
  aue: string;
  speed: number;
  volume: number;
  pitch: number;
  sampleRate: number;
};

export type XfyunRtasrConfig = {
  baseUrl: string;
  lang: string;
  audioEncode: string;
  sampleRate: number;
  pd?: string;
  engVadMdn?: number;
};

export type XfyunIstSpConfig = {
  baseUrl: string;
  language: string;
  domain: string;
  accent: string;
  eos: number;
  vto: number;
};

const DEFAULT_TTS_BASE_URL = "wss://tts-api.xfyun.cn/v2/tts";
const DEFAULT_RTASR_BASE_URL = "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1";
const DEFAULT_IST_SP_BASE_URL = "wss://eu.aicloudapi.com/v2/ist";

function readNestedProviderConfig(
  rawConfig: Record<string, unknown>,
  providerKey: string,
): Record<string, unknown> {
  const providers = readRecord(rawConfig.providers);
  return readRecord(providers?.[providerKey] ?? rawConfig[providerKey] ?? rawConfig) ?? {};
}

export function readXfyunPluginConfig(
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return readRecord(raw) ?? {};
}

export function resolveXfyunCredentials(
  rawConfig: Record<string, unknown>,
  paths: {
    appId: string;
    apiKey: string;
    apiSecret: string;
    accessKeyId: string;
    accessKeySecret: string;
  },
): XfyunCredentials | undefined {
  const nested = readNestedProviderConfig(rawConfig, "xfyun");
  const appId =
    normalizeOptionalString(nested.appId) ?? normalizeOptionalString(process.env.XFYUN_APP_ID);
  const apiKey =
    normalizeResolvedSecretInputString({ value: nested.apiKey, path: paths.apiKey }) ??
    normalizeOptionalString(process.env.XFYUN_API_KEY);
  const apiSecret =
    normalizeResolvedSecretInputString({ value: nested.apiSecret, path: paths.apiSecret }) ??
    normalizeOptionalString(process.env.XFYUN_API_SECRET);
  const accessKeyId =
    normalizeOptionalString(nested.accessKeyId) ??
    normalizeOptionalString(process.env.XFYUN_ACCESS_KEY_ID) ??
    apiKey;
  const accessKeySecret =
    normalizeResolvedSecretInputString({
      value: nested.accessKeySecret,
      path: paths.accessKeySecret,
    }) ??
    normalizeOptionalString(process.env.XFYUN_ACCESS_KEY_SECRET) ??
    apiSecret;
  if (!appId || !apiKey || !apiSecret || !accessKeyId || !accessKeySecret) {
    return undefined;
  }
  return { appId, apiKey, apiSecret, accessKeyId, accessKeySecret };
}

export function resolveXfyunTtsConfig(rawConfig: Record<string, unknown>): XfyunTtsConfig {
  const nested = readNestedProviderConfig(rawConfig, "xfyun");
  const tts = readRecord(nested.tts) ?? nested;
  return {
    baseUrl: normalizeOptionalString(tts.baseUrl) ?? DEFAULT_TTS_BASE_URL,
    voice: normalizeOptionalString(tts.voice ?? tts.vcn ?? tts.voiceId) ?? "xiaoyan",
    aue: normalizeOptionalString(tts.aue) ?? "lame",
    speed: typeof tts.speed === "number" && Number.isFinite(tts.speed) ? tts.speed : 50,
    volume: typeof tts.volume === "number" && Number.isFinite(tts.volume) ? tts.volume : 50,
    pitch: typeof tts.pitch === "number" && Number.isFinite(tts.pitch) ? tts.pitch : 50,
    sampleRate:
      typeof tts.sampleRate === "number" && Number.isFinite(tts.sampleRate)
        ? tts.sampleRate
        : 16_000,
  };
}

export function resolveXfyunRtasrConfig(rawConfig: Record<string, unknown>): XfyunRtasrConfig {
  const nested = readNestedProviderConfig(rawConfig, "xfyun");
  const rtasr = readRecord(nested.rtasr) ?? nested;
  return {
    baseUrl: normalizeOptionalString(rtasr.baseUrl) ?? DEFAULT_RTASR_BASE_URL,
    lang: normalizeOptionalString(rtasr.lang) ?? "autodialect",
    audioEncode: normalizeOptionalString(rtasr.audioEncode ?? rtasr.audio_encode) ?? "pcm_s16le",
    sampleRate:
      typeof rtasr.sampleRate === "number" && Number.isFinite(rtasr.sampleRate)
        ? rtasr.sampleRate
        : 16_000,
    pd: normalizeOptionalString(rtasr.pd),
    engVadMdn:
      typeof rtasr.engVadMdn === "number" && Number.isFinite(rtasr.engVadMdn)
        ? rtasr.engVadMdn
        : typeof rtasr.eng_vad_mdn === "number" && Number.isFinite(rtasr.eng_vad_mdn)
          ? rtasr.eng_vad_mdn
          : undefined,
  };
}

export function resolveXfyunIstSpConfig(rawConfig: Record<string, unknown>): XfyunIstSpConfig {
  const nested = readNestedProviderConfig(rawConfig, "xfyun");
  const ist = readRecord(nested.istSp ?? nested.ist_sp) ?? {};
  return {
    baseUrl: normalizeOptionalString(ist.baseUrl) ?? DEFAULT_IST_SP_BASE_URL,
    language: normalizeOptionalString(ist.language) ?? "zh_cn",
    domain: normalizeOptionalString(ist.domain) ?? "ist_ed",
    accent: normalizeOptionalString(ist.accent) ?? "mandarin",
    eos: typeof ist.eos === "number" && Number.isFinite(ist.eos) ? ist.eos : 800,
    vto: typeof ist.vto === "number" && Number.isFinite(ist.vto) ? ist.vto : 15_000,
  };
}

export const XFYUN_RTASR_RELAY_PROVIDER_CONFIG = {
  encoding: "pcm_s16le",
  sampleRate: 16_000,
  audioFormat: "pcm_s16le",
};
