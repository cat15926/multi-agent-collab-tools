/**
 * Phase 5 — Orchestrator（协作编排器）
 *
 * 负责 Pattern 的调度和执行管理
 */

import type { Pattern, PatternContext, PatternResult, PatternConfig, PatternEvents } from "../pattern/index.js";
import type { Agent } from "../agent/agent.js";
import type { Storage } from "../storage/sqlite.js";
import { PatternRegistry, globalPatternRegistry } from "../pattern/registry.js";
import { WorkflowTracker, WorkflowStatus } from "./workflow-tracker.js";
import type { KnowledgeBase } from "../knowledge/knowledge-base.js";

/** Orchestrator 配置 */
export interface OrchestratorConfig {
  /** Pattern 注册表（默认使用全局注册表） */
  patternRegistry?: PatternRegistry;
  /** 最大执行时间（秒） */
  maxTimeout?: number;
  /** 是否持久化执行记录 */
  persistExecutions?: boolean;
  /** 知识库（Phase 7；提供则每轮 pattern 执行前检索并注入长期记忆） */
  kb?: KnowledgeBase;
}

/**
 * 协作编排器
 *
 * 负责：
 * 1. Pattern 查找和验证
 * 2. 执行上下文构建
 * 3. 执行过程管理
 * 4. 结果持久化
 */
export class Orchestrator {
  private tracker: WorkflowTracker;
  private registry: PatternRegistry;
  private config: OrchestratorConfig;

  constructor(
    private storage: Storage,
    config: OrchestratorConfig = {}
  ) {
    this.config = config;
    this.registry = config.patternRegistry || globalPatternRegistry;
    this.tracker = new WorkflowTracker();
  }

  /**
   * 执行 Pattern
   */
  async executePattern(params: {
    patternName: string;
    task: string;
    agents: Agent[];
    threadId: string;
    config?: PatternConfig;
    events?: PatternEvents;
  }): Promise<PatternResult> {
    const { patternName, task, agents, threadId, config = {}, events } = params;

    // 1. 查找 Pattern
    const pattern = this.registry.get(patternName);
    if (!pattern) {
      throw new Error(`Pattern "${patternName}" 不存在`);
    }

    // 2. 验证配置（添加 patternName）
    const fullConfig = { ...config, patternName };
    const validation = pattern.validateConfig(fullConfig);
    if (!validation.valid) {
      throw new Error(`配置验证失败: ${validation.errors.join(", ")}`);
    }

    // 3. 生成执行 ID
    const executionId = this.generateExecutionId(threadId, patternName);

    // 4. 创建执行记录
    const execution = this.tracker.createExecution(
      executionId,
      threadId,
      patternName,
      task,
      agents.map((a) => a.id)
    );

    // 5. 开始执行
    this.tracker.startExecution(executionId);

    try {
      // 6. 构建上下文（Phase 7：查 KnowledgeBase 注入长期记忆，并落注入审计）
      const memory = this.config.kb
        ? this.config.kb.buildMemoryContext(task, threadId)
        : undefined;

      if (memory && memory.length > 0) {
        console.log(`🧠 注入 ${memory.length} 条长期记忆（pattern:${patternName}）`);
        try {
          this.storage.addKbRead({
            threadId,
            consumer: `pattern:${patternName}`,
            query: task,
            entryIds: memory.map((e) => e.id),
          });
        } catch {
          /* 审计落盘失败不阻塞主流程 */
        }
      }

      const context: PatternContext = {
        task,
        agents,
        threadId,
        config: {
          ...config,
          patternName,
        },
        history: await this.loadHistory(threadId),
        events,
        memory,
      };

      // 7. 执行 Pattern
      const result = await pattern.execute(context);

      // 8. 完成执行
      this.tracker.completeExecution(executionId, result);

      // 9. 持久化执行记录
      if (this.storage && result.success) {
        await this.persistExecution(execution, result);
      }

      return result;
    } catch (error) {
      const failureResult: PatternResult = {
        success: false,
        finalOutput: "",
        steps: [],
        metadata: {
          patternName,
          startedAt: execution.startedAt,
          completedAt: Date.now(),
          duration: 0,
          totalTokenUsage: 0,
          agents: agents.map((a) => a.id),
          config,
        },
        failureReason: error instanceof Error ? error.message : String(error),
      };

      this.tracker.completeExecution(executionId, failureResult);
      throw error;
    }
  }

  /**
   * 获取执行记录
   */
  getExecution(id: string) {
    return this.tracker.getExecution(id);
  }

  /**
   * 获取会话的所有执行记录
   */
  getExecutionsByThread(threadId: string) {
    return this.tracker.getExecutionsByThread(threadId);
  }

  /**
   * 注册 Pattern
   */
  registerPattern(pattern: Pattern): void {
    this.registry.register(pattern);
  }

  /**
   * 列出所有 Pattern
   */
  listPatterns(): string[] {
    return this.registry.listNames();
  }

  /**
   * 获取 Pattern 描述
   */
  describePattern(name: string): string | undefined {
    return this.registry.describe(name);
  }

  /**
   * 生成执行 ID
   */
  private generateExecutionId(threadId: string, patternName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${threadId}-${patternName}-${timestamp}-${random}`;
  }

  /**
   * 加载会话历史
   */
  private async loadHistory(threadId: string): Promise<any[]> {
    if (!this.storage) {
      return [];
    }
    // 从存储加载历史消息
    const messages = await this.storage.getMessages(threadId);
    return messages.map((m) => ({
      id: m.id,
      role: m.role,
      agentId: m.agentId,
      content: m.content,
      timestamp: m.createdAt,
    }));
  }

  /**
   * 持久化执行记录
   */
  private async persistExecution(
    execution: any,
    result: PatternResult
  ): Promise<void> {
    if (!this.storage) {
      return;
    }

    // 存储执行记录
    await this.storage.addWorkflowExecution({
      id: execution.id,
      threadId: execution.threadId,
      patternName: execution.patternName,
      task: execution.task,
      agents: JSON.stringify(execution.agents),
      status: execution.status,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      result: JSON.stringify(result.metadata),
    });

    // 存储执行步骤
    for (const step of result.steps) {
      await this.storage.addWorkflowStep({
        executionId: execution.id,
        stepNumber: step.stepNumber,
        agentId: step.agentId,
        inputText: step.input,
        outputText: step.output,
        timestamp: step.timestamp,
        duration: step.duration,
        success: step.success ? 1 : 0,
        error: step.error || null,
      });
    }
  }
}
