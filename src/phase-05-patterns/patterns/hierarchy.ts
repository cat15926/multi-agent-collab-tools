/**
 * Phase 5 — Hierarchy Pattern（层级分工模式）
 *
 * Manager → Workers → Manager
 * 管理者分解任务，工作者执行，管理者汇总结果
 */

import type { Agent } from "../agent/agent.js";
import { BasePattern, type ValidationResult } from "../pattern/base.js";
import type { PatternContext, PatternConfig } from "../pattern/context.js";
import type { PatternResult } from "../pattern/result.js";

/** Hierarchy Pattern 配置 */
export interface HierarchyConfig extends PatternConfig {
  /** 管理者 Agent ID */
  manager: string;
  /** 工作者 Agent ID 列表 */
  workers: string[];
  /** 是否自动分解任务（默认 true） */
  autoDecompose?: boolean;
  /** 任务分解提示词（可选） */
  decompositionPrompt?: string;
}

/** 任务分解结果 */
interface TaskDecomposition {
  tasks: Array<{
    id: string;
    description: string;
    assignedTo: string;
  }>;
}

/**
 * Hierarchy Pattern 实现
 *
 * 场景：架构师拆需求，开发 Agent 并行实现，架构师汇总
 */
export class HierarchyPattern extends BasePattern {
  name = "hierarchy";
  description = "层级分工：管理者分解任务，工作者执行，管理者汇总";

  /**
   * 执行 Hierarchy Pattern
   */
  protected async executePattern(
    context: PatternContext,
    result: PatternResult
  ): Promise<void> {
    const config = context.config as HierarchyConfig;
    const { agents, task } = context;

    // 验证管理者
    const manager = this.findAgent(config.manager, agents);
    if (!manager) {
      result.failureReason = `找不到管理者 Agent: ${config.manager}`;
      return;
    }

    // 验证工作者
    const workers = config.workers
      .map((id) => this.findAgent(id, agents))
      .filter((a): a is Agent => a !== undefined);

    if (workers.length === 0) {
      result.failureReason = "没有可用的工作者 Agent";
      return;
    }

    let stepNumber = 1;

    // Step 1: 管理者分解任务
    const decompositionInput = this.buildDecompositionInput(task, workers, config);
    const decompositionStep = await this.executeAgent(
      manager,
      decompositionInput,
      context,
      stepNumber++
    );

    result.steps.push(decompositionStep);

    if (!decompositionStep.success) {
      result.failureReason = `任务分解失败: ${decompositionStep.error || "未知错误"}`;
      return;
    }

    // 解析任务分解结果
    const decomposition = this.parseDecomposition(decompositionStep.output, workers, result);

    if (decomposition.tasks.length === 0) {
      result.failureReason = "管理者未生成有效的任务分解";
      result.finalOutput = decompositionStep.output;
      return;
    }

    // Step 2: 工作者并行执行任务
    const workerPromises = decomposition.tasks.map((taskItem) => {
      const worker = this.findAgent(taskItem.assignedTo, agents);
      if (!worker) {
        return Promise.reject(new Error(`找不到工作者: ${taskItem.assignedTo}`));
      }
      return this.executeAgent(worker, taskItem.description, context, stepNumber++);
    });

    const workerSteps = await Promise.all(workerPromises);
    result.steps.push(...workerSteps);

    // 检查工作者执行结果
    const failedWorkers = workerSteps.filter((s) => !s.success);
    if (failedWorkers.length > 0) {
      result.failureReason = `${failedWorkers.length} 个工作者任务失败`;
      // 继续汇总，让管理者决定
    }

    // Step 3: 管理者汇总结果
    const summaryInput = this.buildSummaryInput(task, decomposition, workerSteps);
    const summaryStep = await this.executeAgent(manager, summaryInput, context, stepNumber++);

    result.steps.push(summaryStep);

    if (!summaryStep.success) {
      result.failureReason = `结果汇总失败: ${summaryStep.error || "未知错误"}`;
      return;
    }

    result.finalOutput = summaryStep.output;
  }

  /**
   * 构建任务分解输入
   */
  private buildDecompositionInput(
    task: string,
    workers: Agent[],
    config: HierarchyConfig
  ): string {
    let input = `请将以下任务分解，分配给各个工作者：\n\n`;
    input += `## 主任务\n${task}\n\n`;
    input += `## 可用工作者\n`;

    for (const worker of workers) {
      input += `- @${worker.id}\n`;
    }

    if (config.decompositionPrompt) {
      input += `\n## 分解要求\n${config.decompositionPrompt}\n`;
    }

    input += `\n请**严格**按以下格式输出任务分配（每行一个标签，不要加粗、不要列表符号）：\n`;
    input += `<task agent="workerName">任务描述</task>\n`;
    input += `<task agent="workerName">任务描述</task>\n`;
    input += `（workerName 必须是上面列出的 @id）\n\n`;

    return input;
  }

