/**
 * Phase 6 — Agent 类（Tool Use 扩展版）
 *
 * 相比 Phase 5 的变化：
 * - 构造可注入 ToolRegistry + Sandbox（启用工具调用）
 * - reply 内实现 tool-use loop：tool_use → 执行 → tool_result → 再推理，循环到 end_turn
 * - reply 签名不变（调用方 router/pattern/a2a 零改动）
 *
 * 职责：
 * - 接受输入并生成回复
 * - 多 Agent 协作感知
 * - 第 6 层：LLM 判断层
 * - 工具调用循环（Phase 6 新增）
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../registry/agent-registry.js";
import type { Message, ToolCallStatus } from "../storage/sqlite.js";
import type { ToolRegistry, ToolResult, Sandbox } from "../tools/index.js";
import { SandboxError } from "../tools/index.js";

/** Agent 回复选项（与 Phase 5 一致，调用方零改动） */
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

/** 工具调用事件（实时输出 / 落盘用） */
export interface ToolCallEvent {
  agentId: string;
  threadId: string;
  toolName: string;
  input: unknown;
  result: ToolResult;
  duration: number;
  status: ToolCallStatus; // ok | error | blocked
}

/** Agent 构造选项 */
export interface AgentOptions {
  /** 可注入 client（测试用） */
  client?: Anthropic;
  /** 工具注册表（提供则启用 tool-use loop） */
  toolRegistry?: ToolRegistry;
  /** 允许该 Agent 使用的工具名白名单（undefined/空 = 全部） */
  allowedTools?: string[];
  /** 沙箱（工具自身也持有引用，此处保留用于未来扩展） */
  sandbox?: Sandbox;
  /** 工具调用事件回调（实时输出 / 落盘由 CLI 注入） */
  onToolCall?: (info: ToolCallEvent) => void;
  /** 最大工具循环轮数（默认 10，防无限调用） */
  maxToolTurns?: number;
}

const MAX_TOOL_TURNS_DEFAULT = 10;
const MAX_TOKENS = 4096;
const TOOL_RESULT_LIMIT = 2000; // 工具结果喂回 LLM 前截断，防上下文爆炸

export class Agent {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly persona: string;
  readonly model: string;

  private readonly client: Anthropic;
  private readonly toolRegistry?: ToolRegistry;
  private readonly allowedTools?: string[];
  private readonly onToolCall?: (info: ToolCallEvent) => void;
  private readonly maxToolTurns: number;
  private readonly maxMessages: number = 50;

  constructor(config: AgentConfig, options: AgentOptions = {}) {
    this.id = config.id;
    this.name = config.name;
    this.emoji = config.emoji;
    this.persona = config.persona;
    this.model = config.model;
    this.client = options.client ?? new Anthropic();
    this.toolRegistry = options.toolRegistry;
    this.allowedTools = options.allowedTools;
    this.onToolCall = options.onToolCall;
    this.maxToolTurns = options.maxToolTurns ?? MAX_TOOL_TURNS_DEFAULT;
  }

  /**
   * 生成回复（Phase 6：若启用工具，走 tool-use loop）
   * 签名与 Phase 5 完全一致 → router / pattern / a2a 零改动。
   */
  async reply(content: string, options: AgentReplyOptions): Promise<string> {
    const contextMessages = this.truncateMessages(options.history);
    const systemPrompt = this.buildSystemPrompt(options.participants);

    // 过滤出本 Agent 可用的工具
    const effectiveRegistry = this.toolRegistry?.forAgent(this.allowedTools);
    const tools = effectiveRegistry?.toAnthropicTools() ?? [];

    // 投影一次，两条路径复用（修复 P4-004：归属标注 + 相邻同角色合并）
    const llmMessages = [...this.toLlmMessages(contextMessages), { role: "user" as const, content }];

    // 无工具 → 原单次调用逻辑（向后兼容）
    if (tools.length === 0) {
      return this.replyWithoutTools(llmMessages, systemPrompt);
    }

    // 有工具 → tool-use loop
    return this.replyWithTools(llmMessages, systemPrompt, tools, options);
  }

