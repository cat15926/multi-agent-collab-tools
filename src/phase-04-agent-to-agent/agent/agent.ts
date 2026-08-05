/**
 * Phase 4 — Agent 类
 *
 * 职责：
 * - 接受用户输入并生成回复
 * - 支持多 Agent 协作感知
 * - 第 6 层：LLM 判断层（Agent 自己决定接不接）
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../registry/agent-registry.js";
import type { Message } from "../storage/sqlite.js";

/** Agent 回复选项 */
export interface AgentReplyOptions {
  /** 会话 ID */
  threadId: string;
  /** 会话参与者 */
  participants: string[];
  /** 是否有 @mention */
  hasMention: boolean;
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
  private readonly maxMessages: number = 50;

  constructor(config: AgentConfig, client?: Anthropic) {
    this.id = config.id;
    this.name = config.name;
    this.emoji = config.emoji;
    this.persona = config.persona;
    this.model = config.model;
    this.client = client ?? new Anthropic();
  }

  /**
   * 生成回复
   */
  async reply(content: string, options: AgentReplyOptions): Promise<string> {
    const contextMessages = this.truncateMessages(options.history);
    const systemPrompt = this.buildSystemPrompt(options.participants);

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

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return "(无法解析回复)";
    }

    return textBlock.text;
  }

  /**
   * 构建系统提示（包含身份和参与者信息）
   */
  private buildSystemPrompt(participants: string[]): string {
    const participantsInfo = participants
      .filter((p) => p !== "user" && p !== this.id)
      .map((p) => `@${p}`)
      .join(", ");

    const basePrompt = this.persona;

    if (participantsInfo) {
      return `${basePrompt}

**当前会话参与者**: 你, ${participantsInfo}

你可以主动 @其他参与者寻求帮助或委派任务。`;
    }

    return basePrompt;
  }

  /**
   * 应用上下文窗口限制
   */
  private truncateMessages(messages: Message[]): Message[] {
    if (messages.length <= this.maxMessages) {
      return messages;
    }
    return messages.slice(-this.maxMessages);
  }

  /**
   * 流式回复
   */
  async *replyStream(content: string, options: AgentReplyOptions): AsyncGenerator<string> {
    const text = await this.reply(content, options);
    yield text;
  }
}
