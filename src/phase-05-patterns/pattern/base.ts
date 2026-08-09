/**
 * Phase 5 — Pattern Base（协作模式基类）
 *
 * 定义 Pattern 接口和基类实现
 */

import type { Agent } from "../agent/agent.js";
import type { PatternContext, PatternConfig } from "./context.js";
import type { PatternResult, PatternStep } from "./result.js";
import { createEmptyPatternResult, createPatternStep } from "./result.js";
import type { Message } from "../storage/sqlite.js";

/**
 * Pattern 接口
 *
 * 所有协作模式都必须实现此接口
 */
export interface Pattern {
  /** Pattern 唯一标识 */
  name: string;
  /** Pattern 描述 */
  description: string;
  /**
   * 执行 Pattern
   * @param context 执行上下文
   * @returns 执行结果
   */
  execute(context: PatternContext): Promise<PatternResult>;
  /**
   * 验证配置是否有效
   * @param config 配置对象
   * @returns 验证结果
   */
  validateConfig(config: PatternConfig): ValidationResult;
}

/** 配置验证结果 */
export interface ValidationResult {
  /** 是否有效 */
  valid: boolean;
  /** 错误信息（无效时） */
  errors: string[];
}

/**
 * Pattern 抽象基类
 *
 * 提供通用的执行框架和辅助方法
 */
export abstract class BasePattern implements Pattern {
  abstract name: string;
  abstract description: string;

  /**
   * 执行 Pattern（模板方法）
   */
  async execute(context: PatternContext): Promise<PatternResult> {
    const startTime = Date.now();
    const result = createEmptyPatternResult(this.name);

    // 设置元数据
    result.metadata.startedAt = startTime;
    result.metadata.agents = context.agents.map((a) => a.id);
    result.metadata.config = { ...context.config };

    try {
      // 1. 验证配置
      const validation = this.validateConfig(context.config);
      if (!validation.valid) {
        result.failureReason = `配置验证失败: ${validation.errors.join(", ")}`;
        return result;
      }

      // 2. 执行具体 Pattern 逻辑
      await this.executePattern(context, result);

      // 3. 更新元数据
      result.metadata.completedAt = Date.now();
      result.metadata.duration = result.metadata.completedAt - startTime;
      result.metadata.totalTokenUsage = result.steps.reduce(
        (sum, step) => sum + (step.tokenUsage || 0),
        0
      );

      result.success = true;
    } catch (error) {
      result.success = false;
      result.failureReason = error instanceof Error ? error.message : String(error);
      result.metadata.completedAt = Date.now();
      result.metadata.duration = result.metadata.completedAt - startTime;
    }

    return result;
  }

  /**
   * 执行具体 Pattern 逻辑（由子类实现）
   */
  protected abstract executePattern(
    context: PatternContext,
    result: PatternResult
  ): Promise<void>;

  /**
   * 验证配置（由子类实现）
   */
  abstract validateConfig(config: PatternConfig): ValidationResult;

  /**
   * 执行单个 Agent 调用
   */
  protected async executeAgent(
    agent: Agent,
    input: string,
    context: PatternContext,
    stepNumber: number
  ): Promise<PatternStep> {
    const startTime = Date.now();
    const events = context.events;

    events?.onStepStart?.({ stepNumber, agentId: agent.id, input });

    try {
      // 调用 Agent
      const output = await agent.reply(input, {
        threadId: context.threadId,
        participants: context.agents.map((a) => a.id),
        history: (context.history || []) as any, // PatternHistoryItem compatible with Message
        hasMention: false,
      });

      const duration = Date.now() - startTime;
      events?.onStepComplete?.({ stepNumber, agentId: agent.id, output, success: true, duration });

      return createPatternStep(stepNumber, agent.id, input, output, duration, true);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      events?.onStepComplete?.({ stepNumber, agentId: agent.id, output: "", success: false, duration, error: errorMsg });

      return createPatternStep(
        stepNumber,
        agent.id,
        input,
        "",
        duration,
        false
      );
    }
  }

  /**
   * 查找 Agent
   */
  protected findAgent(agentId: string, agents: Agent[]): Agent | undefined {
    return agents.find((a) => a.id === agentId);
  }
}
