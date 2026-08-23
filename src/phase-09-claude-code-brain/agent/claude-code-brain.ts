/**
 * Phase 9 — ClaudeCodeBrain：把 Claude Code 完整 agentic loop 装进 Agent
 *
 * 实现：@anthropic-ai/claude-agent-sdk 的 query()——每次 reply() 起一个 CC
 * 子进程跑完整循环（Read/Edit/Bash/Grep 原生工具 + team-kb MCP 注入），
 * 消费 stream-json 消息流还原为项目的 LlmCallEvent / ToolCallEvent。
 *
 * 关键设计（ADR-015）：
 * - **无状态**：不用 resume/sessionId——项目 Thread 是唯一记忆源，历史随
 *   prompt 重发（<conversation_history> 标签包裹），避免双记忆漂移
 * - **双层沙箱**：CC 自带 cwd 边界（= sandbox 工作目录）+ canUseTool 映射
 *   Sandbox（见 cc-permissions.ts）；allowedTools 绝不传（= 自动批准 = 绕过沙箱）
 * - **disallowedTools 摘除**而非 deny：WebFetch/WebSearch/Task 等直接从模型
 *   工具集里拿掉，省 turn、不污染 tool_calls
 * - **事件粒度**：每条 SDKAssistantMessage 发一次 onLlmCall（turn 递增，
 *   usage/stop_reason 逐 API 调用粒度，与 AnthropicBrain 语义对齐）；
 *   最后一条延迟到 result 后补发，附带 ccTotalCostUsd（SDK 口径总成本，
 *   含子代理）与 ccNumTurns
 * - **预算守卫自实现**：SDK 无逐消息成本回调 → 每条 assistant 用 pricing
 *   读时计价累计，超 budgetUsd 即 abortController.abort() + throw
 *   （pricing 未配价 → 降级仅 maxTurns，打一次 warn）
 * - **防双记**：canUseTool deny 的调用已在拒绝点发 blocked 事件并把
 *   toolUseID 记入 denied 集合，流里配对 tool_result 时跳过；收尾与
 *   result.permission_denials 对账，不符 warn
 */

import {
  query,
  createSdkMcpServer,
  tool as mcpTool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Brain, BrainEvents, BrainRequest } from "./brain.js";
import type { LlmCallEvent, ToolCallEvent } from "./agent.js";
import type { Sandbox, ToolResult } from "../tools/index.js";
import type { KnowledgeBase } from "../knowledge/knowledge-base.js";
import { KbSearchTool } from "../tools/builtin/kb-search.js";
import { KbWriteTool } from "../tools/builtin/kb-write.js";
import { costOf } from "../observability/pricing.js";
import { createLogger } from "../observability/logger.js";
import { makeCcCanUseTool, type CcPermissionSink } from "./cc-permissions.js";

const log = createLogger("cc-brain");

/**
 * 从模型工具集中直接摘除的工具（deny 会让模型反复重试浪费 turn）：
 * - WebFetch/WebSearch：项目无 web 权限模型
 * - Task：CC 原生子代理（成本不可控，future work）
 * - KillBash/BashOutput：后台 Bash 旁路（绕不开 validateCommand 的元字符拒绝，一并摘掉）
 * - NotebookEdit / AskUserQuestion：无头模式无意义
 */
const CC_DISALLOWED_TOOLS = [
  "WebFetch",
  "WebSearch",
  "Task",
  "KillBash",
  "BashOutput",
  "NotebookEdit",
  "AskUserQuestion",
];

/** CC brain 运行时依赖（REPL 每行重建时用 getter 取最新开关状态） */
export interface CcBrainDeps {
  kb?: KnowledgeBase;
  /** kb_write 是否放行（/kbwrite 开关 / --allow-kb-write） */
  kbWriteOn: boolean;
  /** 记忆系统是否启用（off → 不挂 team-kb MCP，与 toolRegistry 下线 kb 工具对齐） */
  memoryOn: boolean;
}

/** CC brain 守卫（成本/轮数护栏） */
export interface CcGuards {
  maxTurns: number;
  budgetUsd: number;
}

export const CC_GUARDS_DEFAULT: CcGuards = { maxTurns: 15, budgetUsd: 0.5 };

export interface ClaudeCodeBrainOptions {
  model: string;
  sandbox: Sandbox;
  /** 依赖快照函数（每次 reply 时调用，取当前开关状态） */
  deps: () => CcBrainDeps;
  guards?: CcGuards;
  /** per-Agent 工具白名单（cfg.tools / CLI --tools；映射为 canUseTool deny） */
  allowedTools?: string[];
}