  /**
   * 解析任务分解结果（修复 P5-001）
   *
   * 两级解析：
   * 1. 结构化标签（治本）：`<task agent="bob">任务</task>` —— 提示词明确要求此格式
   * 2. 容错正则（兜底）：剥离 markdown 装饰后匹配 `@worker: 任务`，兼容全角冒号
   * 全部失败 → 兜底广播全量任务，但**显形**（console.warn + metadata 标记），不再静默
   */
  private parseDecomposition(
    output: string,
    workers: Agent[],
    result: PatternResult
  ): TaskDecomposition {
    const tasks: TaskDecomposition["tasks"] = [];
    const workerIds = workers.map((w) => w.id);

    // 一级：结构化标签 <task agent="bob">任务</task>
    const tagPattern = /<task\s+agent=["']([\w-]+)["']\s*>\s*([\s\S]*?)\s*<\/task>/g;
    for (const m of output.matchAll(tagPattern)) {
      const [, workerId, description] = m;
      if (workerIds.includes(workerId)) {
        tasks.push({
          id: `task-${tasks.length + 1}`,
          description: description.trim(),
          assignedTo: workerId,
        });
      }
    }

    // 二级：容错正则（标签缺失时）— 剥离 markdown 装饰 + 兼容全角冒号
    if (tasks.length === 0) {
      const linePattern = /@([\w-]+)\s*[:：]\s*(.+)/;
      for (const line of output.split("\n")) {
        const cleaned = line.replace(/\*\*|__|\*|_/g, "");
        const match = cleaned.match(linePattern);
        if (match) {
          const [, workerId, description] = match;
          if (workerIds.includes(workerId)) {
            tasks.push({
              id: `task-${tasks.length + 1}`,
              description: description.trim(),
              assignedTo: workerId,
            });
          }
        }
      }
    }

    // 兜底：广播全量任务（保命，但必须显形 — 修复 P5-001 的静默问题）
    if (tasks.length === 0) {
      console.warn(
        `[hierarchy] ⚠️ 任务拆解解析失败（未识别到标签或 @worker: 格式），触发兜底：` +
          `所有工作者将收到完整任务。请检查管理者输出格式。`
      );
      result.metadata.decompositionFallback = true;
      for (const worker of workers) {
        tasks.push({
          id: `task-${tasks.length + 1}`,
          description: output,
          assignedTo: worker.id,
        });
      }
    }

    return { tasks };
  }

  /**
   * 构建汇总输入
   */
  private buildSummaryInput(
    originalTask: string,
    decomposition: TaskDecomposition,
    workerSteps: any[]
  ): string {
    let input = `请汇总以下工作者的执行结果：\n\n`;
    input += `## 原始任务\n${originalTask}\n\n`;
    input += `## 工作者执行结果\n\n`;

    for (let i = 0; i < workerSteps.length; i++) {
      const step = workerSteps[i];
      const task = decomposition.tasks[i];

      input += `### @${task.assignedTo} - ${task.id}\n`;
      input += `任务: ${task.description}\n\n`;
      input += `结果: ${step.success ? step.output : `[失败] ${step.error}`}\n\n`;
    }

    input += `\n请基于以上结果，给出最终的综合结论或完成的工作。`;

    return input;
  }

  /**
   * 验证 Hierarchy 配置
   */
  validateConfig(config: PatternConfig): ValidationResult {
    const errors: string[] = [];

    // 基础验证
    const baseResult = { valid: !!config.patternName, errors: config.patternName ? [] : ["缺少 patternName"] };
    if (!baseResult.valid) {
      return baseResult;
    }

    // Hierarchy 特定验证
    const hierarchyConfig = config as HierarchyConfig;

    if (!hierarchyConfig.manager || typeof hierarchyConfig.manager !== "string") {
      errors.push("必须指定 manager（管理者 Agent ID）");
    }

    if (!hierarchyConfig.workers || !Array.isArray(hierarchyConfig.workers)) {
      errors.push("必须指定 workers（工作者 Agent ID 列表）");
    } else if (hierarchyConfig.workers.length === 0) {
      errors.push("workers 列表不能为空");
    }

    if (hierarchyConfig.manager && hierarchyConfig.workers?.includes(hierarchyConfig.manager)) {
      errors.push("manager 不能同时是 worker");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
