/**
 * Phase 1 — 最小 Agent 实现
 *
 * 对应「核心心智模型」的抽象 ① Agent：
 *   Agent = 身份(persona) + 大脑(model + LLM) + 记忆(history) + reply()
 *
 * 这一阶段故意做到最小：一个人格 + 一次流式调用 + 内存里的短期记忆。
 * - Phase 2 会给记忆加持久化（SQLite），重启后仍记得对话。
 * - Phase 3 会让多个 Agent 共存（@mention 路由）。
 */

import Anthropic from "@anthropic-ai/sdk";

/** 抽象 ② Message 的最小形态（Phase 1 隐式引入，Phase 3 才完整结构化） */
export interface Message {
  role: "user" | "assistant";
  content: string;
}

/** 创建一个 Agent 需要的参数 */
export interface AgentOptions {
  /** Agent 唯一标识 */
  id: string;
  /** 人格 = system prompt。改这里就改变 Agent 的性格（验收点） */
  persona: string;
  /** 大脑：用哪个模型。默认 Opus 4.8；想省钱换 "claude-sonnet-5" / "claude-haiku-4-5" */
  model?: string;
  /** 可注入 client，方便测试（Phase 8 会用到） */
  client?: Anthropic;
}

export class Agent {
  readonly id: string;
  readonly persona: string;
  readonly model: string;
  private readonly client: Anthropic;
  /** 短期记忆：本进程内的对话历史。Phase 1 不持久化（重启即丢）。 */
  private history: Message[] = [];

  constructor(opts: AgentOptions) {
    this.id = opts.id;
    this.persona = opts.persona;
    this.model = opts.model ?? "claude-opus-4-8";
    this.client = opts.client ?? new Anthropic();
  }

  /**
   * 流式回复：async generator，逐 token 产出。
   * 这是整个系统最底层的「输入 → LLM → 输出」回路。
   *
   * 想启用 adaptive thinking（Opus 4.8 上推荐用于复杂任务），在请求里加：
   *   thinking: { type: "adaptive" }
   * Phase 1 MVP 保持最小，先不开。
   */
  async *reply(input: string): AsyncGenerator<string> {
    this.history.push({ role: "user", content: input });

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 1024,
      system: this.persona,
      messages: this.history.map((m) => ({ role: m.role, content: m.content })),
    });

    let full = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        full += event.delta.text;
        yield event.delta.text;
      }
    }

    // 把完整回复存进短期记忆，下一轮 reply 时会带上作为上下文
    this.history.push({ role: "assistant", content: full });
  }
}
