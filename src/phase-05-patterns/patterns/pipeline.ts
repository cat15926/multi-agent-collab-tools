/**
 * Phase 5 — Pipeline Pattern（顺序流水线）
 *
 * A → B → C
 * 前一个 Agent 的输出作为下一个 Agent 的输入
 */

import type { Agent } from "../agent/agent.js";
import { BasePattern, type ValidationResult } from "../pattern/base.js";
import type { PatternContext, PatternConfig } from "../pattern/context.js";
import type { PatternResult } from "../pattern/result.js";

/** Pipeline Pattern 配置 */
export interface PipelineConfig extends PatternConfig {
  /** Agent 执行顺序（留空则使用 agents 列表顺序） */
  agentOrder?: string[];
  /** 单步失败时是否继续（默认 false） */
  continueOnError?: boolean;
  /** 是否在每步后显示进度（默认 true） */
  showProgress?: boolean;
}

/**
 * Pipeline Pattern 实现
 *
 * 场景：写代码 → 审查 → 测试
 */
export class PipelinePattern extends BasePattern {
  name = "pipeline";
  description = "顺序流水线：Agent 按顺序执行，前一个的输出是下一个的输入";

  /**
   * 执行 Pipeline Pattern
   */
  protected async executePattern(
    context: PatternContext,
    result: PatternResult
  ): Promise<void> {
    const config = context.config as PipelineConfig;
    const { agents, task } = context;

    // 确定执行顺序
    const agentOrder = config.agentOrder || agents.map((a) => a.id);
    const orderedAgents = agentOrder
      .map((id) => this.findAgent(id, agents))
      .filter((a): a is Agent => a !== undefined);

    if (orderedAgents.length === 0) {
      result.failureReason = "没有可用的 Agent";
      return;
    }

    // 顺序执行
    let currentInput = task;
    let stepNumber = 1;

    for (const agent of orderedAgents) {
      const step = await this.executeAgent(
        agent,
        currentInput,
        context,
        stepNumber
      );

      result.steps.push(step);

      if (!step.success) {
        if (!config.continueOnError) {
          result.failureReason = `Agent ${agent.id} 执行失败: ${step.error || "未知错误"}`;
          return;
        }
        // 继续执行，使用空输出
        currentInput = `[${agent.id} 执行失败，跳过]`;
      } else {
        currentInput = step.output;
      }

      stepNumber++;
    }

    // 最终输出是最后一个 Agent 的输出
    const lastStep = result.steps[result.steps.length - 1];
    result.finalOutput = lastStep?.success ? lastStep.output : currentInput;
  }

  /**
   * 验证 Pipeline 配置
   */
  validateConfig(config: PatternConfig): ValidationResult {
    const errors: string[] = [];

    // 基础验证
    const baseResult = { valid: !!config.patternName, errors: config.patternName ? [] : ["缺少 patternName"] };
    if (!baseResult.valid) {
      return baseResult;
    }

    // Pipeline 特定验证
    const pipelineConfig = config as PipelineConfig;

    if (pipelineConfig.agentOrder) {
      if (!Array.isArray(pipelineConfig.agentOrder)) {
        errors.push("agentOrder 必须是数组");
      }
    }

    if (pipelineConfig.continueOnError !== undefined) {
      if (typeof pipelineConfig.continueOnError !== "boolean") {
        errors.push("continueOnError 必须是布尔值");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
