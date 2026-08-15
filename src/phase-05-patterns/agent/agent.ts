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
        ...this.toLlmMessages(contextMessages),
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
   * 投影：Message[] → LLM messages（修复 P4-004，与 Phase 4 一致）
   *
   * 1) 归属标注：assistant 消息若非本 Agent 所说，content 前加 `[agentId]:` 前缀。
   * 2) 相邻同角色合并：满足 Anthropic API user/assistant 严格交替约束。
   */
  private toLlmMessages(messages: Message[]): { role: "user" | "assistant"; content: string }[] {
    return messages.reduce<{ role: "user" | "assistant"; content: string }[]>((acc, m) => {
      let content = m.content;
      if (m.role === "assistant" && m.agentId && m.agentId !== this.id) {
        content = `[${m.agentId}]: ${m.content}`;
      }
      const prev = acc[acc.length - 1];
      if (prev && prev.role === m.role) {
        prev.content += `\n\n${content}`; // 相邻同角色 → 合并
      } else {
        acc.push({ role: m.role, content });
      }
      return acc;
    }, []);
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

历史消息中，以 \`[agentId]:\` 开头的 assistant 内容是**其他 Agent** 说的；无前缀的是你自己之前说的话。

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
