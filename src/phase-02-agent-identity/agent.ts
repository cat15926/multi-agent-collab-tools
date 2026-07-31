/**
 * Phase 2 — Agent 类（升级版）
 *
 * 相比 Phase 1 的变化：
 * - 从配置文件加载人格（而非硬编码）
 * - 对话历史存入 SQLite（而非内存）
 * - 集成上下文窗口管理
 *
 * 对应「核心心智模型」的抽象 ① Agent：
 *   Agent = 持久身份(persona) + 大脑(model + LLM) + 记忆(history) + reply()
 */

import Anthropic from "@anthropic-ai/sdk";
import { loadAgentConfig } from "./config.js";
import { Storage, type MessageRole } from "./storage/sqlite.js";
import { ContextWindow } from "./context.js";

/** Agent 创建选项 */
export interface AgentOptions {
  /** Agent 配置 ID（对应 config/agents/<id>.json） */
  configId: string;
  /** 可注入 storage，方便测试 */
  storage?: Storage;
  /** 可注入 client，方便测试 */
  client?: Anthropic;
}

export class Agent {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly persona: string;
  readonly model: string;
  private readonly storage: Storage;
  private readonly client: Anthropic;
  private readonly contextWindow: ContextWindow;
  /** 当前会话 ID（Phase 2 固定为 "default"） */
  private conversationId: string;

  constructor(opts: AgentOptions) {
    this.storage = opts.storage ?? new Storage();
    this.client = opts.client ?? new Anthropic();
    this.contextWindow = new ContextWindow({ maxMessages: 50 });

    // 从存储加载 Agent 配置，如果没有则从文件加载
    let config = this.storage.getAgent(opts.configId);
    if (!config) {
      config = this.loadConfigFromFile(opts.configId);
      this.storage.upsertAgent(config);
    }

    this.id = config.id;
    this.name = config.name;
    this.emoji = config.emoji;
    this.persona = config.persona;
    this.model = config.model;

    // 创建或获取默认会话（必须在保存 agent config 之后）
    const conversation = this.storage.getOrCreateDefaultConversation(opts.configId);
    this.conversationId = conversation.id;
  }

  /** 从配置文件加载 */
  private loadConfigFromFile(configId: string): import("./config.js").AgentConfig {
    return loadAgentConfig(configId);
  }

  /**
   * 流式回复：async generator，逐 token 产出。
   *
   * 流程：
   * 1. 用户输入 → 存入 SQLite
   * 2. 从 SQLite 读取历史 → 上下文窗口截断
   * 3. 调用 LLM → 流式输出
   * 4. 完整回复 → 存入 SQLite
   */
  async *reply(input: string): AsyncGenerator<string> {
    // 1. 存储用户消息
    this.storage.addMessage(this.conversationId, "user", input);

    // 2. 获取历史消息并应用上下文窗口
    const history = this.storage.getMessages(this.conversationId);
    const contextMessages = this.contextWindow.truncate(history);

    // 3. 调用 LLM 流式生成
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 1024,
      system: this.persona,
      messages: contextMessages.map((m) => ({ role: m.role, content: m.content })),
    });

    let full = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        full += event.delta.text;
        yield event.delta.text;
      }
    }

    // 4. 存储助手回复
    this.storage.addMessage(this.conversationId, "assistant", full);
  }

  /** 获取当前会话的所有消息（用于调试） */
  getHistory(): Message[] {
    return this.storage.getMessages(this.conversationId);
  }

  /** 清空当前会话历史（用于重置） */
  clearHistory(): void {
    this.storage.clearMessages(this.conversationId);
  }

  /** 关闭存储连接 */
  close(): void {
    this.storage.close();
  }
}

/** 为了类型兼容，导入 Message 类型 */
export type Message = import("./storage/sqlite.js").Message;
