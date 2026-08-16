/**
 * Phase 7 — Distiller（LLM 反思提炼器）
 *
 * 从会话记录 / workflow 步骤中提炼可跨会话复用的知识（决策/教训/观察/结论），
 * 写入 KnowledgeBase。对应 Clowder 的 ReflectionService（学习版简化）。
 *
 * 解析策略（P5-001 教训：结构化标签 > 自然语言）：
 * 1. `<none/>` → ok，0 条
 * 2. 标签正则（一级）：`<entry type="..." keywords="..."><title>..</title><content>..</content></entry>`
 * 3. JSON.parse 容错（二级）
 * 4. 双失败 → parse_failed：console.warn + 照落 kb_distill_runs（含原始输出），绝不静默
 */

import Anthropic from "@anthropic-ai/sdk";
import type { KnowledgeBase } from "./knowledge-base.js";
import type { DistillEntry, DistillStatus, EvidenceType } from "./types.js";
import { EVIDENCE_TYPES } from "./types.js";

/** 单次提炼条数上限（防 LLM 刷库） */
const MAX_ENTRIES = 10;

/** 提炼结果 */
export interface DistillResult {
  status: DistillStatus;
  entries: DistillEntry[];
  raw: string;
  addedIds: string[];
  skippedDuplicates: number;
}

export class Distiller {
  constructor(
    private client: Anthropic,
    private model: string = "claude-opus-4-8",
    private kb?: KnowledgeBase
  ) {}

  /**
   * 提炼并写库
   * @param input.transcript 已格式化的协作记录文本（CLI 侧组装）
   * @param input.task 原始任务（可选）
   * @param input.threadId 归属会话
   * @param input.force 跳过 scope 级幂等检查
   */
  async distill(input: {
    threadId: string;
    transcript: string;
    task?: string;
    force?: boolean;
  }): Promise<DistillResult> {
    const { threadId, transcript, task, force } = input;

    // 空记录 → 跳过（显形，不是错误）
    if (!transcript.trim()) {
      return { status: "skipped_empty", entries: [], raw: "", addedIds: [], skippedDuplicates: 0 };
    }

    // 1. LLM 提炼
    const raw = await this.callLlm(transcript, task);

    // 2. 解析（三级）
    const entries = this.parse(raw);

    // 3. parse_failed：显形返回（CLI 负责落 kb_distill_runs）
    if (entries === null) {
      console.warn(
        `[distiller] ⚠️ 提炼输出解析失败（未识别到 <entry> 标签或 JSON），原始输出已保留，` +
          `可用 --show-raw 查看。请检查模型输出格式。`
      );
      return { status: "parse_failed", entries: [], raw, addedIds: [], skippedDuplicates: 0 };
    }

    // 4. 幂等 + 写库
    return this.writeEntries(entries, threadId);
  }

  /** LLM 调用（严格结构化标签输出） */
  private async callLlm(transcript: string, task?: string): Promise<string> {
    const system =
      "你是经验提炼器。从多 Agent 协作记录中提炼可跨会话复用的知识。只输出结构化条目，禁止任何解释、前言、总结或 markdown 修饰。";

    let user = "";
    if (task) user += `## 原始任务\n${task}\n\n`;
    user += `## 协作记录\n${transcript}\n\n`;
    user += `## 提炼要求\n`;
    user += `- 只提炼值得跨会话复用的：关键决策及理由(decision) / 踩过的坑与教训(lesson) / 重要事实观察(observation) / 最终结论要点(outcome)\n`;
    user += `- content 必须自包含（脱离原会话可读），中文，≤120 字；title ≤20 字\n`;
    user += `- keywords 3-5 个，逗号分隔\n`;
    user += `- 没有值得提炼的内容 → 只输出 <none/>\n`;
    user += `- 严格按以下格式输出（每条一组标签，不要加粗、不要列表符号）：\n`;
    user += `<entry type="decision" keywords="关键词1,关键词2">\n<title>标题</title>\n<content>内容</content>\n</entry>\n`;
    user += `<entry type="lesson" keywords="关键词1,关键词2">\n<title>标题</title>\n<content>内容</content>\n</entry>`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = response.content.find((b) => b.type === "text");
    return text && text.type === "text" ? text.text : "";
  }

