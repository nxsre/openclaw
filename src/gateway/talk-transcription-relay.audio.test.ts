import { describe, expect, it } from "vitest";
import { resolveTalkTranscriptionRelayInputAudio } from "./talk-transcription-relay.js";

describe("resolveTalkTranscriptionRelayInputAudio", () => {
  it("defaults to g711 ulaw at 8kHz", () => {
    expect(resolveTalkTranscriptionRelayInputAudio({})).toEqual({
      inputEncoding: "g711_ulaw",
      inputSampleRateHz: 8000,
    });
  });

  it("supports pcm16 at 16kHz for XFYun-style providers", () => {
    expect(
      resolveTalkTranscriptionRelayInputAudio({
        encoding: "pcm_s16le",
        sampleRate: 16000,
      }),
    ).toEqual({
      inputEncoding: "pcm16",
      inputSampleRateHz: 16000,
    });
  });
});
