/**
 * Phase 4 — Router（路由器，A2A 扩展版）
 *
 * 相比 Phase 3 的变化：
 * - 集成 A2A 处理
 * - Agent 回复后检测 A2A 触发
 * - 支持协作链式流转
 */

import { MentionParser } from "../router/mention-parser.js";
import { AgentRegistry } from "../registry/agent-registry.js";
import { ThreadManager } from "../thread/manager.js";
import type { Storage, Message } from "../storage/sqlite.js";
import type { Agent } from "../agent/agent.js";
import { A2ADecider, type A2AConfig } from "../a2a/decider.js";
import { A2AHandler } from "../a2a/handler.js";
import { A2AParser } from "../a2a/parser.js";
import type { RouteContext } from "./route-context.js";

/** Router 配置选项（Phase 4 扩展） */
export interface RouterOptions {
  /** A2A 配置 */
  a2a?: A2AConfig;
}

/** 路由结果（Phase 4 扩展） */
export interface RouteResult {
  /** Agent 的回复内容 */
  content: string;
  /** 回复的 Agent ID */
  agentId: string;
  /** 所属会话 ID */
  threadId: string;
  /** 是否有 @mention（用户输入） */
  hasMention: boolean;
  /** 是否触发了 A2A 协作 */
  a2aTriggered?: boolean;
  /** A2A 协作链 */
  a2aChains?: {
    sourceAgentId: string;
    targetAgentId: string;
  }[];
}

export class Router {
  private mentionParser: MentionParser;
  private a2aParser: A2AParser;
  private availableIds: Set<string>;
  private a2aHandler: A2AHandler;

  constructor(
    private registry: AgentRegistry,
    private threads: ThreadManager,
    private storage: Storage,
    private options: RouterOptions = {}
  ) {
    this.mentionParser = new MentionParser();
    this.a2aParser = new A2AParser();
    this.availableIds = new Set(this.registry.listIds());

    // 初始化 A2A Handler
    const a2aConfig = this.options.a2a || A2ADecider.defaultConfig();
    this.a2aHandler = new A2AHandler(
      this.registry,
      this.threads,
      this.storage,
      a2aConfig
    );
  }

  /**
   * 路由主流程（Phase 4 扩展）
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

    // Phase 4 简化：只处理第一个目标
    const targetAgentId = finalTargets[0];

    // === 第 4 层：获取或创建会话 ===
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
    const agentMsg = this.storage.addMessage({
      conversationId: thread.id,
      role: "assistant",
      agentId: targetAgentId,
      content: replyContent,
    });

    // === Phase 4 新增：A2A 处理 ===
    const a2aResult = await this.handleA2A(
      targetAgentId,
      replyContent,
      agentMsg.id,
      thread.id,
      history,
      thread.participants,
      agentFactory
    );

    return {
      content: replyContent,
      agentId: targetAgentId,
      threadId: thread.id,
      hasMention: targets.length > 0,
      a2aTriggered: a2aResult.continued,
      a2aChains: a2aResult.chains,
    };
  }

  /**
   * 处理 A2A 协作
   */
  private async handleA2A(
    sourceAgentId: string,
    replyContent: string,
    messageId: string,
    threadId: string,
    history: Message[],
    participants: string[],
    agentFactory: (agentId: string) => Agent
  ) {
    // 1. 解析 Agent 回复中的 @mention
    const parseResult = this.a2aParser.parse(replyContent, this.availableIds);

    // 2. 如果没有触发 A2A，直接返回
    if (!parseResult.shouldTrigger || parseResult.mentions.length === 0) {
      return {
        continued: false,
        chains: [],
      };
    }

    // 3. 构建上下文（更新历史）
    const updatedHistory = [...history, {
      id: messageId,
      conversationId: threadId,
      role: "assistant" as const,
      agentId: sourceAgentId,
      content: replyContent,
      createdAt: Math.floor(Date.now() / 1000),
    }];

    // 4. 构建 A2A 上下文
    const a2aContext = {
      threadId,
      sourceAgentId,
      triggerMessageId: messageId,
      depth: 1,
      history: updatedHistory,
      participants,
    };

    // 5. 执行 A2A
    return this.a2aHandler.handle(
      sourceAgentId,
      parseResult,
      a2aContext,
      agentFactory
    );
  }

  /**
   * 第 3 层：回退解析器
   */
  private getFallbackTarget(threadId?: string): string {
    const defaultAgent = this.registry.getDefaultAgentId();

    if (!defaultAgent) {
      throw new Error("没有可用的 Agent");
    }

    return defaultAgent;
  }

  /**
   * 获取会话的协作链历史
   */
  getA2AChainHistory(threadId: string) {
    return this.a2aHandler.getChainHistory(threadId);
  }

  /**
   * 格式化协作链历史
   */
  formatA2AChainHistory(threadId: string): string {
    return this.a2aHandler.formatChainHistory(threadId);
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
