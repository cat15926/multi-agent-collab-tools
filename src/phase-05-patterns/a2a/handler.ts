/**
 * Phase 4 — A2A Handler（A2A 处理器）
 *
 * 职责：
 * - 处理 Agent 间的协作流转
 * - 记录协作链
 * - 执行协作决策
 * - 管理协作深度
 * - 支持多跳链式协作（修复 P4-001）
 */

import type { AgentRegistry } from "../registry/agent-registry.js";
import type { ThreadManager } from "../thread/manager.js";
import type { Storage, Message } from "../storage/sqlite.js";
import type { Agent } from "../agent/agent.js";
import type { A2AConfig, DecisionResult } from "./decider.js";
import { A2ADecider, A2ADecision } from "./decider.js";
import type { A2AParseResult } from "./parser.js";
import { A2AParser } from "./parser.js";

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

/** A2A 处理结果（修复后） */
export interface A2AResult {
  /** 是否继续协作 */
  continued: boolean;
  /** 完成的协作跳数 */
  hopsCompleted: number;
  /** 协作链记录 */
  chains: {
    sourceAgentId: string;
    targetAgentId: string;
  }[];
  /** 每跳的回复（用于返回给用户） */
  replies: {
    agentId: string;
    content: string;
  }[];
  /** 决策结果 */
  finalDecision: DecisionResult;
}

export class A2AHandler {
  private a2aParser: A2AParser;
  private availableIds: Set<string>;

  constructor(
    private registry: AgentRegistry,
    private threads: ThreadManager,
    private storage: Storage,
    private config: A2AConfig
  ) {
    this.a2aParser = new A2AParser();
    this.availableIds = new Set(this.registry.listIds());
  }

  /**
   * 处理 A2A 协作（修复：支持多跳）
   * @param sourceAgentId 发起协作的 Agent
   * @param sourceReply 发起协作的 Agent 的回复内容
   * @param context A2A 上下文
   * @param agentFactory Agent 工厂函数
   */
  async handle(
    sourceAgentId: string,
    sourceReply: string,
    context: A2AContext,
    agentFactory: (agentId: string) => Agent
  ): Promise<A2AResult> {
    const chains: { sourceAgentId: string; targetAgentId: string }[] = [];
    const replies: { agentId: string; content: string }[] = [];

    // 初始状态
    let currentAgentId = sourceAgentId;
    let currentReply = sourceReply;
    let currentDepth = context.depth;
    let currentHistory = [...context.history];

    // 多跳循环
    while (currentDepth < this.config.maxDepth) {
      // 1. 解析当前 Agent 回复中的 @mention
      const parseResult = this.a2aParser.parse(currentReply, this.availableIds);

      // 2. 决策是否继续
      const { A2ADecider } = await import("./decider.js");
      const decider = new A2ADecider();
      const decision = decider.decide({
        mentions: parseResult.mentions,
        depth: currentDepth,
        shouldTrigger: parseResult.shouldTrigger,
        config: this.config,
      });

      // 3. 如果决策是停止或确认，退出循环
      if (decision.decision === A2ADecision.STOP ||
          decision.decision === A2ADecision.CONFIRM) {
        return {
          continued: false,
          hopsCompleted: chains.length,
          chains,
          replies,
          finalDecision: decision,
        };
      }

      // 4. 获取目标 Agent
      const nextAgentIds = decision.targets || [];
      if (nextAgentIds.length === 0) {
        break;
      }

      // 5. 过滤掉 self-loops（防止 Agent @自己）
      const validTargets = nextAgentIds.filter(id => id !== currentAgentId);
      if (validTargets.length === 0) {
        break; // 没有有效目标，退出循环
      }

      // 6. 只处理第一个目标（Phase 4 简化）
      const nextAgentId = validTargets[0];

      // 6. 确保 Agent 在数据库中存在
      const agentConfig = this.registry.get(nextAgentId);
      if (agentConfig) {
        this.storage.upsertAgent(agentConfig);
      }

      // 7. 记录协作链
      const chain = this.storage.addA2AChain({
        threadId: context.threadId,
        sourceAgentId: currentAgentId,
        targetAgentId: nextAgentId,
        triggerMessageId: context.triggerMessageId,
      });
      chains.push({
        sourceAgentId: chain.sourceAgentId,
        targetAgentId: chain.targetAgentId,
      });

      // 8. 添加目标 Agent 到会话参与者
      await this.threads.addParticipant(context.threadId, nextAgentId);

      // 9. 唤醒下一个 Agent
      const nextAgent = agentFactory(nextAgentId);

      // 10. 构建上下文
      const agentReply = await nextAgent.reply(currentReply, {
        threadId: context.threadId,
        participants: [...context.participants, nextAgentId],
        history: currentHistory,
        hasMention: true,
      });

      // 11. 存储 Agent 回复
      this.storage.addMessage({
        conversationId: context.threadId,
        role: "assistant",
        agentId: nextAgentId,
        content: agentReply,
        a2aSource: currentAgentId,
      });

      // 12. 记录回复（用于返回给用户）
      replies.push({
        agentId: nextAgentId,
        content: agentReply,
      });

      // 13. 更新状态，准备下一跳
      currentAgentId = nextAgentId;
      currentReply = agentReply;
      currentDepth++;

      // 14. 更新历史（加入当前回复）
      currentHistory = [...currentHistory, {
        id: `temp-${Date.now()}`,
        conversationId: context.threadId,
        role: "assistant",
        agentId: nextAgentId,
        content: agentReply,
        createdAt: Math.floor(Date.now() / 1000),
      }];
    }

    // 循环结束（达到 maxDepth 或没有更多 mentions）
    return {
      continued: true,
      hopsCompleted: chains.length,
      chains,
      replies,
      finalDecision: {
        decision: A2ADecision.STOP,
        reason: `达到最大协作深度 (${this.config.maxDepth}) 或没有更多 mentions`,
      },
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
