/**
 * Phase 7 — Knowledge 类型定义（零 import，防循环依赖）
 *
 * 对应「核心心智模型」抽象 ④ Shared State 的长期层（KnowledgeBase）。
 * docs/architecture/core-abstractions.md 的 Evidence 草图超集：
 * +title（展示/检索）、+keywords（结构化检索主路径）、+sourceAgent（溯源）。
 */

/** 知识条目类型（与 core-abstractions.md Evidence.type 一致） */
export type EvidenceType = "decision" | "lesson" | "observation" | "outcome";

export const EVIDENCE_TYPES: EvidenceType[] = [
  "decision",
  "lesson",
  "observation",
  "outcome",
];

/** 知识条目（长期共享记忆的最小单元） */
export interface Evidence {
  id: string;
  type: EvidenceType;
  /** 短标题（≤20 字，展示与检索用） */
  title: string;
  /** 自包含内容（脱离原会话可读） */
  content: string;
  /** 检索主路径：结构化关键词 */
  keywords: string[];
  /** 来源会话（手动添加为 undefined） */
  sourceThread?: string;
  /** 产出者：agent id / 'user' / 'distiller' */
  sourceAgent?: string;
  /** 毫秒时间戳（沿 tool_calls 惯例，吸取 ADR-007 教训） */
  timestamp: number;
  /** 人工背书（--kb-verify / 手动添加 = true；LLM 产出 = false） */
  verified?: boolean;
}

/** 新增条目（id/timestamp 由库生成） */
export type NewEvidence = Omit<Evidence, "id" | "timestamp">;

/** 知识库统计 */
export interface KbStats {
  total: number;
  byType: Record<EvidenceType, number>;
  /** 有来源会话的不同线程数 */
  threads: number;
  verified: number;
  lastAddedAt?: number;
}

/** 检索命中（带评分，可观测检索质量） */
export interface KbSearchHit {
  entry: Evidence;
  score: number;
}

/** 提炼条目（Distiller 输出，写库前的中间形态） */
export interface DistillEntry {
  type: EvidenceType;
  title: string;
  content: string;
  keywords?: string[];
}

/** 提炼运行状态（kb_distill_runs.status） */
export type DistillStatus =
  | "ok"
  | "parse_failed"
  | "skipped_empty"
  | "error"
  | "duplicate_skipped";
