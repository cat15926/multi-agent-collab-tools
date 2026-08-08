/**
 * Phase 5 — Pattern Context（协作模式上下文）
 *
 * 定义 Pattern 执行时所需的上下文信息
 */

import type { Agent } from "../agent/agent.js";

/** Pattern 执行上下文 */
export interface PatternContext {
  /** 用户任务描述 */
  task: string;
  /** 参与协作的 Agent 列表 */
  agents: Agent[];
  /** 会话 ID */
  threadId: string;
  /** Pattern 特定配置 */
  config: PatternConfig;
  /** 会话历史（用于构建上下文） */
  history?: PatternHistoryItem[];
}

/** Pattern 配置（不同 Pattern 有不同配置） */
export interface PatternConfig {
  /** Pattern 名称 */
  patternName: string;
  /** 最大执行时间（秒） */
  timeout?: number;
  /** 是否启用 A2A（混合模式） */
  a2aEnabled?: boolean;
  /** 其他配置项 */
  [key: string]: unknown;
}

/** 会话历史项（简化版 Message） */
export interface PatternHistoryItem {
  id: string;
  role: "user" | "assistant";
  agentId?: string;
  content: string;
  timestamp: number;
}
