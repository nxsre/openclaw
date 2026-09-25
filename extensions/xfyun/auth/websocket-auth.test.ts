import { describe, expect, it } from "vitest";
import { buildRtasrLlmWsUrl, buildXfyunHmacSha256WsUrl } from "./websocket-auth.js";

describe("xfyun websocket auth", () => {
  it("builds TTS authorization query parameters", () => {
    const url = buildXfyunHmacSha256WsUrl(
      {
        host: "tts-api.xfyun.cn",
        path: "/v2/tts",
        apiKey: "test-api-key",
        apiSecret: "test-api-secret",
        baseUrl: "wss://tts-api.xfyun.cn/v2/tts",
      },
      new Date("2026-05-31T12:00:00.000Z"),
    );
    const parsed = new URL(url);
    expect(parsed.host).toBe("tts-api.xfyun.cn");
    expect(parsed.searchParams.get("host")).toBe("tts-api.xfyun.cn");
    expect(parsed.searchParams.get("date")).toBe("Sun, 31 May 2026 12:00:00 GMT");
    expect(parsed.searchParams.get("authorization")).toBeTruthy();
  });

  it("builds RTASR LLM signed websocket URLs", () => {
    const url = buildRtasrLlmWsUrl({
      baseUrl: "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
      appId: "app-1",
      accessKeyId: "key-1",
      accessKeySecret: "secret-1",
      uuid: "uuid-1",
      utc: "2026-05-31T12:00:00+0800",
      query: {
        audio_encode: "pcm_s16le",
        lang: "autodialect",
        samplerate: "16000",
      },
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("appId")).toBe("app-1");
    expect(parsed.searchParams.get("accessKeyId")).toBe("key-1");
    expect(parsed.searchParams.get("signature")).toBeTruthy();
    expect(parsed.searchParams.get("samplerate")).toBe("16000");
  });
});
