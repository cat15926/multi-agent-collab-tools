/**
 * Phase 7 — kb_write 工具（知识库写入，--allow-kb-write 门控）
 *
 * 门控理由（Hard Rails）：不开启时 LLM 不能写库——防 Agent 自写自读刷库、
 * 把未经验证的猜测固化为"经验"。与 write_file 的 --allow-write 同心智模型，
 * 但不进 Sandbox（KB 是纯 DB 追加、可 --kb-del 回滚，风险等级低一档）。
 *
 * 归属：LLM 写入的条目 verified 恒为 0（人工 --kb-verify 背书）。
 */

import type { Tool, ToolResult, ToolContext } from "../tool.js";
import { ok, err } from "../tool.js";
import type { KnowledgeBase } from "../../knowledge/knowledge-base.js";
import type { EvidenceType } from "../../knowledge/types.js";
import { EVIDENCE_TYPES } from "../../knowledge/types.js";

export class KbWriteTool implements Tool {
  name = "kb_write";
  description =
    "向团队长期知识库写入一条经验（决策/教训/观察/结论），供后续会话检索复用。仅在用户明确要求记录时使用。";
  inputSchema = {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        description: "条目类型: decision（决策） | lesson（教训） | observation（观察） | outcome（结论）",
      },
      title: { type: "string", description: "短标题（≤20 字）" },
      content: { type: "string", description: "自包含内容（脱离当前对话也能读懂，≤120 字）" },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "检索关键词（3-5 个）",
      },
    },
    required: ["type", "title", "content"],
  };

  constructor(
    private kb: KnowledgeBase,
    private opts: { allowWrite: boolean }
  ) {}

  async execute(input: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    // Hard Rails：未授权直接拒绝（沙箱层语义，但 KB 专用）
    if (!this.opts.allowWrite) {
      return err("kb_write 未授权（启动时需加 --allow-kb-write）");
    }

    const type = String(input.type ?? "");
    if (!EVIDENCE_TYPES.includes(type as EvidenceType)) {
      return { content: `无效 type "${type}"，合法值: ${EVIDENCE_TYPES.join(" | ")}`, isError: true };
    }

    const title = String(input.title ?? "").trim();
    const content = String(input.content ?? "").trim();
    if (!title || !content) {
      return { content: "title 和 content 不能为空", isError: true };
    }

    const keywords = Array.isArray(input.keywords)
      ? input.keywords.map(String).filter((k) => k.trim().length > 0)
      : [];

    const entry = this.kb.add({
      type: type as EvidenceType,
      title,
      content,
      keywords,
      // 归属标注（ToolContext，Phase 7 接口演进）
      sourceAgent: context?.agentId,
      sourceThread: context?.threadId,
      verified: false, // LLM 写的一律未验证，人工 --kb-verify 背书
    });

    return ok(`已写入知识库（id: ${entry.id}，verified=0 待人工背书）`);
  }
}
