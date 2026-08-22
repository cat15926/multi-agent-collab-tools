/**
 * Phase 7 — kb_search 工具（知识库检索，只读免授权）
 *
 * Pull 路径：Agent 在对话中主动查知识库，而不是等系统注入。
 * 与注入（push）正交——注入给"系统认为相关"的，kb_search 让 Agent 自己找。
 */

import type { Tool, ToolResult, ToolContext } from "../tool.js";
import { ok } from "../tool.js";
import type { KnowledgeBase } from "../../knowledge/knowledge-base.js";
import type { EvidenceType } from "../../knowledge/types.js";
import { EVIDENCE_TYPES } from "../../knowledge/types.js";

export class KbSearchTool implements Tool {
  name = "kb_search";
  description =
    "搜索团队共享的长期知识库（过往会话沉淀的决策/教训/经验）。当问题涉及'之前怎么决定的''踩过什么坑''上次的结果'时调用。";
  inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "检索词（项目主题、技术名词等）" },
      type: {
        type: "string",
        description: "条目类型过滤（可选）: decision | lesson | observation | outcome",
      },
      limit: { type: "number", description: "返回条数上限（默认 5）" },
    },
    required: ["query"],
  };

  constructor(private kb: KnowledgeBase) {}

  async execute(input: Record<string, unknown>, _context?: ToolContext): Promise<ToolResult> {
    const query = String(input.query ?? "").trim();
    if (!query) return { content: "query 不能为空", isError: true };

    let type: EvidenceType | undefined;
    if (input.type !== undefined) {
      const t = String(input.type);
      if (!EVIDENCE_TYPES.includes(t as EvidenceType)) {
        return { content: `无效 type "${t}"，合法值: ${EVIDENCE_TYPES.join(" | ")}`, isError: true };
      }
      type = t as EvidenceType;
    }

    const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 5;
    const hits = this.kb.search(query, { limit, type });

    if (hits.length === 0) {
      return ok(`知识库中未找到与 "${query}" 相关的条目。`);
    }

    const lines = hits.map(
      (h) =>
        `- [${h.entry.type}] ${h.entry.title}（相关度 ${h.score}）\n  ${h.entry.content}`
    );
    return ok(`找到 ${hits.length} 条（知识库共有 ${this.kb.stats().total} 条）：\n${lines.join("\n")}`);
  }
}
