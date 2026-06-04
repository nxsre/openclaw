# 讯飞转写 Gateway Relay 推流示例

> **生产上线**（配置、密钥、compose/K8s、检查清单、升级回滚）见并列仓库  
> **[openclaw-edge `docs/xfyun-deployment.md`](../../../../openclaw-edge/docs/xfyun-deployment.md)**。

Gateway 在 `talk.session.create` 成功后会返回音频契约（XFYun 为 **pcm16 / 16000 Hz**）。客户端按该契约把麦克风或文件切成 chunk，通过 **`talk.session.appendAudio`** 推送；转写结果从 **`talk.event`** 订阅。

## 1. 协议流程

```text
WebSocket connect (operator token)
  → talk.session.create { mode: "transcription", transport: "gateway-relay", brain: "none", provider: "xfyun" }
  ← { sessionId, audio: { inputEncoding: "pcm16", inputSampleRateHz: 16000 }, ... }
  → talk.session.appendAudio { sessionId, audioBase64, timestamp? }  (循环)
  ← talk.event { transcriptionSessionId, type: "partial"|"transcript"|"ready"|"error"|"close", ... }
  → talk.session.close { sessionId }
```

配置前提：`plugins.entries.xfyun` 与 `plugins.entries.voice-call.config.streaming.provider: "xfyun"`（见 `openclaw-edge/docker/config/samples/xfyun.plugin.sample.json5`）。

**Python 示例（推荐 edge 部署验证）**：[`openclaw-edge/examples/xfyun-transcription-relay/`](../../../../openclaw-edge/examples/xfyun-transcription-relay/)

推荐分片（与[实时转写大模型](https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html)一致）：

| 参数     | 值                                |
| -------- | --------------------------------- |
| 采样率   | 16000 Hz                          |
| 位深     | 16 bit signed LE，单声道          |
| 分片时长 | 40 ms                             |
| 分片大小 | **1280 字节**（16000 × 0.04 × 2） |

## 2. Node.js 冒烟脚本（openclaw 仓库）

```bash
export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:8080   # openclaw-edge 对外 18789 映射
export OPENCLAW_GATEWAY_TOKEN=your-token

# 3 秒静音（仍会走讯飞 VAD/转写链路，用于连通性）
bun scripts/dev/xfyun-transcription-relay-smoke.ts \
  --url "$OPENCLAW_GATEWAY_URL" \
  --token "$OPENCLAW_GATEWAY_TOKEN" \
  --provider xfyun

# 原始 PCM 文件（mono s16le 16 kHz）
bun scripts/dev/xfyun-transcription-relay-smoke.ts \
  --url "$OPENCLAW_GATEWAY_URL" \
  --token "$OPENCLAW_GATEWAY_TOKEN" \
  --pcm ./sample-16k-mono.pcm \
  --chunk-ms 40
```

用 `ffmpeg` 从 WAV 导出 16 kHz 原始 PCM：

```bash
ffmpeg -i input.wav -ar 16000 -ac 1 -f s16le sample-16k-mono.pcm
```

## 3. 浏览器（麦克风 → Gateway → 讯飞）

Control UI 的 realtime relay 已用同一套 PCM16 推流（见 `ui/src/ui/chat/realtime-talk-gateway-relay.ts`）。转写专用会话可复用相同音频工具函数：

```typescript
import { bytesToBase64, floatToPcm16 } from "./realtime-talk-audio.ts";

// 1) 创建转写会话
const created = await gatewayClient.request("talk.session.create", {
  mode: "transcription",
  transport: "gateway-relay",
  brain: "none",
  provider: "xfyun",
});
const sessionId = created.sessionId as string;
const sampleRateHz = created.audio.inputSampleRateHz as number; // 16000

// 2) 订阅结果
gatewayClient.addEventListener((evt) => {
  if (evt.event !== "talk.event") return;
  const p = evt.payload as {
    transcriptionSessionId?: string;
    type?: string;
    text?: string;
    message?: string;
  };
  if (p.transcriptionSessionId !== sessionId) return;
  if (p.type === "partial") console.log("partial:", p.text);
  if (p.type === "transcript") console.log("final:", p.text);
  if (p.type === "error") console.error(p.message);
});

// 3) 麦克风推流（AudioContext 采样率与 relay 一致）
const media = await navigator.mediaDevices.getUserMedia({ audio: true });
const ctx = new AudioContext({ sampleRate: sampleRateHz });
const source = ctx.createMediaStreamSource(media);
const processor = ctx.createScriptProcessor(4096, 1, 1);
processor.onaudioprocess = (event) => {
  const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
  void gatewayClient.request("talk.session.appendAudio", {
    sessionId,
    audioBase64: bytesToBase64(pcm),
    timestamp: Math.round(ctx.currentTime * 1000),
  });
};
source.connect(processor);
processor.connect(ctx.destination);

// 4) 结束
// await gatewayClient.request("talk.session.close", { sessionId });
```

## 4. Python（openclaw-edge 独立示例）

仓库路径：**`openclaw-edge/examples/xfyun-transcription-relay/`**

```bash
cd openclaw-edge/examples/xfyun-transcription-relay
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:8080
export OPENCLAW_GATEWAY_TOKEN=your-token

python3 push_pcm.py
python3 push_pcm.py --pcm sample-16k-mono.pcm --chunk-ms 40
```

说明见 **`openclaw-edge/examples/xfyun-transcription-relay/README.md`**。脚本内用单 reader 分发 `res` 与 `talk.event`，避免 RPC 与事件监听抢读 WebSocket。

## 5. 事件字段速查

| `talk.event` payload.type | 含义                                 |
| ------------------------- | ------------------------------------ |
| `ready`                   | 讯飞 WS 已连接，可开始 `appendAudio` |
| `partial`                 | 中间转写（`text`）                   |
| `transcript`              | 一句最终结果（`final: true`）        |
| `speechStart`             | 检测到说话开始（含嵌套 `talkEvent`） |
| `error`                   | 失败（`message`）                    |
| `close`                   | 会话结束                             |

同一事件可能还带 `talkEvent`（`transcript.delta` / `transcript.done` 等），与 UI Talk 时间线兼容；简单客户端只读顶层 `type` + `text` 即可。

## 6. 常见问题

- **采样率不一致**：必须按 `create` 返回的 `audio.inputSampleRateHz` 编码；XFYun 为 16000，不要用 8 kHz μ-law（那是 Deepgram 默认 relay）。
- **推太快**：保持约 40 ms 一片；过快可能触发讯飞「发送过快」错误。
- **无转写**：确认控制台已开通 RTASR LLM / IST-SP，且 `XFYUN_*` 密钥与 `provider: "xfyun"` 配置正确。
