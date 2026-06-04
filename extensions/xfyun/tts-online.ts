import WebSocket from "ws";
import { buildXfyunHmacSha256WsUrl } from "./auth/websocket-auth.js";
import type { XfyunCredentials, XfyunTtsConfig } from "./config.js";

type XfyunTtsResponse = {
  code?: number;
  message?: string;
  sid?: string;
  data?: {
    audio?: string;
    status?: number;
    ced?: string;
  };
};

const TTS_CONNECT_TIMEOUT_MS = 30_000;

function readTtsError(payload: XfyunTtsResponse): string {
  return payload.message?.trim() || `XFYun TTS failed (code=${payload.code ?? "unknown"})`;
}

function mimeForAue(aue: string): string {
  const normalized = aue.trim().toLowerCase();
  if (normalized === "raw" || normalized === "pcm") {
    return "audio/L16;rate=16000";
  }
  if (normalized === "speex" || normalized === "speex-wb") {
    return "audio/speex";
  }
  return "audio/mpeg";
}

export async function synthesizeXfyunOnlineTts(params: {
  text: string;
  credentials: XfyunCredentials;
  config: XfyunTtsConfig;
}): Promise<{ audio: Buffer; contentType: string }> {
  const trimmed = params.text.trim();
  if (!trimmed) {
    throw new Error("XFYun TTS requires non-empty text");
  }
  const url = new URL(params.config.baseUrl);
  const wsUrl = buildXfyunHmacSha256WsUrl({
    host: url.host,
    path: url.pathname,
    apiKey: params.credentials.apiKey,
    apiSecret: params.credentials.apiSecret,
    baseUrl: params.config.baseUrl,
  });

  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error("XFYun TTS connection timeout"));
      }
    }, TTS_CONNECT_TIMEOUT_MS);
    timer.unref?.();

    const ws = new WebSocket(wsUrl);
    const finish = (error?: Error, audio?: Buffer) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close errors after completion
      }
      if (error) {
        reject(error);
        return;
      }
      resolve({ audio: audio ?? Buffer.alloc(0), contentType: mimeForAue(params.config.aue) });
    };

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          common: { app_id: params.credentials.appId },
          business: {
            aue: params.config.aue,
            vcn: params.config.voice,
            speed: params.config.speed,
            volume: params.config.volume,
            pitch: params.config.pitch,
            sfl: 1,
            auf: `audio/L16;rate=${params.config.sampleRate}`,
          },
          data: {
            status: 2,
            text: Buffer.from(trimmed, "utf8").toString("base64"),
          },
        }),
      );
    });

    ws.on("message", (raw) => {
      let payload: XfyunTtsResponse;
      try {
        payload = JSON.parse(raw.toString()) as XfyunTtsResponse;
      } catch {
        finish(new Error("XFYun TTS returned malformed JSON"));
        return;
      }
      if (payload.code !== 0) {
        finish(new Error(readTtsError(payload)));
        return;
      }
      const audioChunk = payload.data?.audio;
      if (audioChunk) {
        chunks.push(Buffer.from(audioChunk, "base64"));
      }
      if (payload.data?.status === 2) {
        finish(undefined, Buffer.concat(chunks));
      }
    });

    ws.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    ws.on("close", () => {
      if (!settled && chunks.length > 0) {
        finish(undefined, Buffer.concat(chunks));
      }
    });
  });
}