export class ClaudeCodeBrain implements Brain {
  private readonly model: string;
  private readonly sandbox: Sandbox;
  private readonly deps: () => CcBrainDeps;
  private readonly guards: CcGuards;
  private readonly allowedTools?: string[];

  constructor(opts: ClaudeCodeBrainOptions) {
    this.model = opts.model;
    this.sandbox = opts.sandbox;
    this.deps = opts.deps;
    this.guards = opts.guards ?? CC_GUARDS_DEFAULT;
    this.allowedTools = opts.allowedTools;
  }

  /** CC runtime 恒有工具（原生 Read/Edit/Bash/Grep + team-kb MCP） */
  get hasTools(): boolean {
    return true;
  }

  async reply(req: BrainRequest, events: BrainEvents): Promise<string> {
    const deps = this.deps();
    const guards = this.guards;
    const abortController = new AbortController();

    // ── 权限映射（deny 点即发 blocked 事件；deniedToolUseIds 防流内双记）──
    let blockedEmitted = 0;
    const sink: CcPermissionSink = {
      deniedToolUseIds: new Set<string>(),
      allowedCount: 0,
      onBlocked: (b) => {
        blockedEmitted++;
        events.onToolCall({
          agentId: req.agentId,
          threadId: req.threadId,
          toolName: b.toolName,
          input: b.input,
          result: { content: b.message, isError: true },
          duration: 0,
          status: "blocked",
        });
      },
    };
    const canUseTool = makeCcCanUseTool(
      { sandbox: this.sandbox, allowedTools: this.allowedTools },
      sink
    );

    // ── team-kb MCP（进程内；memoryOn off → 不挂）──
    const mcpServers =
      deps.memoryOn && deps.kb
        ? { "team-kb": makeTeamKbMcpServer(deps, req) }
        : undefined;

    // ── 流状态机状态 ──
    const pendingToolUse = new Map<
      string,
      { name: string; input: unknown; ts: number }
    >();
    let turn = 0;
    let lastAssistantText = "";
    let lastLlmEvent: LlmCallEvent | null = null; // 延迟补发（挂 ccTotalCostUsd）
    let lastTs = Date.now(); // 消息到达时间（durationMs 近似用）
    let spentUsd = 0;
    let unpricedWarned = false;

    log.info("CC query 开始", {
      agentId: req.agentId,
      model: this.model,
      maxTurns: guards.maxTurns,
      budgetUsd: guards.budgetUsd,
      kbMcp: !!mcpServers,
    });

    let resultMsg:
      | (import("@anthropic-ai/claude-agent-sdk").SDKResultMessage)
      | null = null;

    try {
      for await (const msg of query({
        prompt: renderPrompt(req.messages),
        options: {
          model: this.model,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: req.systemPrompt,
          },
          cwd: this.sandbox.realWorkDir,
          maxTurns: guards.maxTurns,
          disallowedTools: CC_DISALLOWED_TOOLS,
          // 隔离模式：不加载任何文件系统设置（~/.claude/settings.json、项目
          // .claude/settings.local.json 里用户日常累积的 allow 规则会自动放行
          // Bash 等工具、绕过 canUseTool——实测 `Bash(npx tsx *)` 规则放过过
          // 写文件命令。Agent 的权限必须只由本项目的 Sandbox 决定）
          settingSources: [],
          canUseTool,
          ...(mcpServers ? { mcpServers } : {}),
          abortController,
          stderr: (data: string) => log.debug("[cc-stderr] " + data.trim()),
        },
      })) {
        const now = Date.now();

        if (msg.type === "assistant") {
          // durationMs 近似：优先用 SDK 自带 ISO timestamp（originating process 与本机同钟），
          // 与上一条 assistant 完成时刻作差 → turn 1 含子进程冷启动、turn N+1 含前置工具执行
          // （ADR-015 记录：拿不到纯 API 时延，此为 turn 墙钟时间的诚实近似）
          const blockTs =
            msg.timestamp && !Number.isNaN(Date.parse(msg.timestamp))
              ? Date.parse(msg.timestamp)
              : now;
          const durationMs = Math.max(1, blockTs - lastTs);
          lastTs = blockTs;
          turn++;

          // 记 pending tool_use（等 tool_result 配对发事件）
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              pendingToolUse.set(block.id, {
                name: block.name,
                input: block.input,
                ts: now,
              });
            }
          }

          const usage = msg.message.usage;
          const evt: LlmCallEvent = {
            agentId: req.agentId,
            threadId: req.threadId,
            model: msg.message.model ?? this.model,
            turn,
            durationMs,
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheCreationInputTokens:
              usage?.cache_creation_input_tokens ?? undefined,
            cacheReadInputTokens: usage?.cache_read_input_tokens ?? undefined,
            stopReason: msg.message.stop_reason ?? undefined,
          };

          // 预算守卫：读时计价累计（未配价 → 降级 warn 一次）
          if (evt.inputTokens > 0 || evt.outputTokens > 0) {
            const c = costOf(evt.model, evt.inputTokens, evt.outputTokens);
            if (c !== null) {
              spentUsd += c;
              if (spentUsd > guards.budgetUsd) {
                log.warn("CC 预算超限，abort", {
                  agentId: req.agentId,
                  spentUsd,
                  budgetUsd: guards.budgetUsd,
                });
                // 先把已有事件冲出去（丢最后这条未完成轮次的 span 也符合"崩溃丢 in-flight"取舍，
                // 但成本可见性更重要——带上已累计额 throw）
                if (lastLlmEvent) {
                  events.onLlmCall(lastLlmEvent);
                  lastLlmEvent = null;
                }
                abortController.abort();
                throw new Error(
                  `CC 预算超限：累计 ≈ $${spentUsd.toFixed(4)} > 上限 $${guards.budgetUsd}（--cc-budget= 调整）`
                );
              }
            } else if (!unpricedWarned) {
              unpricedWarned = true;
              log.warn(
                `pricing.json 未配模型 ${evt.model} 单价，预算守卫降级为仅 maxTurns`
              );
            }
          }

          // 延迟补发：上一条先冲出（它确定不是最后一条），本条挂起等 result 附成本
          if (lastLlmEvent) {
            events.onLlmCall(lastLlmEvent);
          }
          lastLlmEvent = evt;

          const text = msg.message.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n");
          if (text.trim()) lastAssistantText = text;
        } else if (msg.type === "user") {
          // tool_result 配对发 ToolCallEvent（deny 过的跳过——已在拒绝点发过 blocked）
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                typeof block === "object" &&
                block !== null &&
                "tool_use_id" in block &&
                (block as { type?: string }).type === "tool_result"
              ) {
                const tr = block as {
                  tool_use_id: string;
                  content?: unknown;
                  is_error?: boolean;
                };
                if (sink.deniedToolUseIds.has(tr.tool_use_id)) continue;
                const pending = pendingToolUse.get(tr.tool_use_id);
                if (!pending) continue;
                pendingToolUse.delete(tr.tool_use_id);
                const event: ToolCallEvent = {
                  agentId: req.agentId,
                  threadId: req.threadId,
                  toolName: pending.name,
                  input: pending.input,
                  result: {
                    content: normalizeToolResultContent(tr.content),
                    isError: !!tr.is_error,
                  },
                  duration: Math.max(1, now - pending.ts),
                  status: tr.is_error ? "error" : "ok",
                };
                events.onToolCall(event);
              }
            }
          }
        } else if (msg.type === "result") {
          resultMsg = msg;
          // 补发挂起的最后一条 llm 事件：此刻才知道 SDK 口径总成本/总轮数
          if (lastLlmEvent) {
            lastLlmEvent.ccTotalCostUsd = msg.total_cost_usd;
            lastLlmEvent.ccNumTurns = msg.num_turns;
            events.onLlmCall(lastLlmEvent);
            lastLlmEvent = null;
          }
        }
        // 其余消息类型（stream_event/system/status/…）：观测面暂不消费
      }
    } catch (e) {
      // 本版 SDK 对 error_max_turns 等 error result 是直接 throw（不发 result 消息），
      // 在此转换：轮数上限 → 返回已产出部分文本（对齐 AnthropicBrain maxToolTurns 用尽行为）
      const msgText = e instanceof Error ? e.message : String(e);
      if (/maximum number of turns/i.test(msgText)) {
        log.warn("CC 轮数上限（SDK throw 路径）", { agentId: req.agentId });
        return lastAssistantText || "(CC 轮数上限，无产出文本)";
      }
      // 预算 abort 自己抛的已带上下文；其他异常透传（对齐 AnthropicBrain API 报错即 throw）
      throw e;
    } finally {
      // 冲出挂起的最后一条 llm 事件（正常路径在下方 result 处理时已带成本冲出）
      if (lastLlmEvent) {
        events.onLlmCall(lastLlmEvent);
        lastLlmEvent = null;
      }
    }

    const result = resultMsg;
    if (!result) {
      // 流结束但没有 result（SDK 异常路径）——返回已有文本，保持"尽力产出"语义
      log.warn("CC 流结束但无 result 消息", { agentId: req.agentId });
      return lastAssistantText || "(CC 无结果)";
    }

    // 对账：blocked 事件数 vs SDK 汇总的 permission_denials（不符仅 warn，不阻断）
    const sdkDenials = result.permission_denials?.length ?? 0;
    if (sdkDenials !== blockedEmitted) {
      log.warn(
        "CC blocked 事件与 permission_denials 数量不一致（对账告警）",
        { sdkDenials, blockedEmitted, agentId: req.agentId }
      );
    }

    if (result.subtype === "success") {
      log.info("CC query 成功", {
        agentId: req.agentId,
        turns: result.num_turns,
        costUsd: result.total_cost_usd,
        durationMs: result.duration_ms,
      });
      return result.result;
    }
    if (result.subtype === "error_max_turns") {
      // 对齐 AnthropicBrain：轮数用尽不 throw，返回已产出的部分文本
      log.warn("CC 轮数上限", { agentId: req.agentId, turns: result.num_turns });
      return lastAssistantText || "(CC 轮数上限，无产出文本)";
    }
    // error_during_execution / error_max_budget_usd / 其他：throw
    throw new Error(
      `Claude Code 执行失败（${result.subtype}）：${(result as { errors?: string[] }).errors?.join("; ") ?? ""}（累计 ≈ $${result.total_cost_usd.toFixed(4)}）`
    );
  }
}

