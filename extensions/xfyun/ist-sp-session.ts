import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { buildXfyunHmacSha256WsUrl } from "./auth/websocket-auth.js";
import type { XfyunCredentials, XfyunIstSpConfig } from "./config.js";
import { parseIstSpMessage } from "./ist-sp-text.js";

export type XfyunIstSpSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  credentials: XfyunCredentials;
  ist: XfyunIstSpConfig;
};

type IstAudioStatus = 0 | 1 | 2;

export function createXfyunIstSpSession(
  config: XfyunIstSpSessionConfig,
): RealtimeTranscriptionSession {
  let sentFirstFrame = false;
  let lastPartial: string | undefined;
  let speechStarted = false;
  let closing = false;

  const url = new URL(config.ist.baseUrl);
  const wsUrl = buildXfyunHmacSha256WsUrl({
    host: url.host,
    path: url.pathname,
    apiKey: config.credentials.apiKey,
    apiSecret: config.credentials.apiSecret,
    baseUrl: config.ist.baseUrl,
  });

  const buildBusinessFrame = () => ({
    language: config.ist.language,
    domain: config.ist.domain,
    accent: config.ist.accent,
    eos: config.ist.eos,
    vto: config.ist.vto,
  });

  const sendAudioFrame = (
    transport: { sendJson: (payload: unknown) => boolean },
    audio: Buffer,
    status: IstAudioStatus,
  ) => {
    transport.sendJson({
      common: { app_id: config.credentials.appId },
      business: buildBusinessFrame(),
      data: {
        status,
        format: "audio/L16;rate=16000",
        encoding: "raw",
        audio: audio.toString("base64"),
      },
    });
  };

  return createRealtimeTranscriptionWebSocketSession({
    providerId: "xfyun-ist-sp",
    callbacks: config,
    url: wsUrl,
    readyOnOpen: true,
    sendAudio: (audio, transport) => {
      if (closing || audio.byteLength === 0) {
        return;
      }
      const status: IstAudioStatus = sentFirstFrame ? 1 : 0;
      sentFirstFrame = true;
      sendAudioFrame(transport, audio, status);
    },
    onClose: (transport) => {
      closing = true;
      sendAudioFrame(transport, Buffer.alloc(0), 2);
    },
    onMessage: (payload) => {
      const parsed = parseIstSpMessage(payload);
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