  /**
   * 三级解析：null = 双失败（parse_failed）
   * 1. `<none/>` → []
   * 2. 标签正则（一级）
   * 3. JSON.parse 容错（二级）
   */
  parse(raw: string): DistillEntry[] | null {
    const trimmed = raw.trim();

    if (/<none\s*\/>/.test(trimmed)) return [];

    // 一级：结构化标签
    const entries = this.parseTags(trimmed);
    if (entries.length > 0) return entries;

    // 二级：JSON 容错
    const jsonEntries = this.parseJson(trimmed);
    if (jsonEntries !== null) return jsonEntries;

    // 空输出（模型啥都没说）→ 视为空而非失败
    if (trimmed.length === 0) return [];

    return null;
  }

  /** 一级：标签解析 */
  private parseTags(raw: string): DistillEntry[] {
    const entries: DistillEntry[] = [];
    const pattern =
      /<entry\s+type=["']([\w-]+)["']\s*(?:keywords=["']([^"']*)["'])?\s*>\s*<title>([\s\S]*?)<\/title>\s*<content>([\s\S]*?)<\/content>\s*<\/entry>/g;

    for (const m of raw.matchAll(pattern)) {
      const [, type, keywords, title, content] = m;
      if (!EVIDENCE_TYPES.includes(type as EvidenceType)) {
        console.warn(`[distiller] ⚠️ 丢弃未知 type "${type}" 的条目: ${title.trim().slice(0, 30)}`);
        continue;
      }
      entries.push({
        type: type as EvidenceType,
        title: title.trim(),
        content: content.trim(),
        keywords: keywords
          ? keywords.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
          : undefined,
      });
    }
    return entries;
  }

  /** 二级：JSON 容错（[{type,title,content,keywords?}, ...]） */
  private parseJson(raw: string): DistillEntry[] | null {
    const jsonStart = raw.indexOf("[");
    const jsonEnd = raw.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd <= jsonStart) return null;

    try {
      const arr = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as unknown[];
      const entries: DistillEntry[] = [];
      for (const item of arr) {
        if (typeof item !== "object" || item === null) continue;
        const o = item as Record<string, unknown>;
        const type = String(o.type ?? "");
        const title = String(o.title ?? "").trim();
        const content = String(o.content ?? "").trim();
        if (!EVIDENCE_TYPES.includes(type as EvidenceType) || !title || !content) continue;
        entries.push({
          type: type as EvidenceType,
          title,
          content,
          keywords: Array.isArray(o.keywords) ? o.keywords.map(String) : undefined,
        });
      }
      return entries;
    } catch {
      return null;
    }
  }

  /** 写库：上限 + 条目级幂等（同 thread 同 title 跳过） */
  private writeEntries(entries: DistillEntry[], threadId: string): DistillResult {
    if (!this.kb) {
      return { status: "error", entries, raw: "", addedIds: [], skippedDuplicates: 0 };
    }

    if (entries.length > MAX_ENTRIES) {
      console.warn(`[distiller] ⚠️ 提炼出 ${entries.length} 条，超过上限 ${MAX_ENTRIES}，截断`);
      entries = entries.slice(0, MAX_ENTRIES);
    }

    const addedIds: string[] = [];
    let skipped = 0;

    for (const e of entries) {
      // 条目级幂等：同 thread 同 title 视为重复
      if (this.kb.findByTitle(e.title, threadId)) {
        skipped++;
        continue;
      }
      const added = this.kb.add({
        type: e.type,
        title: e.title,
        content: e.content,
        keywords: e.keywords ?? [],
        sourceThread: threadId,
        sourceAgent: "distiller",
        verified: false,
      });
      addedIds.push(added.id);
    }

    return {
      status: addedIds.length === 0 && skipped > 0 && entries.length > 0
        ? "duplicate_skipped"
        : "ok",
      entries,
      raw: "",
      addedIds,
      skippedDuplicates: skipped,
    };
  }
}