/**
 * 渲染 prompt：历史包 <conversation_history>、当前输入包 <current_message>。
 * CC preset 下的模型是"任务执行者"——显式框住历史防它逐条回应整个 transcript。
 * messages 由 Agent 投影好（归属标注 + 同角色合并），末位是当前输入。
 */
function renderPrompt(messages: { role: "user" | "assistant"; content: string }[]): string {
  if (messages.length === 0) return "(空输入)";
  const history = messages.slice(0, -1);
  const current = messages[messages.length - 1];

  const parts: string[] = [];
  if (history.length > 0) {
    parts.push("<conversation_history>");
    for (const m of history) {
      const who = m.role === "user" ? "用户" : "assistant";
      parts.push(`${who}: ${m.content}`);
    }
    parts.push("</conversation_history>");
  }
  parts.push("<current_message>");
  parts.push(current.content);
  parts.push("</current_message>");
  parts.push("（conversation_history 仅作上下文；请只回应 current_message。）");
  return parts.join("\n");
}

/** SDK tool_result content（string | block 数组）→ 项目 ToolResult.content 字符串 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) {
          return String((b as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/**
 * team-kb MCP server（进程内）：kb_search / kb_write 直通现有 Tool 实现。
 * zod schema 与 kb 工具的 inputSchema 是两份真相——修改工具参数时两处同步。
 * kb_write 未授权时工具内部返回 err（status=error 而非 blocked，与旧 runtime 一致）。
 */
