/**
 * Phase 3 — Agent 类（扩展版）
 *
 * 相比 Phase 2 的变化：
 * - 接受路由上下文（threadId, participants, history）
 * - 支持多 Agent 协作感知
 * - 第 6 层：LLM 判断层（Agent 自己决定接不接）
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../registry/agent-registry.js";
import type { Message } from "../storage/sqlite.js";
import type { RouteContext } from "../router/index.js";

/** Agent 回复选项 */
export interface AgentReplyOptions extends RouteContext {
  /** 会话历史消息 */
  history: Message[];
}

export class Agent {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly persona: string;
  readonly model: string;

  private readonly client: Anthropic;
  private readonly maxMessages: number = 50; // 上下文窗口限制

  constructor(config: AgentConfig, client?: Anthropic) {
    this.id = config.id;
    this.name = config.name;
    this.emoji = config.emoji;
    this.persona = config.persona;
    this.model = config.model;
    this.client = client ?? new Anthropic();
  }

  /**
   * 生成回复（同步返回，非流式）
   * Phase 3 简化：不再流式输出，直接返回完整内容
   *
   * @param content 用户输入内容
   * @param options 路由上下文
   * @returns Agent 回复内容
   */
  async reply(content: string, options: AgentReplyOptions): Promise<string> {
    // 应用上下文窗口限制
    const contextMessages = this.truncateMessages(options.history);

    // 构建系统提示（包含身份和参与者信息）
    const systemPrompt = this.buildSystemPrompt(options.participants);

    // 调用 LLM
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        ...contextMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        {
          role: "user",
          content,
        },
      ],
    });

    // 提取文本内容
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return "(无法解析回复)";
    }

    return textBlock.text;
  }

  /**
   * 构建系统提示（包含身份和参与者）
   */
  private buildSystemPrompt(participants: string[]): string {
    const participantsInfo = participants
      .filter((p) => p !== "user" && p !== this.id) // 排除自己和用户
      .map((p) => `@${p}`)
      .join(", ");

    const basePrompt = this.persona;

    // 如果有其他参与者，添加协作提示
    if (participantsInfo) {
      return `${basePrompt}

**当前会话参与者**: 你, ${participantsInfo}

你可以主动 @其他参与者寻求帮助或委派任务。`;
    }

    return basePrompt;
  }

  /**
   * 应用上下文窗口限制（保留最近的 N 条消息）
   */
  private truncateMessages(messages: Message[]): Message[] {
    if (messages.length <= this.maxMessages) {
      return messages;
    }

    // 保留最近的消息
    return messages.slice(-this.maxMessages);
  }

  /**
   * 流式回复（保留 Phase 2 的接口，但内部简化）
   */
  async *replyStream(content: string, options: AgentReplyOptions): AsyncGenerator<string> {
    const text = await this.reply(content, options);
    yield text;
  }
}