  /** 无工具：单次调用（Phase 5 原逻辑） */
  private async replyWithoutTools(
    llmMessages: Anthropic.Messages.MessageParam[],
    systemPrompt: string
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: llmMessages,
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return "(无法解析回复)";
    }
    return textBlock.text;
  }

  /** 有工具：tool-use loop（Phase 6 核心） */
  private async replyWithTools(
    llmMessages: Anthropic.Messages.MessageParam[],
    systemPrompt: string,
    tools: Anthropic.Messages.Tool[],
    options: AgentReplyOptions
  ): Promise<string> {
    const messages: Anthropic.Messages.MessageParam[] = [...llmMessages];

    let lastResponse: Anthropic.Messages.Message | undefined;

    for (let turn = 0; turn < this.maxToolTurns; turn++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools,
      });
      lastResponse = response;

      // 终止：stop_reason 非 tool_use（end_turn / max_tokens / stop_sequence）
      if (response.stop_reason !== "tool_use") break;

      // 追加 assistant 的完整 content（必须含 text + tool_use blocks，保证 tool_use_id 配对）
      messages.push({
        role: "assistant",
        content: response.content as unknown as Anthropic.Messages.ContentBlockParam[],
      });

      // 提取并执行所有 tool_use，组装 tool_result
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const r = await this.executeTool(block, options);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: truncate(r.content, TOOL_RESULT_LIMIT),
          is_error: r.isError,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    if (!lastResponse) return "(无回复)";
    return this.extractFinalText(lastResponse);
  }

  /** 执行单个工具调用：分发 + 沙箱状态判定 + 事件回调 */
  private async executeTool(
    block: Anthropic.Messages.ToolUseBlock,
    options: AgentReplyOptions
  ): Promise<{ content: string; isError: boolean; status: ToolCallStatus }> {
    const tool = this.toolRegistry?.get(block.name);
    const start = Date.now();
    let result: ToolResult;
    let status: ToolCallStatus;

    if (!tool) {
      result = { content: `工具 "${block.name}" 不存在`, isError: true };
      status = "error";
    } else {
      try {
        result = await tool.execute(block.input as Record<string, unknown>);
        status = result.isError ? "error" : "ok";
      } catch (e) {
        // 沙箱拦截 → blocked；其他异常 → error
        if (e instanceof SandboxError) {
          result = { content: e.message, isError: true };
          status = "blocked";
        } else {
          result = {
            content: e instanceof Error ? e.message : String(e),
            isError: true,
          };
          status = "error";
        }
      }
    }

    const duration = Date.now() - start;

    this.onToolCall?.({
      agentId: this.id,
      threadId: options.threadId,
      toolName: block.name,
      input: block.input,
      result,
      duration,
      status,
    });

    return { content: result.content, isError: !!result.isError, status };
  }

  /** 取最终回复文本（最后一次 end_turn 的 text block） */
  private extractFinalText(response: Anthropic.Messages.Message): string {
    const texts = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text);
    return texts.join("\n") || "(无文本回复)";
  }

  /**
   * 投影：Message[] → LLM messages（修复 P4-004，与 Phase 4/5 一致）
   *
   * 1) 归属标注：assistant 消息若非本 Agent 所说，content 前加 `[agentId]:` 前缀。
   * 2) 相邻同角色合并：满足 Anthropic API user/assistant 严格交替约束
   *    （多 Agent 连续发言 / A2A 多跳会产生相邻 assistant）。
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
   * 构建系统提示（包含身份、参与者、工具提示）
   */
  private buildSystemPrompt(participants: string[]): string {
    const participantsInfo = participants
      .filter((p) => p !== "user" && p !== this.id)
      .map((p) => `@${p}`)
      .join(", ");

    let prompt = this.persona;

    const hasTools =
      this.toolRegistry && this.toolRegistry.forAgent(this.allowedTools).list().length > 0;
    if (hasTools) {
      prompt +=
        "\n\n你有工具可用（如读文件、列目录、搜索内容、执行只读命令）。当用户的问题需要查看真实文件、项目结构或运行环境信息时，**主动调用工具**获取真实数据，不要凭空猜测或编造。";
    }

    if (participantsInfo) {
      prompt += `\n\n**当前会话参与者**: 你, ${participantsInfo}\n\n历史消息中，以 \`[agentId]:\` 开头的 assistant 内容是**其他 Agent** 说的；无前缀的是你自己之前说的话。\n\n你可以主动 @其他参与者寻求帮助或委派任务。`;
    }

    return prompt;
  }

  /** 应用上下文窗口限制 */
  private truncateMessages(messages: Message[]): Message[] {
    if (messages.length <= this.maxMessages) return messages;
    return messages.slice(-this.maxMessages);
  }

  /** 流式回复（Phase 6 暂未实现流式 tool loop，回退到非流式） */
  async *replyStream(content: string, options: AgentReplyOptions): AsyncGenerator<string> {
    const text = await this.reply(content, options);
    yield text;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n...[已截断，共 ${s.length} 字符]` : s;
}