function makeTeamKbMcpServer(
  deps: CcBrainDeps,
  req: BrainRequest
): ReturnType<typeof createSdkMcpServer> {
  const kb = deps.kb!;
  const search = new KbSearchTool(kb);
  const write = new KbWriteTool(kb, { allowWrite: deps.kbWriteOn });
  const ctx = { agentId: req.agentId, threadId: req.threadId };

  const toMcp = (r: ToolResult) => ({
    content: [{ type: "text" as const, text: r.content }],
    ...(r.isError ? { isError: true } : {}),
  });

  return createSdkMcpServer({
    name: "team-kb",
    tools: [
      mcpTool(
        "kb_search",
        search.description,
        {
          query: z.string().describe("检索词（项目主题、技术名词等）"),
          type: z
            .string()
            .optional()
            .describe("条目类型过滤: decision | lesson | observation | outcome"),
          limit: z.number().optional().describe("返回条数上限（默认 5）"),
        },
        async (args) =>
          toMcp(
            await search.execute(args as Record<string, unknown>, ctx)
          )
      ),
      mcpTool(
        "kb_write",
        write.description,
        {
          type: z
            .string()
            .describe("条目类型: decision（决策） | lesson（教训） | observation（观察） | outcome（结论）"),
          title: z.string().describe("短标题（≤20 字）"),
          content: z.string().describe("自包含内容（脱离当前对话也能读懂，≤120 字）"),
          keywords: z.array(z.string()).optional().describe("检索关键词（3-5 个）"),
        },
        async (args) =>
          toMcp(await write.execute(args as Record<string, unknown>, ctx))
      ),
    ],
  });
}
