/**
 * Phase 5 — Pattern Result（协作模式执行结果）
 *
 * 定义 Pattern 执行后的结果结构
 */

/** Pattern 执行步骤（用于回放/审计） */
export interface PatternStep {
  /** 步骤编号 */
  stepNumber: number;
  /** 执行此步骤的 Agent ID */
  agentId: string;
  /** 输入内容 */
  input: string;
  /** 输出内容 */
  output: string;
  /** 执行时间戳 */
  timestamp: number;
  /** 执行耗时（毫秒） */
  duration: number;
  /** Token 使用（可选） */
  tokenUsage?: number;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（失败时） */
  error?: string;
}

/** Pattern 执行结果 */
export interface PatternResult {
  /** 是否成功完成 */
  success: boolean;
  /** 最终输出 */
  finalOutput: string;
  /** 所有执行步骤 */
  steps: PatternStep[];
  /** 元数据 */
  metadata: PatternMetadata;
  /** 失败原因（success=false 时） */
  failureReason?: string;
}

/** Pattern 元数据 */
export interface PatternMetadata {
  /** Pattern 名称 */
  patternName: string;
  /** 执行开始时间 */
  startedAt: number;
  /** 执行完成时间 */
  completedAt: number;
  /** 总耗时（毫秒） */
  duration: number;
  /** 总 Token 使用 */
  totalTokenUsage: number;
  /** 参与 Agent 列表 */
  agents: string[];
  /** 配置快照 */
  config: Record<string, unknown>;
  /** hierarchy 兜底标记：拆解解析失败时为 true，所有 worker 收到全量任务（修复 P5-001 可观测性） */
  decompositionFallback?: boolean;
}

/** 创建空的 PatternResult（用于初始化） */
export function createEmptyPatternResult(patternName: string): PatternResult {
  return {
    success: false,
    finalOutput: "",
    steps: [],
    metadata: {
      patternName,
      startedAt: Date.now(),
      completedAt: 0,
      duration: 0,
      totalTokenUsage: 0,
      agents: [],
      config: {},
    },
  };
}

/** 创建 PatternStep */
export function createPatternStep(
  stepNumber: number,
  agentId: string,
  input: string,
  output: string,
  duration: number,
  success: boolean = true
): PatternStep {
  return {
    stepNumber,
    agentId,
    input,
    output,
    timestamp: Date.now(),
    duration,
    success,
  };
}
