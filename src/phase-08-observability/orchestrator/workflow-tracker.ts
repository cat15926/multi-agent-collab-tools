/**
 * Phase 5 — Workflow Tracker（工作流追踪器）
 *
 * 追踪 Pattern 执行状态和中间结果
 */

import type { PatternResult, PatternStep } from "../pattern/index.js";

/** 工作流状态 */
export enum WorkflowStatus {
  /** 等待执行 */
  PENDING = "pending",
  /** 执行中 */
  RUNNING = "running",
  /** 已完成 */
  COMPLETED = "completed",
  /** 执行失败 */
  FAILED = "failed",
  /** 已取消 */
  CANCELLED = "cancelled",
}

/** 工作流执行记录 */
export interface WorkflowExecution {
  /** 执行 ID */
  id: string;
  /** 会话 ID */
  threadId: string;
  /** Pattern 名称 */
  patternName: string;
  /** 任务描述 */
  task: string;
  /** 参与 Agent 列表 */
  agents: string[];
  /** 状态 */
  status: WorkflowStatus;
  /** 开始时间 */
  startedAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 执行结果 */
  result?: PatternResult;
  /** 错误信息 */
  error?: string;
}

/**
 * 工作流追踪器
 *
 * 负责记录和查询 Pattern 执行状态
 */
export class WorkflowTracker {
  private executions: Map<string, WorkflowExecution> = new Map();

  /**
   * 创建新的工作流执行
   */
  createExecution(
    id: string,
    threadId: string,
    patternName: string,
    task: string,
    agents: string[]
  ): WorkflowExecution {
    const execution: WorkflowExecution = {
      id,
      threadId,
      patternName,
      task,
      agents,
      status: WorkflowStatus.PENDING,
      startedAt: Date.now(),
    };

    this.executions.set(id, execution);
    return execution;
  }

  /**
   * 开始执行
   */
  startExecution(id: string): void {
    const execution = this.executions.get(id);
    if (execution) {
      execution.status = WorkflowStatus.RUNNING;
      execution.startedAt = Date.now();
    }
  }

  /**
   * 完成执行
   */
  completeExecution(id: string, result: PatternResult): void {
    const execution = this.executions.get(id);
    if (execution) {
      execution.status = result.success ? WorkflowStatus.COMPLETED : WorkflowStatus.FAILED;
      execution.completedAt = Date.now();
      execution.result = result;
      if (!result.success) {
        execution.error = result.failureReason;
      }
    }
  }

  /**
   * 取消执行
   */
  cancelExecution(id: string, reason?: string): void {
    const execution = this.executions.get(id);
    if (execution) {
      execution.status = WorkflowStatus.CANCELLED;
      execution.completedAt = Date.now();
      execution.error = reason || "用户取消";
    }
  }

  /**
   * 获取执行记录
   */
  getExecution(id: string): WorkflowExecution | undefined {
    return this.executions.get(id);
  }

  /**
   * 获取会话的所有执行记录
   */
  getExecutionsByThread(threadId: string): WorkflowExecution[] {
    return Array.from(this.executions.values())
      .filter((e) => e.threadId === threadId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * 获取正在运行的执行记录
   */
  getRunningExecutions(): WorkflowExecution[] {
    return Array.from(this.executions.values()).filter(
      (e) => e.status === WorkflowStatus.RUNNING
    );
  }

  /**
   * 删除执行记录
   */
  deleteExecution(id: string): boolean {
    return this.executions.delete(id);
  }

  /**
   * 清空所有执行记录
   */
  clear(): void {
    this.executions.clear();
  }
}
