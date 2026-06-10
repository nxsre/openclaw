/**
 * XFYun / Talk transcription relay smoke: connect to Gateway, create a
 * transcription session, stream 16 kHz PCM16 chunks, print talk.event transcripts.
 *
 * Usage:
 *   bun scripts/dev/xfyun-transcription-relay-smoke.ts \
 *     --url ws://127.0.0.1:18789 \
 *     --token "$OPENCLAW_GATEWAY_TOKEN" \
 *     --provider xfyun
 *
 * Optional:
 *   --pcm path/to/raw.pcm   # mono s16le; will resample chunk if not 16 kHz (see --sample-rate)
 *   --sample-rate 16000
 *   --chunk-ms 40           # 40 ms ~= 1280 bytes @ 16 kHz (XFYun RTASR recommendation)
 *   --duration-ms 3000      # synthetic silence length when --pcm is omitted
 */
import { readFileSync } from "node:fs";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../src/gateway/protocol/version.ts";
import { createArgReader, createGatewayWsClient, resolveGatewayUrl } from "./gateway-ws-client.ts";

const SAMPLE_RATE_HZ = 16_000;
const BYTES_PER_SAMPLE = 2;

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunkMsToBytes(chunkMs: number, sampleRateHz: number): number {
  return Math.max(1, Math.floor((sampleRateHz * chunkMs) / 1000) * BYTES_PER_SAMPLE);
}

function buildSilencePcm(durationMs: number, sampleRateHz: number): Buffer {
  const samples = Math.floor((sampleRateHz * durationMs) / 1000);
  return Buffer.alloc(samples * BYTES_PER_SAMPLE);
}

function loadPcmFile(path: string): Buffer {
  const data = readFileSync(path);
  if (data.byteLength % BYTES_PER_SAMPLE !== 0) {
    throw new Error(`PCM file byte length must be even (s16le): ${path}`);
  }
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const { get: getArg } = createArgReader();
const urlRaw = getArg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const token = getArg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
const provider = getArg("--provider") ?? "xfyun";
const pcmPath = getArg("--pcm");
const sampleRate = Number(getArg("--sample-rate") ?? SAMPLE_RATE_HZ);
const chunkMs = Number(getArg("--chunk-ms") ?? 40);
const durationMs = Number(getArg("--duration-ms") ?? 3000);

if (!token) {
  writeErr(
    "Usage: bun scripts/dev/xfyun-transcription-relay-smoke.ts --url <ws://host:port> --token <gateway-token>\n" +
      "Env: OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN",
  );
  process.exit(1);
}

if (sampleRate !== 8_000 && sampleRate !== 16_000) {
  writeErr("--sample-rate must be 8000 or 16000 for Gateway transcription relay");
  process.exit(1);
}

async function main(): Promise<void> {
  const url = resolveGatewayUrl(urlRaw);
  const { request, waitOpen, close } = createGatewayWsClient({
    url: url.toString(),
    onEvent: (evt) => {
      if (evt.event !== "talk.event") {
        return;
      }
      const payload = evt.payload;
      if (!isRecord(payload)) {
        return;
      }
      const sessionId = payload.transcriptionSessionId;
      const type = payload.type;
      if (type === "partial" && typeof payload.text === "string") {
        writeLine(`[partial] ${payload.text}`);
        return;
      }
      if (type === "transcript" && typeof payload.text === "string") {
        writeLine(`[final] ${payload.text}`);
        return;
      }
      if (type === "error" && typeof payload.message === "string") {
        writeErr(`[error] ${payload.message}`);
        return;
      }
      if (type === "ready") {
        writeLine(`[ready] session=${String(sessionId)}`);
        return;
      }
      if (type === "close") {
        writeLine(`[close] reason=${String(payload.reason ?? "unknown")}`);
      }
    },
  });

  await waitOpen();
  const connectRes = await request("connect", {
    minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "cli",
      displayName: "xfyun transcription relay smoke",
      version: "dev",
      platform: "dev",
      mode: "cli",
      instanceId: "xfyun-transcription-relay-smoke",
    },
    locale: "zh-CN",
    userAgent: "xfyun-transcription-relay-smoke",
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    caps: [],
    auth: { token },
  });
  if (!connectRes.ok) {
    throw new Error(`connect failed: ${JSON.stringify(connectRes.error)}`);
  }

  const createRes = await request("talk.session.create", {
    mode: "transcription",
    transport: "gateway-relay",
    brain: "none",
    provider,
  });
  if (!createRes.ok) {
    throw new Error(`talk.session.create failed: ${JSON.stringify(createRes.error)}`);
  }
  const session = createRes.payload;
  if (!isRecord(session)) {
    throw new Error("talk.session.create returned non-object payload");
  }
  const sessionId = String(session.sessionId ?? session.transcriptionSessionId ?? "");
  const audio = isRecord(session.audio) ? session.audio : {};
  writeLine(
    `session=${sessionId} audio=${JSON.stringify(audio)} provider=${String(session.provider ?? provider)}`,
  );
  if (audio.inputEncoding !== "pcm16") {
    writeErr(
      `warning: expected audio.inputEncoding "pcm16" for XFYun (got ${String(audio.inputEncoding)})`,
    );
  }
  const relayRate = Number(audio.inputSampleRateHz ?? sampleRate);
  if (relayRate !== sampleRate) {
    writeErr(`warning: streaming at ${sampleRate} Hz but relay advertises ${relayRate} Hz`);
  }

  const pcm = pcmPath ? loadPcmFile(pcmPath) : buildSilencePcm(durationMs, sampleRate);
  const chunkBytes = chunkMsToBytes(chunkMs, sampleRate);
  writeLine(`streaming ${pcm.byteLength} bytes in ${chunkBytes}-byte chunks every ${chunkMs} ms`);

  for (let offset = 0; offset < pcm.byteLength; offset += chunkBytes) {
    const slice = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.byteLength));
    const appendRes = await request(
      "talk.session.appendAudio",
      {
        sessionId,
        audioBase64: slice.toString("base64"),
        timestamp: Math.round((offset / BYTES_PER_SAMPLE / sampleRate) * 1000),
      },
      20_000,
    );
    if (!appendRes.ok) {
      throw new Error(`talk.session.appendAudio failed: ${JSON.stringify(appendRes.error)}`);
    }
    await sleep(chunkMs);
  }

  await sleep(500);
  const closeRes = await request("talk.session.close", { sessionId });
  if (!closeRes.ok) {
    throw new Error(`talk.session.close failed: ${JSON.stringify(closeRes.error)}`);
  }
  writeLine("done");
  close();
}

main().catch((error: unknown) => {
  writeErr(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
