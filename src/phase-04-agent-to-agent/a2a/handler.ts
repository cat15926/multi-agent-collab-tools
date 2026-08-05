/**
 * Phase 4 — A2A Handler（A2A 处理器）
 *
 * 职责：
 * - 处理 Agent 间的协作流转
 * - 记录协作链
 * - 执行协作决策
 * - 管理协作深度
 */

import type { AgentRegistry } from "../registry/agent-registry.js";
import type { ThreadManager } from "../thread/manager.js";
import type { Storage, Message } from "../storage/sqlite.js";
import type { Agent } from "../agent/agent.js";
import type { A2AConfig, DecisionResult } from "./decider.js";
import { A2ADecision } from "./decider.js";
import type { A2AParseResult } from "./parser.js";

/** A2A 上下文 */
export interface A2AContext {
  /** 当前会话 ID */
  threadId: string;
  /** 触发协作的 Agent ID */
  sourceAgentId: string;
  /** 触发协作的消息 ID */
  triggerMessageId: string;
  /** 当前协作深度 */
  depth: number;
  /** 会话历史 */
  history: Message[];
  /** 会话参与者 */
  participants: string[];
}

/** A2A 处理结果 */
export interface A2AResult {
  /** 是否继续协作 */
  continued: boolean;
  /** 触发的下一个 Agent ID 列表 */
  nextAgentIds?: string[];
  /** 协作链记录 */
  chains?: {
    sourceAgentId: string;
    targetAgentId: string;
  }[];
  /** 决策结果 */
  decision: DecisionResult;
}

export class A2AHandler {
  constructor(
    private registry: AgentRegistry,
    private threads: ThreadManager,
    private storage: Storage,
    private config: A2AConfig
  ) {}

  /**
   * 处理 A2A 协作
   * @param sourceAgentId 发起协作的 Agent
   * @param parseResult A2A 解析结果
   * @param context A2A 上下文
   * @param agentFactory Agent 工厂函数
   */
  async handle(
    sourceAgentId: string,
    parseResult: A2AParseResult,
    context: A2AContext,
    agentFactory: (agentId: string) => Agent
  ): Promise<A2AResult> {
    // 1. 创建决策器并决策
    const { A2ADecider } = await import("./decider.js");
    const decider = new A2ADecider();
    const decision = decider.decide({
      mentions: parseResult.mentions,
      depth: context.depth,
      shouldTrigger: parseResult.shouldTrigger,
      config: this.config,
    });

    // 2. 如果决策是停止，直接返回
    if (decision.decision === A2ADecision.STOP) {
      return {
        continued: false,
        decision,
      };
    }

    // 3. 如果决策是确认，返回等待用户确认
    if (decision.decision === A2ADecision.CONFIRM) {
      return {
        continued: false,
        nextAgentIds: decision.targets,
        decision,
      };
    }

    // 4. 决策是继续，执行协作
    const chains: { sourceAgentId: string; targetAgentId: string }[] = [];
    const nextAgentIds = decision.targets || [];

    // 5. 记录协作链
    for (const targetAgentId of nextAgentIds) {
      // 先确保 Agent 在数据库中存在
      const agentConfig = this.registry.get(targetAgentId);
      if (agentConfig) {
        this.storage.upsertAgent(agentConfig);
      }

      const chain = this.storage.addA2AChain({
        threadId: context.threadId,
        sourceAgentId,
        targetAgentId,
        triggerMessageId: context.triggerMessageId,
      });
      chains.push({
        sourceAgentId: chain.sourceAgentId,
        targetAgentId: chain.targetAgentId,
      });

      // 添加目标 Agent 到会话参与者
      await this.threads.addParticipant(context.threadId, targetAgentId);
    }

    // 6. 唤醒下一个 Agent（简化版：只唤醒第一个）
    // Phase 5 可以支持并行唤醒多个 Agent
    if (nextAgentIds.length > 0) {
      const nextAgentId = nextAgentIds[0];
      const nextAgent = agentFactory(nextAgentId);

      // 构建新的上下文
      const newContext: A2AContext = {
        ...context,
        sourceAgentId: nextAgentId,
        depth: context.depth + 1,
      };

      // 获取目标 Agent 的回复
      // 注意：这里需要从原始消息中提取"真正的内容"（移除 @mention）
      const triggerMessage = context.history.find(
        (m) => m.id === context.triggerMessageId
      );
      const content = triggerMessage?.content || "";

      const reply = await nextAgent.reply(content, {
        threadId: context.threadId,
        participants: context.participants,
        history: context.history,
        hasMention: true,
      });

      // 存储下一个 Agent 的回复
      this.storage.addMessage({
        conversationId: context.threadId,
        role: "assistant",
        agentId: nextAgentId,
        content: reply,
        a2aSource: sourceAgentId,
      });
    }

    return {
      continued: true,
      nextAgentIds,
      chains,
      decision,
    };
  }

  /**
   * 获取会话的协作链历史
   */
  getChainHistory(threadId: string) {
    return this.storage.getA2AChains(threadId);
  }

  /**
   * 格式化协作链为可读文本
   */
  formatChainHistory(threadId: string): string {
    const chains = this.getChainHistory(threadId);

    if (chains.length === 0) {
      return "（无协作链）";
    }

    const lines: string[] = [];
    for (const chain of chains) {
      const source = this.registry.get(chain.sourceAgentId);
      const target = this.registry.get(chain.targetAgentId);

      const sourceName = source ? `${source.emoji} ${source.name}` : chain.sourceAgentId;
      const targetName = target ? `${target.emoji} ${target.name}` : chain.targetAgentId;

      lines.push(`  • ${sourceName} → ${targetName}`);
    }

    return lines.join("\n");
  }
}
