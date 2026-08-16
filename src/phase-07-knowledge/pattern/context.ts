/**
 * Phase 5 — Pattern Context（协作模式上下文）
 *
 * 定义 Pattern 执行时所需的上下文信息
 */

import type { Agent } from "../agent/agent.js";
import type { Evidence } from "../knowledge/types.js";

/** Pattern 执行期间发出的步骤级事件（可选；用于实时输出/可观测） */
export interface PatternEvents {
  /** 单个 Agent 调用开始时触发 */
  onStepStart?: (info: { stepNumber: number; agentId: string; input: string }) => void;
  /** 单个 Agent 调用完成后触发（成功与失败均触发；失败时 success=false 且带 error） */
  onStepComplete?: (info: {
    stepNumber: number;
    agentId: string;
    output: string;
    success: boolean;
    duration: number;
    error?: string;
  }) => void;
}

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
  /** 执行期事件回调（可选；实时输出用，模式/Agent 代码不得依赖其存在） */
  events?: PatternEvents;
  /** 长期记忆上下文（Phase 7；可选；由 Orchestrator 查 KnowledgeBase 后注入） */
  memory?: Evidence[];
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
