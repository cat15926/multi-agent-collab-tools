/**
 * Phase 5 — Debate Pattern（辩论模式）
 *
 * A ↔ B
 * 两个 Agent 多轮对抗，直到收敛或达到最大轮数
 */

import type { Agent } from "../agent/agent.js";
import { BasePattern, type ValidationResult } from "../pattern/base.js";
import type { PatternContext, PatternConfig } from "../pattern/context.js";
import type { PatternResult } from "../pattern/result.js";

/** Debate Pattern 配置 */
export interface DebateConfig extends PatternConfig {
  /** 辩论方 A 的 Agent ID */
  agentA: string;
  /** 辩论方 B 的 Agent ID */
  agentB: string;
  /** 最大辩论轮数（默认 3） */
  maxRounds?: number;
  /** 收敛阈值（0-1，默认 0.8） */
  convergenceThreshold?: number;
  /** 初始立场分配（可选） */
  initialStance?: {
    agentA?: string;
    agentB?: string;
  };
}

/**
 * Debate Pattern 实现
 *
 * 场景：方案 A vs 方案 B，两个 Agent 互驳
 */
export class DebatePattern extends BasePattern {
  name = "debate";
  description = "辩论模式：两个 Agent 多轮对抗，直到收敛或达到最大轮数";

  /**
   * 执行 Debate Pattern
   */
  protected async executePattern(
    context: PatternContext,
    result: PatternResult
  ): Promise<void> {
    const config = context.config as DebateConfig;
    const { agents, task } = context;

    // 验证辩论双方
    const agentA = this.findAgent(config.agentA, agents);
    const agentB = this.findAgent(config.agentB, agents);

    if (!agentA || !agentB) {
      result.failureReason = `找不到辩论方 Agent: ${!agentA ? config.agentA : config.agentB}`;
      return;
    }

    const maxRounds = config.maxRounds || 3;
    let stepNumber = 1;

    // 构建初始输入
    let inputA = config.initialStance?.agentA
      ? `${task}\n\n你的初始立场：${config.initialStance.agentA}`
      : task;

    let inputB = config.initialStance?.agentB
      ? `${task}\n\n你的初始立场：${config.initialStance.agentB}`
      : task;

    // 添加辩论说明
    const debateInstructions = "\n\n请与对方进行辩论，分析对方观点并强化自己的论点。";

    inputA += debateInstructions;
    inputB += debateInstructions;

    // 辩论历史
    const historyA: string[] = [];
    const historyB: string[] = [];

    // 多轮辩论
    for (let round = 1; round <= maxRounds; round++) {
      // Agent A 发言
      const inputWithHistoryA = this.buildInputWithHistory(inputA, historyB, "对方");
      const stepA = await this.executeAgent(agentA, inputWithHistoryA, context, stepNumber++);
      result.steps.push(stepA);

      if (!stepA.success) {
        result.failureReason = `Agent ${agentA.id} 执行失败`;
        return;
      }

      historyA.push(stepA.output);

      // Agent B 发言
      const inputWithHistoryB = this.buildInputWithHistory(inputB, historyA, "对方");
      const stepB = await this.executeAgent(agentB, inputWithHistoryB, context, stepNumber++);
      result.steps.push(stepB);

      if (!stepB.success) {
        result.failureReason = `Agent ${agentB.id} 执行失败`;
        return;
      }

      historyB.push(stepB.output);

      // 检查收敛（简化版：检查是否达成一致）
      if (this.hasConverged(stepA.output, stepB.output)) {
        result.finalOutput = this.buildDebateSummary(historyA, historyB, true);
        return;
      }
    }

    // 达到最大轮数，输出辩论总结
    result.finalOutput = this.buildDebateSummary(historyA, historyB, false);
  }

  /**
   * 构建带历史的输入
   */
  private buildInputWithHistory(
    baseInput: string,
    opponentHistory: string[],
    opponentLabel: string
  ): string {
    if (opponentHistory.length === 0) {
      return baseInput;
    }

    let input = baseInput;
    input += `\n\n${opponentLabel}的观点：\n`;

    for (let i = 0; i < opponentHistory.length; i++) {
      input += `\n[${i + 1}] ${opponentHistory[i]}\n`;
    }

    input += "\n请回应对方观点。";
    return input;
  }

  /**
   * 简化的收敛检测（检查关键词）
   */
  private hasConverged(outputA: string, outputB: string): boolean {
    const agreementKeywords = ["同意", "认同", "达成一致", "converge", "agree"];
    const lowerA = outputA.toLowerCase();
    const lowerB = outputB.toLowerCase();

    return agreementKeywords.some(
      (keyword) => lowerA.includes(keyword) && lowerB.includes(keyword)
    );
  }

  /**
   * 构建辩论总结
   */
  private buildDebateSummary(
    historyA: string[],
    historyB: string[],
    converged: boolean
  ): string {
    let summary = `## 辩论总结\n\n`;
    summary += converged ? "双方已达成一致。" : "双方未达成一致，辩论结束。";
    summary += `\n\n### 辩论记录\n\n`;

    for (let i = 0; i < Math.max(historyA.length, historyB.length); i++) {
      if (historyA[i]) {
        summary += `**方 A 第 ${i + 1} 轮**:\n${historyA[i]}\n\n`;
      }
      if (historyB[i]) {
        summary += `**方 B 第 ${i + 1} 轮**:\n${historyB[i]}\n\n`;
      }
    }

    return summary;
  }

  /**
   * 验证 Debate 配置
   */
  validateConfig(config: PatternConfig): ValidationResult {
    const errors: string[] = [];

    // 基础验证
    const baseResult = { valid: !!config.patternName, errors: config.patternName ? [] : ["缺少 patternName"] };
    if (!baseResult.valid) {
      return baseResult;
    }

    // Debate 特定验证
    const debateConfig = config as DebateConfig;

    if (!debateConfig.agentA || typeof debateConfig.agentA !== "string") {
      errors.push("必须指定 agentA（辩论方 A 的 Agent ID）");
    }

    if (!debateConfig.agentB || typeof debateConfig.agentB !== "string") {
      errors.push("必须指定 agentB（辩论方 B 的 Agent ID）");
    }

    if (debateConfig.agentA === debateConfig.agentB) {
      errors.push("agentA 和 agentB 不能是同一个 Agent");
    }

    if (debateConfig.maxRounds !== undefined) {
      if (typeof debateConfig.maxRounds !== "number" || debateConfig.maxRounds < 1) {
        errors.push("maxRounds 必须是大于 0 的数字");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
