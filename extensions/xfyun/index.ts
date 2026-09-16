import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildXfyunIstSpRealtimeTranscriptionProvider,
  buildXfyunRtasrRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";
import { buildXfyunSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "xfyun",
  name: "XFYun Speech",
  description: "Bundled iFlytek online TTS and realtime transcription (RTASR LLM + IST-SP)",
  register(api) {
    api.registerSpeechProvider(buildXfyunSpeechProvider());
    api.registerRealtimeTranscriptionProvider(buildXfyunRtasrRealtimeTranscriptionProvider());
    api.registerRealtimeTranscriptionProvider(buildXfyunIstSpRealtimeTranscriptionProvider());
  },
});
