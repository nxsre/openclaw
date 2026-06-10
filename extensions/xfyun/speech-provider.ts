import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { asFiniteNumber, trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import { readXfyunPluginConfig, resolveXfyunCredentials, resolveXfyunTtsConfig } from "./config.js";
import { synthesizeXfyunOnlineTts } from "./tts-online.js";

const DEFAULT_VOICES = ["xiaoyan", "aisjiuxu", "aisxping", "aisjinger", "aisbabyxu"] as const;

function readProviderConfig(config: SpeechProviderConfig) {
  return resolveXfyunTtsConfig(config);
}

function readOverrides(overrides: SpeechProviderOverrides | undefined) {
  return {
    voice: trimToUndefined(overrides?.voice),
    speed: asFiniteNumber(overrides?.speed),
  };
}

export function buildXfyunSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "xfyun",
    label: "XFYun Online TTS",
    aliases: ["iflytek", "讯飞", "xunfei"],
    autoSelectOrder: 88,
    voices: [...DEFAULT_VOICES],
    resolveConfig: ({ rawConfig }) => resolveXfyunTtsConfig(readXfyunPluginConfig(rawConfig)),
    parseDirectiveToken: (ctx) => {
      switch (ctx.key) {
        case "voice":
        case "vcn":
        case "xfyun_voice":
          if (!ctx.policy.allowVoice) {
            return { handled: true };
          }
          return { handled: true, overrides: { ...ctx.currentOverrides, voice: ctx.value } };
        case "speed":
          if (!ctx.policy.allowVoiceSettings) {
            return { handled: true };
          }
          return {
            handled: true,
            overrides: { ...ctx.currentOverrides, speed: Number(ctx.value) },
          };
        default:
          return { handled: false };
      }
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(
        resolveXfyunCredentials(readXfyunPluginConfig(providerConfig), {
          appId: "plugins.entries.xfyun.config.appId",
          apiKey: "plugins.entries.xfyun.config.apiKey",
          apiSecret: "plugins.entries.xfyun.config.apiSecret",
          accessKeyId: "plugins.entries.xfyun.config.accessKeyId",
          accessKeySecret: "plugins.entries.xfyun.config.accessKeySecret",
        }),
      ),
    synthesize: async (req) => {
      const credentials = resolveXfyunCredentials(readXfyunPluginConfig(req.providerConfig), {
        appId: "plugins.entries.xfyun.config.appId",
        apiKey: "plugins.entries.xfyun.config.apiKey",
        apiSecret: "plugins.entries.xfyun.config.apiSecret",
        accessKeyId: "plugins.entries.xfyun.config.accessKeyId",
        accessKeySecret: "plugins.entries.xfyun.config.accessKeySecret",
      });
      if (!credentials) {
        throw new Error(
          "XFYun credentials missing. Set XFYUN_APP_ID, XFYUN_API_KEY, and XFYUN_API_SECRET.",
        );
      }
      const tts = readProviderConfig(req.providerConfig);
      const overrides = readOverrides(req.providerOverrides);
      const result = await synthesizeXfyunOnlineTts({
        text: req.text,
        credentials,
        config: {
          ...tts,
          voice: overrides.voice ?? tts.voice,
          speed:
            overrides.speed !== undefined
              ? Math.min(100, Math.max(0, Math.round(overrides.speed * 50)))
              : tts.speed,
        },
      });
      const outputFormat = tts.aue === "raw" ? "pcm_16000" : "mp3";
      return {
        audioBuffer: result.audio,
        outputFormat,
        fileExtension: outputFormat === "mp3" ? ".mp3" : ".pcm",
        // XFYun online TTS emits mp3 / raw PCM / speex, never opus, so it is not a
        // direct voice-channel (opus) format. See isAzureSpeechVoiceCompatible.
        voiceCompatible: false,
      };
    },
  };
}
