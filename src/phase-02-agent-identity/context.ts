/**
 * Phase 2 — 上下文窗口管理
 *
 * 职责：
 * - 管理发送给 LLM 的消息历史
 * - 当消息数量超过限制时进行截断
 * - Phase 2 使用简单的"保留最近 N 条"策略
 *
 * Phase 7 升级路径：
 * - 截断 → 摘要（LSM Compaction）
 * - 保留语义重要的消息，而不仅仅是最近的
 */

import type { Message } from "./storage/sqlite.js";

/** 上下文窗口管理选项 */
export interface ContextWindowOptions {
  /** 最大消息条数（默认 50 条，约 8k-10k tokens） */
  maxMessages?: number;
}

/** 消息结构（简化版，用于 LLM API） */
export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export class ContextWindow {
  private readonly maxMessages: number;

  constructor(opts: ContextWindowOptions = {}) {
    this.maxMessages = opts.maxMessages ?? 50;
  }

  /**
   * 根据上下文窗口限制截断消息列表
   *
   * 策略：
   * - 如果消息总数 ≤ maxMessages，全部返回
   * - 否则，返回最近的 maxMessages 条消息
   *
   * Phase 7 升级：保留语义重要的消息（决策、教训、关键上下文）
   */
  truncate(messages: Message[]): LLMMessage[] {
    if (messages.length <= this.maxMessages) {
      return messages.map(toLLMMessage);
    }

    // 返回最近的消息
    const recent = messages.slice(-this.maxMessages);
    return recent.map(toLLMMessage);

    function toLLMMessage(m: Message): LLMMessage {
      return { role: m.role, content: m.content };
    }
  }

  /** 获取当前窗口内的消息数量 */
  getWindowSize(): number {
    return this.maxMessages;
  }

  /** 估算消息列表的 token 数（粗略估算） */
  estimateTokens(messages: LLMMessage[]): number {
    // 中文：约 1.5 字符/token，英文：约 4 字符/token
    // 这里用保守的 2 字符/token 估算
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / 2);
  }
}
