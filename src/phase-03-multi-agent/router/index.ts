/**
 * Phase 3 — Router（路由器）
 *
 * 职责：
 * - 实现 6 层路由流水线
 * - 协调 MentionParser, AgentRegistry, ThreadManager, Agent
 * - 管理回退行为（无 @mention 时的默认处理）
 *
 * 6 层流水线：
 *   1. MentionParser: 提取 @mention
 *   2. TargetResolver: 验证 Agent 存在
 *   3. FallbackResolver: 无 @ 时的回退
 *   4. Dispatcher: 唤醒目标 Agent
 *   5. ContextBuilder: 组装上下文
 *   6. LLM 判断层: Agent 自己决定接不接
 */

import { MentionParser } from "./mention-parser.js";
import { AgentRegistry } from "../registry/agent-registry.js";
import { ThreadManager } from "../thread/manager.js";
import type { Storage, Message } from "../storage/sqlite.js";
import type { Agent } from "../agent/agent.js";
import type { Thread } from "../thread/thread.js";

/** Router 配置选项 */
export interface RouterOptions {
  /** 当没有 @mention 时的回退行为 */
  fallbackStrategy?: "default" | "last-replier" | "error";
}

/** 路由结果 */
export interface RouteResult {
  /** Agent 的回复内容 */
  content: string;
  /** 回复的 Agent ID */
  agentId: string;
  /** 所属会话 ID */
  threadId: string;
  /** 是否有 @mention */
  hasMention: boolean;
}

/** 路由上下文（传递给 Agent） */
export interface RouteContext {
  threadId: string;
  participants: string[];
  hasMention: boolean;
}

export class Router {
  private mentionParser: MentionParser;
  private availableIds: Set<string>;

  constructor(
    private registry: AgentRegistry,
    private threads: ThreadManager,
    private storage: Storage,
    private options: RouterOptions = {}
  ) {
    this.mentionParser = new MentionParser();
    // 预加载可用 Agent ID 集合（快速查找）
    this.availableIds = new Set(this.registry.listIds());
  }

  /**
   * 路由主流程
   * @param input 用户原始输入
   * @param threadId 可选的会话 ID（未指定则创建新会话）
   * @param agentFactory Agent 工厂函数（用于创建 Agent 实例）
   */
  async route(
    input: string,
    threadId: string | undefined,
    agentFactory: (agentId: string) => Agent
  ): Promise<RouteResult> {
    // === 第 1 层：提及解析 ===
    const { mentions, cleanContent } = this.mentionParser.parseWithValidation(
      input,
      this.availableIds
    );

    // === 第 2 层：目标解析 ===
    const targets = mentions.length > 0 ? mentions : [];

    // === 第 3 层：回退梯级 ===
    const finalTargets = targets.length > 0
      ? targets
      : [this.getFallbackTarget(threadId)];

    // Phase 3 简化：只处理第一个目标
    // Phase 4 会支持多目标并行/串行
    const targetAgentId = finalTargets[0];

    // === 第 4 层：获取或创建会话（分发调度前置） ===
    const thread = await this.threads.getOrCreate(threadId);

    // === 第 5 层：上下文组装 ===
    // 确保 Agent 在数据库中存在
    const agentConfig = this.registry.get(targetAgentId);
    if (agentConfig) {
      this.storage.upsertAgent(agentConfig);
    }

    // 添加参与者
    await this.threads.addParticipant(thread.id, targetAgentId);

    // 获取历史消息
    const history = this.threads.getHistory(thread.id);

    // 存储用户消息
    const userMsg = this.storage.addMessage({
      conversationId: thread.id,
      role: "user",
      content: cleanContent,
      mentions: finalTargets,
    });

    // === 第 6 层：LLM 判断层（由 Agent 执行） ===
    const agent = agentFactory(targetAgentId);
    const replyContent = await agent.reply(cleanContent, {
      threadId: thread.id,
      participants: thread.participants,
      history,
      hasMention: targets.length > 0,
    });

    // 存储 Agent 回复
    this.storage.addMessage({
      conversationId: thread.id,
      role: "assistant",
      agentId: targetAgentId,
      content: replyContent,
    });

    return {
      content: replyContent,
      agentId: targetAgentId,
      threadId: thread.id,
      hasMention: targets.length > 0,
    };
  }

  /**
   * 第 3 层：回退解析器
   * 当没有 @mention 时，决定使用哪个 Agent
   */
  private getFallbackTarget(threadId?: string): string {
    const defaultAgent = this.registry.getDefaultAgentId();

    if (!defaultAgent) {
      throw new Error("没有可用的 Agent");
    }

    // Phase 3 简化：直接使用默认 Agent
    // Phase 4 可以扩展为"上次回复者"
    return defaultAgent;
  }

  /**
   * 列出所有可用的 Agent
   */
  listAgents() {
    return this.registry.listAll();
  }

  /**
   * 获取指定 Agent 的配置
   */
  getAgent(id: string) {
    return this.registry.get(id);
  }
}
