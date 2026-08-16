/**
 * Phase 5 — Parallel Pattern（并行多视角）
 *
 * A, B, C → Aggregator
 * 多个 Agent 并行执行，结果汇总给聚合器
 */

import type { Agent } from "../agent/agent.js";
import { BasePattern, type ValidationResult } from "../pattern/base.js";
import type { PatternContext, PatternConfig } from "../pattern/context.js";
import type { PatternResult } from "../pattern/result.js";

/** Parallel Pattern 配置 */
export interface ParallelConfig extends PatternConfig {
  /** 聚合器 Agent ID（必须指定） */
  aggregator: string;
  /** 是否等待所有 Agent 完成（默认 true） */
  awaitAll?: boolean;
  /** 并发限制（默认无限制） */
  concurrency?: number;
}

/**
 * Parallel Pattern 实现
 *
 * 场景：3 个 Agent 各出方案，汇总给一个 Agent 决策
 */
export class ParallelPattern extends BasePattern {
  name = "parallel";
  description = "并行多视角：多个 Agent 并行执行，结果汇总给聚合器";

  /**
   * 执行 Parallel Pattern
   */
  protected async executePattern(
    context: PatternContext,
    result: PatternResult
  ): Promise<void> {
    const config = context.config as ParallelConfig;
    const { agents, task } = context;

    // 验证聚合器
    const aggregator = this.findAgent(config.aggregator, agents);
    if (!aggregator) {
      result.failureReason = `找不到聚合器 Agent: ${config.aggregator}`;
      return;
    }

    // 获取工作 Agent（排除聚合器）
    const workers = agents.filter((a) => a.id !== config.aggregator);

    if (workers.length === 0) {
      result.failureReason = "没有可用的 Worker Agent";
      return;
    }

    let stepNumber = 1;

    // 并行执行所有 Worker（修复 P5-002：executor 角色 + 输入执行框定）
    const workerPromises = workers.map((worker) => {
      const framedInput =
        `以下任务由你（@${worker.id}）独立完成，请直接给出你的完整方案/结论，` +
        `不要转交他人、不要重新分工：\n\n${task}`;
      return this.executeAgent(worker, framedInput, context, stepNumber++, { role: "executor" });
    });

    // 等待所有 Worker 完成
    const workerSteps = await Promise.all(workerPromises);
    result.steps.push(...workerSteps);

    // 检查是否有失败
    if (config.awaitAll && workerSteps.some((s) => !s.success)) {
      result.failureReason = "部分 Worker Agent 执行失败";
      return;
    }

    // 构建聚合输入
    const aggregationInput = this.buildAggregationInput(workerSteps);

    // 调用聚合器
    const aggregatorStep = await this.executeAgent(
      aggregator,
      aggregationInput,
      context,
      stepNumber
    );

    result.steps.push(aggregatorStep);

    if (!aggregatorStep.success) {
      result.failureReason = `聚合器执行失败: ${aggregatorStep.error || "未知错误"}`;
      return;
    }

    result.finalOutput = aggregatorStep.output;
  }

  /**
   * 构建聚合输入
   */
  private buildAggregationInput(steps: any[]): string {
    let input = "以下是各 Agent 的执行结果：\n\n";

    for (const step of steps) {
      input += `## ${step.agentId}\n${step.output}\n\n`;
    }

    input += "请基于以上结果，给出最终的汇总或决策。";

    return input;
  }

  /**
   * 验证 Parallel 配置
   */
  validateConfig(config: PatternConfig): ValidationResult {
    const errors: string[] = [];

    // 基础验证
    const baseResult = { valid: !!config.patternName, errors: config.patternName ? [] : ["缺少 patternName"] };
    if (!baseResult.valid) {
      return baseResult;
    }

    // Parallel 特定验证
    const parallelConfig = config as ParallelConfig;

    if (!parallelConfig.aggregator || typeof parallelConfig.aggregator !== "string") {
      errors.push("必须指定 aggregator（聚合器 Agent ID）");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
