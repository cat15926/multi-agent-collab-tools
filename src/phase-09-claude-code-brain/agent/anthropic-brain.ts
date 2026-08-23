/**
 * Phase 9 — AnthropicBrain（裸 Anthropic API + 自研 tool loop）
 *
 * Phase 6/8 的 Agent LLM 循环**原样搬入**（行为零变化）：
 * - 无工具 → 单次 messages.create
 * - 有工具 → tool-use loop：tool_use → 执行 → tool_result → 再推理，循环到 end_turn
 * - 每次 messages.create 后发 LlmCallEvent（token usage / 延迟 / stop_reason / 轮次）
 * - 工具执行经 ToolRegistry 分发 + Sandbox 状态判定，发 ToolCallEvent
 *
 * 变化仅在接缝：身份（agentId/threadId）与事件回调从 Agent 的 this 改由
 * BrainRequest / BrainEvents 传入。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Brain, BrainEvents, BrainRequest } from "./brain.js";
import type { LlmCallEvent, ToolCallEvent } from "./agent.js";
import type { ToolCallStatus } from "../storage/sqlite.js";
import type { ToolRegistry, ToolResult, Sandbox } from "../tools/index.js";
import { SandboxError } from "../tools/index.js";

/** AnthropicBrain 构造选项 */
export interface AnthropicBrainOptions {
  model: string;
  /** 可注入 client（测试用） */
  client?: Anthropic;
  toolRegistry?: ToolRegistry;
  allowedTools?: string[];
  sandbox?: Sandbox;
  maxToolTurns?: number;
}

const MAX_TOOL_TURNS_DEFAULT = 10;
const MAX_TOKENS = 8192; // 修复 P6-001(#8): 4096 易截断长设计输出
const TOOL_RESULT_LIMIT = 2000; // 工具结果喂回 LLM 前截断，防上下文爆炸

export class AnthropicBrain implements Brain {
  private readonly model: string;
  private readonly client: Anthropic;
  private readonly toolRegistry?: ToolRegistry;
  private readonly allowedTools?: string[];
  private readonly sandbox?: Sandbox;
  private readonly maxToolTurns: number;

  constructor(opts: AnthropicBrainOptions) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic();
    this.toolRegistry = opts.toolRegistry;
    this.allowedTools = opts.allowedTools;
    this.sandbox = opts.sandbox;
    this.maxToolTurns = opts.maxToolTurns ?? MAX_TOOL_TURNS_DEFAULT;
  }

  get hasTools(): boolean {
    return (
      !!this.toolRegistry && this.toolRegistry.forAgent(this.allowedTools).list().length > 0
    );
  }

  async reply(req: BrainRequest, events: BrainEvents): Promise<string> {
    // 过滤出本 Agent 可用的工具
    const effectiveRegistry = this.toolRegistry?.forAgent(this.allowedTools);
    const tools = effectiveRegistry?.toAnthropicTools() ?? [];

    if (tools.length === 0) {
      return this.replyWithoutTools(req, events);
    }
    return this.replyWithTools(req, events, tools);
  }

  /** 无工具：单次调用（Phase 5 原逻辑；Phase 8 加 LLM 调用事件） */
  private async replyWithoutTools(
    req: BrainRequest,
    events: BrainEvents
  ): Promise<string> {
    const start = Date.now();
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: req.systemPrompt,
        messages: req.messages,
      });
    } catch (e) {
      this.fireLlmCall(req, events, 1, start, undefined, e instanceof Error ? e.message : String(e));
      throw e;
    }
    this.fireLlmCall(req, events, 1, start, response);
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return "(无法解析回复)";
    }
    return textBlock.text;
  }

  /** 有工具：tool-use loop（Phase 6 核心） */
  private async replyWithTools(
    req: BrainRequest,
    events: BrainEvents,
    tools: Anthropic.Messages.Tool[]
  ): Promise<string> {
    const messages: Anthropic.Messages.MessageParam[] = [...req.messages];

    let lastResponse: Anthropic.Messages.Message | undefined;

    for (let turn = 0; turn < this.maxToolTurns; turn++) {
      const start = Date.now();
      let response: Anthropic.Messages.Message;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: req.systemPrompt,
          messages,
          tools,
        });
      } catch (e) {
        this.fireLlmCall(
          req,
          events,
          turn + 1,
          start,
          undefined,
          e instanceof Error ? e.message : String(e)
        );
        throw e;
      }
      this.fireLlmCall(req, events, turn + 1, start, response);
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
        const r = await this.executeTool(block, req, events);
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
    req: BrainRequest,
    events: BrainEvents
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
        // Phase 7：传执行上下文（kb_write 等需要归属标注的工具用）
        result = await tool.execute(block.input as Record<string, unknown>, {
          agentId: req.agentId,
          threadId: req.threadId,
        });
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

    const event: ToolCallEvent = {
      agentId: req.agentId,
      threadId: req.threadId,
      toolName: block.name,
      input: block.input,
      result,
      duration,
      status,
    };
    events.onToolCall(event);

    return { content: result.content, isError: !!result.isError, status };
  }

  /**
   * 发 LLM 调用事件（Phase 8）：每次 messages.create 后触发（含失败——token 为 0）。
   * usage 的 nullable 字段：input null→0（relay 模型可能不上报）、cache_* null→undefined。
   */
  private fireLlmCall(
    req: BrainRequest,
    events: BrainEvents,
    turn: number,
    start: number,
    response?: Anthropic.Messages.Message,
    error?: string
  ): void {
    const event: LlmCallEvent = {
      agentId: req.agentId,
      threadId: req.threadId,
      model: this.model,
      turn,
      durationMs: Date.now() - start,
      inputTokens: response?.usage?.input_tokens ?? 0,
      outputTokens: response?.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: response?.usage?.cache_creation_input_tokens ?? undefined,
      cacheReadInputTokens: response?.usage?.cache_read_input_tokens ?? undefined,
      stopReason: response?.stop_reason ?? undefined,
      error,
    };
    events.onLlmCall(event);
  }

  /** 取最终回复文本（最后一次 end_turn 的 text block） */
  private extractFinalText(response: Anthropic.Messages.Message): string {
    const texts = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text);
    return texts.join("\n") || "(无文本回复)";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n...[已截断，共 ${s.length} 字符]` : s;
}
