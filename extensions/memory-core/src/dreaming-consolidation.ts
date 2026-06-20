// Mem0 式 MEMORY.md 整合(去重/合并/可选删除矛盾项)—— 在 deep dreaming 的
// applyShortTermPromotions(只追加+marker去重)之后,跑一次 LLM 把累积的重复/过时
// 事实合并掉。保守设计:env 开关、默认不删、备份 + 大小/marker 护栏,降误删风险。
//
// 用 runtime 的裸 LLM 补全(api.runtime.llm.complete,无工具、无 session 争用的纯转换),
// 而非 subagent agent-turn —— 后者会带工具闲聊、不稳定吐文件,且与 narrative run 在
// agent:main 上并发撞 EmbeddedAttemptSessionTakeoverError。
//
// 由 env 控制(不引入主包配置类型,留在本扩展内 → 走 memory-core overlay 即可生效):
//   OPENCLAW_MEMORY_DREAMING_CONSOLIDATION=1         开启整合(默认关)
//   OPENCLAW_MEMORY_DREAMING_CONSOLIDATION_DELETE=1  允许删除被新事实明确矛盾的旧项(默认只合并不删)

import { promises as fs } from "node:fs";
import path from "node:path";

import { withShortTermLock } from "./short-term-promotion.js";

const MEMORY_FILE = "MEMORY.md";
const MARKER_RE = /<!--[\s\S]*?-->/g;
const MIN_CHARS = 200;
const MIN_KEEP_RATIO = 0.5;

// 结构化最小面,兼容 OpenClawPluginApi["runtime"]["llm"](api.runtime.llm)。
// 走 simple-completion runtime:纯文本补全,不挂工具,返回 { text }。
type LlmSurface = {
  complete: (p: {
    systemPrompt?: string;
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    model?: string;
    purpose?: string;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ text: string }>;
};

export function isConsolidationEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env.OPENCLAW_MEMORY_DREAMING_CONSOLIDATION ?? "").trim());
}

function isDeleteAllowed(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env.OPENCLAW_MEMORY_DREAMING_CONSOLIDATION_DELETE ?? "").trim());
}

const SYSTEM_PROMPT_BASE = [
  "你在整理一个 AI agent 的长期记忆文件 MEMORY.md。规则:",
  "- 合并重复或近重复的事实为单条;把关于同一主题的互补事实合并成一条。",
  "- 保留每一条不同的事实,信息不能丢。",
  "- 逐字保留所有 HTML 注释标记 `<!-- ... -->`(它们用于去重追踪,绝不能删改或新增)。",
  "- 保持原有 markdown 结构、标题与中文风格。",
  "- {DELETE_POLICY}",
  "只输出整理后的完整 markdown 文件内容本身,不要任何解释、前言或对话,不要用代码块包裹。",
  "即使无需任何改动,也要原样完整输出当前文件内容(绝不能输出「无需修改」之类的说明)。",
].join("\n");

export type ConsolidationResult = {
  applied: boolean;
  reason?: string;
  beforeChars: number;
  afterChars: number;
  backupPath?: string;
};

export async function consolidateMemoryFile(params: {
  workspaceDir: string;
  llm: LlmSurface;
  model?: string;
  nowMs: number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}): Promise<ConsolidationResult> {
  const memoryPath = path.join(params.workspaceDir, MEMORY_FILE);
  const original = await fs.readFile(memoryPath, "utf-8").catch(() => null);
  if (original == null) return { applied: false, reason: "no MEMORY.md", beforeChars: 0, afterChars: 0 };
  if (original.trim().length < MIN_CHARS) {
    return { applied: false, reason: "too small", beforeChars: original.length, afterChars: original.length };
  }
  const originalMarkers = (original.match(MARKER_RE) ?? []).length;

  const deletePolicy = isDeleteAllowed()
    ? "仅当某条旧事实被更新的事实**明确矛盾/否定**时才删除它;不确定一律保留。"
    : "不要删除任何事实(精确重复除外),只合并、不删。";
  const sys = SYSTEM_PROMPT_BASE.replace("{DELETE_POLICY}", deletePolicy);

  let cleaned: string | null = null;
  try {
    const result = await params.llm.complete({
      systemPrompt: sys,
      messages: [{ role: "user", content: original }],
      ...(params.model ? { model: params.model } : {}),
      purpose: "memory-consolidation",
      temperature: 0,
    });
    cleaned = (result?.text ?? "").trim() || null;
  } catch (err) {
    return {
      applied: false,
      reason: `llm error: ${String((err as Error)?.message ?? err)}`,
      beforeChars: original.length,
      afterChars: original.length,
    };
  }

  if (!cleaned) {
    return { applied: false, reason: "empty llm output", beforeChars: original.length, afterChars: original.length };
  }
  cleaned = cleaned
    .replace(/^```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  // 护栏:防 LLM 误删 —— 太短或丢标记则拒绝,保留原文。
  const cleanedMarkers = (cleaned.match(MARKER_RE) ?? []).length;
  if (cleaned.length < Math.floor(original.length * MIN_KEEP_RATIO)) {
    params.logger?.warn?.(`memory-core: consolidation rejected (too short: ${cleaned.length} < 50% of ${original.length})`);
    return { applied: false, reason: `guard:too-short(${cleaned.length}/${original.length})`, beforeChars: original.length, afterChars: cleaned.length };
  }
  if (cleanedMarkers < originalMarkers) {
    params.logger?.warn?.(`memory-core: consolidation rejected (lost markers: ${cleanedMarkers} < ${originalMarkers})`);
    return { applied: false, reason: `guard:lost-markers(${cleanedMarkers}/${originalMarkers})`, beforeChars: original.length, afterChars: cleaned.length };
  }
  // 无变化则不写(免无谓备份/IO)。
  if (cleaned.trim() === original.trim()) {
    return { applied: false, reason: "no-op (already consolidated)", beforeChars: original.length, afterChars: cleaned.length };
  }

  let backupPath: string | undefined;
  await withShortTermLock(params.workspaceDir, async () => {
    const backupDir = path.join(params.workspaceDir, "memory", ".backups");
    await fs.mkdir(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `MEMORY-${params.nowMs}.md`);
    const latest = await fs.readFile(memoryPath, "utf-8").catch(() => original);
    await fs.writeFile(backupPath, latest, "utf-8");
    await fs.writeFile(memoryPath, cleaned!.endsWith("\n") ? cleaned! : `${cleaned!}\n`, "utf-8");
  });
  params.logger?.info?.(`memory-core: consolidated MEMORY.md ${original.length}→${cleaned.length} chars (backup ${backupPath})`);
  return { applied: true, beforeChars: original.length, afterChars: cleaned.length, backupPath };
}
