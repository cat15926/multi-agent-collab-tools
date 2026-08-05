/**
 * Phase 4 — A2A Decider（协作决策器）
 *
 * 职责：
 * - 决定是否继续 A2A 协作
 * - 检查深度限制
 * - 根据配置决定下一步行动
 */

/** A2A 决策结果 */
export enum A2ADecision {
  /** 继续协作，自动唤醒下一个 Agent */
  CONTINUE,
  /** 询问用户是否继续 */
  CONFIRM,
  /** 停止协作 */
  STOP,
}

/** A2A 配置 */
export interface A2AConfig {
  /** 协作模式 */
  mode: "auto" | "confirm" | "disabled";
  /** 最大协作深度（防止无限循环） */
  maxDepth: number;
  /** 协作超时（秒） */
  timeout: number;
}

/** 决策参数 */
export interface DecisionParams {
  /** 提取到的 @mention 列表 */
  mentions: string[];
  /** 当前协作深度 */
  depth: number;
  /** 是否应该触发 A2A（由 Parser 判断） */
  shouldTrigger: boolean;
  /** 配置 */
  config: A2AConfig;
}

/** 决策结果（带原因） */
export interface DecisionResult {
  decision: A2ADecision;
  reason: string;
  targets?: string[];
}

export class A2ADecider {
  /**
   * 决定是否继续 A2A 协作
   */
  decide(params: DecisionParams): DecisionResult {
    const { mentions, depth, shouldTrigger, config } = params;

    // 1. 检查是否禁用 A2A
    if (config.mode === "disabled") {
      return {
        decision: A2ADecision.STOP,
        reason: "A2A 已禁用",
      };
    }

    // 2. 检查是否应该触发（由 Parser 判断）
    if (!shouldTrigger) {
      return {
        decision: A2ADecision.STOP,
        reason: "Parser 判断不应触发 A2A",
      };
    }

    // 3. 检查深度限制
    if (depth >= config.maxDepth) {
      return {
        decision: A2ADecision.STOP,
        reason: `已达到最大协作深度 (${config.maxDepth})`,
      };
    }

    // 4. 没有有效的目标，停止
    if (mentions.length === 0) {
      return {
        decision: A2ADecision.STOP,
        reason: "没有有效的 @mention 目标",
      };
    }

    // 5. 根据模式决定
    if (config.mode === "auto") {
      return {
        decision: A2ADecision.CONTINUE,
        reason: "自动模式：继续协作",
        targets: mentions,
      };
    }

    if (config.mode === "confirm") {
      return {
        decision: A2ADecision.CONFIRM,
        reason: "确认模式：等待用户确认",
        targets: mentions,
      };
    }

    // 默认停止
    return {
      decision: A2ADecision.STOP,
      reason: "未知模式",
    };
  }

  /**
   * 创建默认配置
   */
  static defaultConfig(): A2AConfig {
    return {
      mode: "auto",
      maxDepth: 5,
      timeout: 60,
    };
  }

  /**
   * 从命令行参数创建配置
   */
  static fromArgs(args: { noA2a?: boolean; a2aMode?: string }): A2AConfig {
    const config = this.defaultConfig();

    if (args.noA2a) {
      config.mode = "disabled";
    } else if (args.a2aMode === "confirm") {
      config.mode = "confirm";
    } else if (args.a2aMode === "auto") {
      config.mode = "auto";
    } else if (args.a2aMode === "disabled") {
      config.mode = "disabled";
    }

    return config;
  }
}
