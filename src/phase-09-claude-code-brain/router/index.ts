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
import { A2ADecider, A2ADecision, type A2AConfig } from "../a2a/decider.js";
import { A2AHandler } from "../a2a/handler.js";
import { A2AParser } from "../a2a/parser.js";
import type { RouteContext } from "./route-context.js";
import type { KnowledgeBase } from "../knowledge/knowledge-base.js";
import type { Evidence } from "../knowledge/types.js";
import type { Tracer } from "../observability/tracer.js";
import { withSpan } from "../observability/tracer.js";

/** Router 配置选项（Phase 4 扩展） */
export interface RouterOptions {
  /** A2A 配置 */
  a2a?: A2AConfig;
  /** A2A 初始深度（默认 1，表示第一跳） */
  initialDepth?: number;
  /** 知识库（Phase 7；提供则每轮路由前检索并注入长期记忆） */
  kb?: KnowledgeBase;
  /** 观测器（Phase 8；route/kb/agent span 落盘） */
  tracer?: Tracer;
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
  /** 每跳的回复内容 */
  a2aReplies?: {
    agentId: string;
    content: string;
  }[];
}

export class Router {
  private mentionParser: MentionParser;
  private a2aParser: A2AParser;
  private availableIds: Set<string>;
  private a2aHandler: A2AHandler;
  private initialDepth: number;

  constructor(
    private registry: AgentRegistry,
    private threads: ThreadManager,
    private storage: Storage,
    private options: RouterOptions = {}
  ) {
    this.mentionParser = new MentionParser();
    this.a2aParser = new A2AParser();
    this.availableIds = new Set(this.registry.listIds());
    this.initialDepth = options.initialDepth ?? 1;

    // 初始化 A2A Handler
    const a2aConfig = this.options.a2a || A2ADecider.defaultConfig();
    this.a2aHandler = new A2AHandler(
      this.registry,
      this.threads,
      this.storage,
      a2aConfig,
      this.options.tracer
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
    const routeStart = Date.now(); // Phase 8：route span 计时（覆盖第 1-5 层）

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

    // Phase 8：route span（第 1-5 层确定性路由决策；决策结果进 attrs）
    this.options.tracer?.recordSpan(
      "route",
      "route",
      { startTs: routeStart, endTs: Date.now() },
      {
        mentions: finalTargets,
        target: targetAgentId,
        fallback: targets.length === 0,
        thread_id: thread.id,
      }
    );

    // === 第 6 层：LLM 判断层（由 Agent 执行） ===
    // Phase 7：查 KnowledgeBase 注入长期记忆（只注入主 reply；A2A 多跳不注入——委派消息已含 source 回复全文）
    const kbStart = Date.now();
    const memoryContext: Evidence[] | undefined = this.options.kb
      ? this.options.kb.buildMemoryContext(cleanContent, thread.id)
      : undefined;

    if (memoryContext && memoryContext.length > 0) {
      console.log(`🧠 注入 ${memoryContext.length} 条长期记忆（router:${targetAgentId}）`);
      this.options.tracer?.recordSpan(
        "kb:buildMemoryContext",
        "kb",
        { startTs: kbStart, endTs: Date.now() },
        { consumer: `router:${targetAgentId}`, entries: memoryContext.length }
      );
      try {
        this.storage.addKbRead({
          threadId: thread.id,
          consumer: `router:${targetAgentId}`,
          query: cleanContent,
          entryIds: memoryContext.map((e) => e.id),
        });
      } catch {
        /* 审计落盘失败不阻塞主流程 */
      }
    }

    const agent = agentFactory(targetAgentId);
    // Phase 8：agent span（一次 reply；llm/tool 子 span 由 CLI 工厂回调挂其下）
    const replyContent = await withSpan(
      this.options.tracer,
      `agent:${targetAgentId}`,
      "agent",
      async (span) => {
        span.setAttribute("has_mention", targets.length > 0);
        const out = await agent.reply(cleanContent, {
          threadId: thread.id,
          participants: thread.participants,
          history,
          hasMention: targets.length > 0,
          memoryContext,
        });
        span.setAttribute("output_preview", out.slice(0, 200));
        return out;
      },
      { agentId: targetAgentId }
    );

    // 存储 Agent 回复
    const agentMsg = this.storage.addMessage({
      conversationId: thread.id,
      role: "assistant",
      agentId: targetAgentId,
      content: replyContent,
    });

    // === Phase 4 新增：A2A 处理 ===
    // 重新获取完整历史（包含当前轮次的 user 消息和 agent 消息）
    const completeHistory = this.threads.getHistory(thread.id);

    const a2aResult = await this.handleA2A(
      targetAgentId,
      replyContent,
      agentMsg.id,
      thread.id,
      completeHistory,
      thread.participants,
      cleanContent,  // P4-003: 传递原始用户输入，用于构造委派消息
      agentFactory
    );

    return {
      content: replyContent,
      agentId: targetAgentId,
      threadId: thread.id,
      hasMention: targets.length > 0,
      a2aTriggered: a2aResult.hopsCompleted > 0,
      a2aChains: a2aResult.chains,
      a2aReplies: a2aResult.replies,
    };
  }

  /**
   * 处理 A2A 协作（P4-003 修复：传递完整上下文）
   */
  private async handleA2A(
    sourceAgentId: string,
    replyContent: string,
    messageId: string,
    threadId: string,
    history: Message[],
    participants: string[],
    originalUserInput: string,  // P4-003: 原始用户输入
    agentFactory: (agentId: string) => Agent
  ) {
    // 1. 解析 Agent 回复中的 @mention
    const parseResult = this.a2aParser.parse(replyContent, this.availableIds);

    // 2. 如果没有触发 A2A，直接返回空结果
    if (!parseResult.shouldTrigger || parseResult.mentions.length === 0) {
      return {
        continued: false,
        hopsCompleted: 0,
        chains: [],
        replies: [],
        finalDecision: {
          decision: A2ADecision.STOP,
          reason: "没有检测到有效的 A2A 触发条件",
        },
      };
    }

    // 3. 构建完整上下文（此时 history 已包含 user 消息和 source agent 的回复）
    // 不需要再手动添加，因为 history 已经是完整的

    // 4. 构建 A2A 上下文
    const a2aContext = {
      threadId,
      sourceAgentId,
      triggerMessageId: messageId,
      depth: this.initialDepth,
      history: history,  // P4-003: 使用完整的 history
      participants,
    };

    // 5. 构造委派消息（P4-003: 不重复使用 source reply）
    const sourceAgent = this.registry.get(sourceAgentId);
    const sourceName = sourceAgent ? sourceAgent.name : sourceAgentId;
    const delegationMessage = `(由 @${sourceName} 转交)\n\n用户原始问题：${originalUserInput}\n\n@${sourceName} 的回复：\n${replyContent}`;

    // 6. 执行 A2A
    return this.a2aHandler.handle(
      sourceAgentId,
      delegationMessage,  // P4-003: 传递委派消息而非原始回复
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
