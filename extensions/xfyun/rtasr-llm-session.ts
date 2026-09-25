import { randomUUID } from "node:crypto";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { buildRtasrLlmWsUrl } from "./auth/websocket-auth.js";
import type { XfyunCredentials, XfyunRtasrConfig } from "./config.js";
import { parseRtasrLlmMessage } from "./rtasr-text.js";

export type XfyunRtasrSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  credentials: XfyunCredentials;
  rtasr: XfyunRtasrConfig;
};

export function createXfyunRtasrLlmSession(
  config: XfyunRtasrSessionConfig,
): RealtimeTranscriptionSession {
  const sessionId = randomUUID();
  let lastPartial: string | undefined;
  let speechStarted = false;

  const wsUrl = () => {
    const query: Record<string, string> = {
      audio_encode: config.rtasr.audioEncode,
      lang: config.rtasr.lang,
      samplerate: String(config.rtasr.sampleRate),
    };
    if (config.rtasr.pd) {
      query.pd = config.rtasr.pd;
    }
    if (config.rtasr.engVadMdn !== undefined) {
      query.eng_vad_mdn = String(config.rtasr.engVadMdn);
    }
    return buildRtasrLlmWsUrl({
      baseUrl: config.rtasr.baseUrl,
      appId: config.credentials.appId,
      accessKeyId: config.credentials.accessKeyId,
      accessKeySecret: config.credentials.accessKeySecret,
      query,
    });
  };

  return createRealtimeTranscriptionWebSocketSession({
    providerId: "xfyun",
    callbacks: config,
    url: wsUrl,
    readyOnOpen: true,
    sendAudio: (audio, transport) => {
      transport.sendBinary(audio);
    },
    onClose: (transport) => {
      transport.sendJson({ end: true, sessionId });
    },
    onMessage: (payload) => {
      const parsed = parseRtasrLlmMessage(payload);
      if (!parsed) {
        return;
      }
      if (parsed.error) {
        config.onError?.(new Error(parsed.error));
        return;
      }
      if (!speechStarted) {
        speechStarted = true;
        config.onSpeechStart?.();
      }
      if (parsed.partial) {
        if (parsed.text !== lastPartial) {
          lastPartial = parsed.text;
          config.onPartial?.(parsed.text);
        }
        return;
      }
      lastPartial = undefined;
      config.onTranscript?.(parsed.text);
      if (parsed.final) {
        speechStarted = false;
      }
    },
  });
}
