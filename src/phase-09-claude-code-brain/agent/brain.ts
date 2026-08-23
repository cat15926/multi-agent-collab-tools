/**
 * Phase 9 — Brain 接口（可替换的"脑 + 手"）
 *
 * 「Agent ≠ LLM」原则的终极形态：Agent 持有 persona / 记忆 / 会话投影（brain 无关），
 * Brain 负责把组装好的上下文变成回复——可以是裸 Anthropic API + 自研 tool loop
 * （AnthropicBrain），也可以是 Claude Code 完整 agentic loop（ClaudeCodeBrain）。
 *
 * 契约：
 * - reply() 返回最终回复文本（与 Agent.reply 签名对齐，router/pattern/a2a 零改动）
 * - 过程中通过 events 发 LlmCallEvent / ToolCallEvent（实时输出 + Phase 8 落盘由
 *   CLI 工厂注入回调完成，Brain 自身不依赖观测层——沿 Phase 6/8 事件先例）
 * - messages 由 Agent 投影好（归属标注 + 同角色合并）并追加当前输入
 */

import type { LlmCallEvent, ToolCallEvent } from "./agent.js";

/** 一次 Brain 调用的完整上下文（Agent 组装，Brain 只管执行） */
export interface BrainRequest {
  /** 发起调用的 Agent id（事件归属 / kb 工具 ToolContext 用） */
  agentId: string;
  /** 会话 id */
  threadId: string;
  /** 组装好的 system prompt（persona + 参与者 + 角色 + 长期记忆） */
  systemPrompt: string;
  /** 投影后的消息序列（含最后一条当前输入，role 严格 user/assistant） */
  messages: { role: "user" | "assistant"; content: string }[];
}

/** Brain 执行过程事件（镜像 AgentOptions 的 onLlmCall/onToolCall） */
export interface BrainEvents {
  onLlmCall(e: LlmCallEvent): void;
  onToolCall(e: ToolCallEvent): void;
}

/** Brain：Agent 的推理与执行引擎 */
export interface Brain {
  /** 是否具备工具能力（Agent 据此决定 system prompt 里的工具提示） */
  readonly hasTools: boolean;
  /** 执行一次回复。失败时 throw（调用方 Agent 不捕获，语义与旧 reply 一致） */
  reply(req: BrainRequest, events: BrainEvents): Promise<string>;
}
