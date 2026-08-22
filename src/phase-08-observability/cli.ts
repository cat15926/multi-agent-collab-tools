/**
 * Phase 8 — CLI 入口（Observability 版）
 *
 * 在 Phase 7 基础上给系统装"可观测"。四条能力线（验收：一次协作产出完整轨迹）：
 *   - trace：一次协作一个 trace（chat/pattern/distill），spans 树记录 route→step→agent→llm/tool
 *   - 计费：llm span 存 token 事实，读时乘 config/pricing.json 单价
 *   - 回放：trace show 瀑布树；每轮结束打 📊 回执行
 *   - 日志：JSONL 结构化日志（~/.multi-agent-collab-tools/logs/，绝不写 stdout）
 *
 * 用法（Phase 7 全部用法不变）：
 *   npm run phase8 -- trace [list] [N] · trace show <id|last> [--full]
 *   npm run phase8 -- stats [--by=agent|thread|day]
 *   npm run phase8 -- "任务" --pattern=pipeline --agents=a,b   # 跑完自动打回执行
 *   npm run phase8 -- "..." --verbose                            # stderr 放开 info/debug 日志
 */

import { resolve } from "path";
import { AgentRegistry } from "./registry/agent-registry.js";
import { Router } from "./router/index.js";
import { ThreadManager } from "./thread/manager.js";
import { Storage } from "./storage/sqlite.js";
import { Agent } from "./agent/agent.js";
import type { AgentOptions } from "./agent/agent.js";
import { Orchestrator } from "./orchestrator/index.js";
import { globalPatternRegistry, type PatternConfig } from "./pattern/registry.js";
import type { PatternEvents } from "./pattern/index.js";
import { PipelinePattern } from "./patterns/pipeline.js";
import { ParallelPattern } from "./patterns/parallel.js";
import { DebatePattern } from "./patterns/debate.js";
import { HierarchyPattern } from "./patterns/hierarchy.js";
import { ToolRegistry, Sandbox, createBuiltinTools, createKbTools } from "./tools/index.js";
import { KnowledgeBase } from "./knowledge/knowledge-base.js";
import type { EvidenceType } from "./knowledge/types.js";
import { EVIDENCE_TYPES } from "./knowledge/types.js";
import { Tracer } from "./observability/tracer.js";
import { createLogger, ensureLogDir, setStderrLevel, type LogLevel } from "./observability/logger.js";
import { costOf, formatCost, formatTokens } from "./observability/pricing.js";
import { renderTrajectory, fmtMs } from "./observability/trajectory.js";

const log = createLogger("cli");

/** 命令行参数 */
interface CliArgs {
  input: string | null;
  help: boolean;
  listTools: boolean;
  listPatterns: boolean;
  listAgents: boolean;
  showThreads: boolean;
  threadsLimit: number | null;
  threadId: string | null;
  showWorkflow: boolean;
  showTools: boolean;
  patternName: string | null;
  agents: string[];
  aggregator: string | null;
  rounds: number | null;
  manager: string | null;
  workers: string[];
  noA2a: boolean;
  a2aMode: string | null;
  tools: string[];
  workdir: string | null;
  allowWrite: boolean;
  allowExec: boolean;
  // ─── 知识库（Phase 7 新增）─────────────────────────────────────
  showMemory: boolean;
  kbAdd: string | null;
  kbSearch: string | null;
  kbList: boolean;
  kbDel: string | null;
  kbVerify: string | null;
  kbStats: boolean;
  kbDistill: boolean;
  kbType: string | null;
  kbTitle: string | null;
  kbKeywords: string[];
  kbAgent: string | null;
  kbLimit: number | null;
  force: boolean;
  autoDistill: boolean;
  distillModel: string | null;
  noMemory: boolean;
  allowKbWrite: boolean;
  // ─── 可观测（Phase 8 新增）─────────────────────────────────────
  traceList: boolean; // trace [list] [N]
  traceLimit: number | null;
  traceShow: string | null; // trace show <id|last>
  traceFull: boolean; // --full（展开全部 preview）
  statsBy: string | null; // stats [--by=agent|thread|day]
  logLevel: string | null; // --log-level= / --verbose（同 --log-level=debug）
}

/** 解析命令行参数 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const r: CliArgs = {
    input: null,
    help: false,
    listTools: false,
    listPatterns: false,
    listAgents: false,
    showThreads: false,
    threadsLimit: null,
    threadId: null,
    showWorkflow: false,
    showTools: false,
    patternName: null,
    agents: [],
    aggregator: null,
    rounds: null,
    manager: null,
    workers: [],
    noA2a: false,
    a2aMode: null,
    tools: [],
    workdir: null,
    allowWrite: false,
    allowExec: false,
    showMemory: false,
    kbAdd: null,
    kbSearch: null,
    kbList: false,
    kbDel: null,
    kbVerify: null,
    kbStats: false,
    kbDistill: false,
    kbType: null,
    kbTitle: null,
    kbKeywords: [],
    kbAgent: null,
    kbLimit: null,
    force: false,
    autoDistill: false,
    distillModel: null,
    noMemory: false,
    allowKbWrite: false,
    traceList: false,
    traceLimit: null,
    traceShow: null,
    traceFull: false,
    statsBy: null,
    logLevel: null,
  };

  // ─── 子命令拦截（kb add "x" --type=lesson / threads / trace / stats / help）──
  // 首个非 flag token 是保留字且次 token 是已知动作 → 按子命令解析，
  // 结果回填到同一批 CliArgs 字段（后续走既有分支，零新增处理层）。
  // 聊天输入以 @ 开头或含空格的普通句子不受影响。
  const nonFlag = args.filter((a) => !a.startsWith("-"));
  const isSubcommand =
    nonFlag.length >= 1 &&
    (nonFlag[0] === "kb" || nonFlag[0] === "threads" || nonFlag[0] === "help" ||
      nonFlag[0] === "trace" || nonFlag[0] === "stats");

  if (isSubcommand) {
    const [cmd, action, ...rest] = nonFlag;
    if (cmd === "help") {
      r.help = true;
      return r;
    }
    if (cmd === "threads") {
      r.showThreads = true;
      const n = parseInt(rest[0] ?? "", 10);
      if (!Number.isNaN(n) && n > 0) r.threadsLimit = n;
      return r;
    }
    if (cmd === "stats") {
      r.statsBy = "agent"; // 默认按 agent；--by= 覆盖
      // 修饰 flags 交给下方 flag 循环
      const flagsOnly = args.filter((a) => a.startsWith("-"));
      args.splice(0, args.length, ...flagsOnly);
      return r;
    }
    if (cmd === "trace") {
      // trace [list] [N] · trace show <id|last>
      if (action === "show") {
        r.traceShow = rest.find((a) => !a.startsWith("-")) ?? "last";
      } else {
        r.traceList = true; // 无动作 / list → 列表
        const n = parseInt(action === "list" ? (rest[0] ?? "") : (action ?? ""), 10);
        if (!Number.isNaN(n) && n > 0) r.traceLimit = n;
      }
      const flagsOnly = args.filter((a) => a.startsWith("-"));
      args.splice(0, args.length, ...flagsOnly);
      return r;
    }
    // kb <action> [operand] [flags...]
    switch (action) {
      case "add":
        r.kbAdd = rest.find((a) => !a.startsWith("-")) ?? null;
        break;
      case "search":
        r.kbSearch = rest.find((a) => !a.startsWith("-")) ?? null;
        break;
      case "list":
        r.kbList = true;
        break;
      case "stats":
        r.kbStats = true;
        break;
      case "del":
        r.kbDel = rest.find((a) => !a.startsWith("-")) ?? null;
        break;
      case "verify":
        r.kbVerify = rest.find((a) => !a.startsWith("-")) ?? null;
        break;
      case "distill":
        r.kbDistill = true;
        // operand 是 threadId（也可用 --thread= 提供）
        const tid = rest.find((a) => !a.startsWith("-"));
        if (tid) r.threadId = tid;
        break;
      default:
        console.error(`未知的知识库动作 "${action ?? ""}"。可用: add | search | list | stats | del | verify | distill`);
        process.exitCode = 1;
        return r;
    }
    // 修饰 flags（--type= / --title= / --keywords= / --agent= / --limit= / --force / --distill-model= / --thread=）
    // 复用下面的 flag 循环：把已消费的子命令 token 剔掉，剩下的全部走 flag 解析
    const flagsOnly = args.filter((a) => a.startsWith("-"));
    args.splice(0, args.length, ...flagsOnly);
  }

  for (const arg of args) {
    if (arg === "--list-tools" || arg === "-lt") r.listTools = true;
    else if (arg === "--list-patterns" || arg === "-lp") r.listPatterns = true;
    else if (arg === "--list-agents" || arg === "-la" || arg === "--list" || arg === "-l")
      r.listAgents = true;
    else if (arg === "--show-threads" || arg === "-sth") r.showThreads = true;
    else if (arg === "--show-workflow" || arg === "-sw") r.showWorkflow = true;
    else if (arg === "--show-tools" || arg === "-st") r.showTools = true;
    else if (arg === "--show-memory" || arg === "-sm") r.showMemory = true;
    else if (arg === "--help" || arg === "-h") r.help = true;
    else if (arg === "--no-a2a") r.noA2a = true;
    else if (arg === "--allow-write") r.allowWrite = true;
    else if (arg === "--allow-exec") r.allowExec = true;
    else if (arg === "--kb-list") r.kbList = true;
    else if (arg === "--kb-stats") r.kbStats = true;
    else if (arg === "--kb-distill") r.kbDistill = true;
    else if (arg === "--force") r.force = true;
    else if (arg === "--auto-distill") r.autoDistill = true;
    else if (arg === "--no-memory") r.noMemory = true;
    else if (arg === "--allow-kb-write") r.allowKbWrite = true;
    else if (arg.startsWith("--tools=")) r.tools = arg.split("=")[1].split(",");
    else if (arg.startsWith("--workdir=")) r.workdir = arg.split("=")[1];
    else if (arg.startsWith("--pattern=")) r.patternName = arg.split("=")[1];
    else if (arg.startsWith("--agents=")) r.agents = arg.split("=")[1].split(",");
    else if (arg.startsWith("--aggregator=")) r.aggregator = arg.split("=")[1];
    else if (arg.startsWith("--rounds=")) r.rounds = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--manager=")) r.manager = arg.split("=")[1];
    else if (arg.startsWith("--workers=")) r.workers = arg.split("=")[1].split(",");
    else if (arg.startsWith("--a2a-mode=")) r.a2aMode = arg.split("=")[1];
    else if (arg.startsWith("--thread=")) r.threadId = arg.split("=")[1];
    else if (arg.startsWith("--threads=")) r.threadsLimit = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--kb-add=")) r.kbAdd = arg.slice("--kb-add=".length);
    else if (arg.startsWith("--kb-search=")) r.kbSearch = arg.slice("--kb-search=".length);
    else if (arg.startsWith("--kb-del=")) r.kbDel = arg.slice("--kb-del=".length);
    else if (arg.startsWith("--kb-verify=")) r.kbVerify = arg.slice("--kb-verify=".length);
    else if (arg.startsWith("--type=")) r.kbType = arg.split("=")[1];
    else if (arg.startsWith("--title=")) r.kbTitle = arg.slice("--title=".length);
    else if (arg.startsWith("--keywords=")) r.kbKeywords = arg.split("=")[1].split(",").map((k) => k.trim()).filter(Boolean);
    else if (arg.startsWith("--agent=")) r.kbAgent = arg.split("=")[1];
    else if (arg.startsWith("--limit=")) r.kbLimit = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--distill-model=")) r.distillModel = arg.split("=")[1];
    else if (arg === "--verbose") r.logLevel = "debug"; // Phase 8：stderr 放开到 debug
    else if (arg.startsWith("--log-level=")) r.logLevel = arg.split("=")[1];
    else if (arg === "--full") r.traceFull = true;
    else if (arg.startsWith("--by=")) r.statsBy = arg.split("=")[1];
    else if (arg.startsWith("--")) console.warn(`⚠️  未识别的参数 "${arg}"（已忽略）`);
    else r.input = arg;
  }

  return r;
}

/** 列出所有工具 */
export function listTools(registry: ToolRegistry): void {
  const tools = registry.list();
  console.log("\n可用的工具：\n");
  if (tools.length === 0) {
    console.log("  (无)");
  }
  for (const t of tools) {
    console.log(`  ${t.name}`);
    console.log(`     ${t.description}`);
    console.log();
  }
}

/** 列出所有 Pattern */
export function listPatterns(): void {
  const patterns = globalPatternRegistry.listAll();
  console.log("\n可用的协作模式 (Pattern)：\n");
  for (const pattern of patterns) {
    console.log(`  ${pattern.name}`);
    console.log(`     描述: ${pattern.description}`);
    console.log();
  }
}

/** 列出所有 Agent */
export function listAgents(registry: AgentRegistry): void {
  const agents = registry.listAll();
  if (agents.length === 0) {
    console.log("没有找到任何 Agent 配置文件。");
    return;
  }
  console.log("\n可用的 Agent：\n");
  for (const agent of agents) {
    const isDefault = agent.id === registry.getDefaultAgentId() ? " (默认)" : "";
    const tools = agent.tools?.length ? `  工具: ${agent.tools.join(", ")}` : "";
    console.log(`  ${agent.emoji} ${agent.name} (${agent.id})${isDefault}`);
    console.log(`     模型: ${agent.model}`);
    console.log(`     人格: ${agent.persona.slice(0, 60)}...`);
    if (tools) console.log(tools);
    console.log();
  }
}

/** Agent 构造选项工厂（one-shot / REPL 共用）：工具 + onToolCall/onLlmCall（实时输出 + 落盘 + span）
 *  Phase 8：llm/tool span 在此落盘（事件驱动 recordSpan——回调在包裹作用域内触发，
 *  ALS 保证挂到正确的 agent/a2a 父 span 下；不在 trace 内 → recordSpan 内部零记录） */
export function makeAgentOptionsFactory(
  storage: Storage,
  toolRegistry: ToolRegistry,
  sandbox: Sandbox,
  tracer?: Tracer
): () => AgentOptions {
  return () => ({
    toolRegistry,
    sandbox,
    onToolCall: (info) => {
      const icon =
        info.status === "ok" ? "🔧" : info.status === "blocked" ? "🚫" : "⚠️";
      const inputStr = JSON.stringify(info.input);
      const inputPreview =
        inputStr.length > 80 ? inputStr.slice(0, 80) + "..." : inputStr;
      console.log(`${icon} @${info.agentId} ${info.toolName}(${inputPreview})`);
      console.log(`   → ${info.status} · ${info.duration}ms`);

      // 落盘（失败不阻塞主流程）
      let toolCallId: string | undefined;
      try {
        const row = storage.addToolCall({
          threadId: info.threadId,
          agentId: info.agentId,
          toolName: info.toolName,
          input: inputStr,
          output: info.result.content.slice(0, 2000),
          status: info.status,
          durationMs: info.duration,
        });
        toolCallId = row.id; // Phase 8：span attrs 链接领域行
      } catch {
        /* 落盘失败忽略 */
      }

      // Phase 8：tool span（观测平面只存时序/状态/链接，大 payload 留 tool_calls）
      tracer?.recordSpan(
        `tool:${info.toolName}`,
        "tool",
        { startTs: Date.now() - info.duration, endTs: Date.now() },
        {
          tool_name: info.toolName,
          status: info.status,
          input_preview: inputStr.slice(0, 200),
          ...(toolCallId ? { tool_call_id: toolCallId } : {}),
        },
        {
          agentId: info.agentId,
          status: info.status === "ok" ? "ok" : "error",
          error: info.status !== "ok" ? info.result.content.slice(0, 200) : undefined,
        }
      );
    },
    onLlmCall: (info) => {
      // Phase 8：llm span（token 计费数据源；attributes 键名与 summarizeLlmUsage 的 json_extract 对齐）
      tracer?.recordSpan(
        `llm:${info.model}`,
        "llm",
        { startTs: Date.now() - info.durationMs, endTs: Date.now() },
        {
          model: info.model,
          turn: info.turn,
          input_tokens: info.inputTokens,
          output_tokens: info.outputTokens,
          ...(info.cacheCreationInputTokens !== undefined
            ? { cache_creation_input_tokens: info.cacheCreationInputTokens }
            : {}),
          ...(info.cacheReadInputTokens !== undefined
            ? { cache_read_input_tokens: info.cacheReadInputTokens }
            : {}),
          ...(info.stopReason ? { stop_reason: info.stopReason } : {}),
        },
        {
          agentId: info.agentId,
          status: info.error ? "error" : "ok",
          error: info.error,
        }
      );
    },
  });
}

/** buildAgent 工厂（one-shot / REPL 共用）：CLI --tools 优先，否则 Agent 配置 tools */
export function buildAgentFactory(
  registry: AgentRegistry,
  storage: Storage,
  makeAgentOptions: () => AgentOptions,
  toolsOverride: string[]
): (agentId: string) => Agent {
  return (agentId: string): Agent => {
    const cfg = registry.get(agentId);
    if (!cfg) {
      throw new Error(`找不到 Agent "${agentId}"（--list-agents 查看）`);
    }
    storage.upsertAgent(cfg);
    const opts = makeAgentOptions();
    opts.allowedTools = toolsOverride.length > 0 ? toolsOverride : (cfg.tools ?? undefined);
    return new Agent(cfg, opts);
  };
}

/** Pattern 校验 + PatternConfig 组装（one-shot / REPL 共用；不合法直接 throw） */
export function buildPatternConfig(
  patternName: string,
  opts: {
    noA2a?: boolean;
    agents: string[];
    aggregator?: string | null;
    rounds?: number | null;
    manager?: string | null;
    workers?: string[];
  }
): PatternConfig {
  if (!globalPatternRegistry.get(patternName)) {
    throw new Error(`Pattern "${patternName}" 不存在（--list-patterns / /patterns 查看）`);
  }
  const config: PatternConfig = { patternName, a2aEnabled: !opts.noA2a };

  // 修复 Phase 7 回归：runPattern 从 config.agents 解析参与 Agent，但此处从未
  // 写入 → pipeline/parallel 的 --agents= 被静默忽略、只跑默认 Agent（hierarchy/
  // debate 走 manager/workers、agentA/B 不受影响）。统一带上，下游按模式取用。
  config.agents = opts.agents;

  if (patternName === "parallel") {
    if (!opts.aggregator) throw new Error("parallel 模式需要指定 --aggregator=ID");
    config.aggregator = opts.aggregator;
  }
  if (patternName === "debate") {
    if (opts.agents.length !== 2) throw new Error("debate 模式需要恰好 2 个 Agent（--agents=A,B）");
    config.agentA = opts.agents[0];
    config.agentB = opts.agents[1];
    config.maxRounds = opts.rounds || 3;
  }
  if (patternName === "hierarchy") {
    if (!opts.manager) throw new Error("hierarchy 模式需要指定 --manager=ID");
    if (!opts.workers || opts.workers.length === 0) throw new Error("hierarchy 模式需要指定 --workers=A,B");
    config.manager = opts.manager;
    config.workers = opts.workers;
  }
  return config;
}

/** Pattern 执行（one-shot 分支 2 / REPL /pattern 共用）
 *  返回 success；不 process.exit（REPL 里要继续循环）
 *  Phase 8：tracer 提供则整次编排包 pattern trace（step→agent→llm/tool span 树） */
export async function runPattern(params: {
  patternName: string;
  task: string;
  threadId: string;
  config: PatternConfig;
  registry: AgentRegistry;
  threads: ThreadManager;
  storage: Storage;
  orchestrator: Orchestrator;
  buildAgent: (agentId: string) => Agent;
  autoDistill?: boolean;
  force?: boolean;
  distillModel?: string | null;
  kb?: KnowledgeBase;
  tracer?: Tracer;
  entry?: "cli" | "repl";
}): Promise<boolean> {
  const pattern = globalPatternRegistry.get(params.patternName)!;
  const { registry, threads, storage, orchestrator } = params;

  // 确定参与 Agent（config 是 index-signature 类型，先收窄）
  const cfgAgents = (params.config.agents as string[] | undefined) ?? [];
  const agentIds: string[] =
    params.patternName === "hierarchy"
      ? [params.config.manager as string, ...((params.config.workers as string[]) ?? [])]
      : params.patternName === "parallel"
      ? [...cfgAgents, params.config.aggregator as string]
      : cfgAgents.length > 0
      ? cfgAgents
      : [registry.getDefaultAgentId() || "ji-tui"];

  const agents = agentIds.map((id) => {
    threads.addParticipant(params.threadId, id);
    return params.buildAgent(id);
  });

  // 存储用户消息
  storage.addMessage({
    conversationId: params.threadId,
    role: "user",
    content: params.task,
  });

  console.log(`\n使用 ${pattern.name} 模式执行任务...`);
  console.log(`会话 ID: ${params.threadId}`);
  console.log(`参与 Agent: ${agentIds.join(", ")}\n`);

  // Pattern 步骤实时输出（复用 Phase 5 的 PatternEvents）
  const events: PatternEvents = {
    onStepStart: ({ stepNumber, agentId }) => {
      console.log(`\n──── Step ${stepNumber} · @${agentId} ────`);
    },
    onStepComplete: ({ agentId, output, success, duration, error }) => {
      if (success) {
        console.log(`\n${output}`);
        console.log(`  ✓ @${agentId} · ${duration}ms\n`);
      } else {
        console.log(`  ✗ @${agentId} 失败 · ${error}\n`);
      }
    },
  };

  // Phase 8：pattern trace（整次编排一个 trace；traceId 存下来供回执行提示）
  let traceId: string | undefined;
  const execute = async () =>
    orchestrator.executePattern({
      patternName: params.patternName,
      task: params.task,
      agents,
      threadId: params.threadId,
      config: params.config,
      events,
    });

  let result;
  if (params.tracer) {
    const trace = params.tracer.startTrace("pattern", {
      entry: params.entry ?? "cli",
      threadId: params.threadId,
      title: params.task.slice(0, 200),
    });
    traceId = trace.id;
    log.debug("pattern trace 开始", { traceId, pattern: params.patternName });
    result = await params.tracer.run(trace, execute);
  } else {
    result = await execute();
  }

  storage.addMessage({
    conversationId: params.threadId,
    role: "assistant",
    content: result.finalOutput,
    agentId: agentIds[agentIds.length - 1],
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`执行结果: ${result.success ? "成功" : "失败"}`);
  console.log(`执行步骤: ${result.steps.length}`);
  console.log(`总耗时: ${result.metadata.duration}ms`);
  console.log(`${"=".repeat(60)}\n`);

  if (!result.success) {
    console.error(`执行失败: ${result.failureReason}`);
  }

  // Phase 8：回执行（tokens/耗时/轨迹入口）
  if (traceId) printReceipt(storage, traceId);

  // Phase 7：--auto-distill（pattern 成功后提炼；编排器本身零 LLM 直接调用）
  if (params.autoDistill && result.success && params.kb) {
    console.log();
    await runDistill(storage, params.kb!, params.threadId, {
      force: params.force,
      distillModel: params.distillModel,
      tracer: params.tracer,
      entry: params.entry,
    });
  }

  console.log(`工具调用回放: npm run phase8 -- --thread=${params.threadId} --show-tools`);
  console.log(`记忆注入回放: npm run phase8 -- --thread=${params.threadId} --show-memory\n`);
  return result.success;
}

/** 会话列表渲染（threads 子命令 / --show-threads / REPL /threads 共用）
 *  注意：conversations 表时间戳是秒（历史遗留），渲染时 ×1000 */
export function printThreads(storage: Storage, limit: number = 10): void {
  const convs = storage.listConversations().slice(0, limit);
  if (convs.length === 0) {
    console.log("还没有任何会话。");
    return;
  }
  console.log(`\n最近会话（${convs.length}）：\n`);
  for (const c of convs) {
    const messages = storage.getMessages(c.id);
    const last = messages[messages.length - 1];
    const preview = last ? last.content.replace(/\s+/g, " ").slice(0, 40) : "（无消息）";
    console.log(`  ${c.id}  ${new Date(c.updatedAt * 1000).toLocaleString()} · ${messages.length} 条消息`);
    console.log(`    最后: ${preview}${last && last.content.length > 40 ? "…" : ""}`);
  }
  console.log();
}

/** 解析 "last" 魔法值为最近会话 ID（--thread=last / /thread last 共用） */
export function resolveThreadRef(storage: Storage, ref: string): string | null {
  if (ref !== "last") return ref;
  const latest = storage.listConversations()[0];
  return latest ? latest.id : null;
}

/** ─── 知识库 op（三个入口共用：旧 flag / kb 子命令 / REPL /kb）────────── */

export function opKbAdd(
  kb: KnowledgeBase,
  input: {
    content: string;
    type: string | null;
    title: string | null;
    keywords: string[];
    threadId: string | null;
    agent: string | null;
  }
): void {
  const type = input.type as EvidenceType;
  if (!EVIDENCE_TYPES.includes(type)) {
    console.error(`错误: --type 必须是 ${EVIDENCE_TYPES.join(" | ")}（当前: ${input.type ?? "未提供"}）`);
    process.exitCode = 1;
    return;
  }
  const entry = kb.add({
    type,
    title: input.title ?? input.content.slice(0, 20),
    content: input.content,
    keywords: input.keywords,
    sourceThread: input.threadId ?? undefined,
    sourceAgent: input.agent ?? "user",
    verified: true, // 人工添加 = 已验证
  });
  console.log(`✓ 已添加 [${entry.type}] ${entry.title}（id: ${entry.id}）`);
}

export function opKbSearch(
  kb: KnowledgeBase,
  query: string,
  opts: { type?: string | null; limit?: number | null } = {}
): void {
  const hits = kb.search(query, {
    limit: opts.limit ?? 10,
    type: (opts.type as EvidenceType) ?? undefined,
  });
  if (hits.length === 0) {
    console.log(`未找到与 "${query}" 相关的条目。`);
  } else {
    console.log(`\n检索 "${query}" 命中 ${hits.length} 条：\n`);
    for (const h of hits) {
      const mark = h.entry.verified ? " ✓" : "";
      console.log(`  [${h.entry.type}] ${h.entry.title}${mark}（score ${h.score}）`);
      console.log(`    ${h.entry.content.slice(0, 100)}`);
      console.log(`    来源: ${h.entry.sourceThread ?? "手动"} · ${h.entry.sourceAgent ?? "-"} · ${new Date(h.entry.timestamp).toLocaleString()}`);
      console.log();
    }
  }
}

export function opKbList(kb: KnowledgeBase, opts: { type?: string | null; limit?: number | null } = {}): void {
  const entries = kb.list({
    type: (opts.type as EvidenceType) ?? undefined,
    limit: opts.limit ?? 20,
  });
  if (entries.length === 0) {
    console.log("知识库为空。");
    return;
  }
  console.log(`\n知识库条目（${entries.length} 条）：\n`);
  for (const e of entries) {
    const mark = e.verified ? " ✓" : "";
    console.log(`  [${e.type}] ${e.title}${mark}（${e.id}）`);
    console.log(`    ${e.content.slice(0, 100)}${e.content.length > 100 ? "…" : ""}`);
    console.log(`    keywords: ${e.keywords.join(", ") || "-"} · 来源: ${e.sourceThread ?? "手动"} · ${e.sourceAgent ?? "-"}`);
    console.log();
  }
}

export function opKbDel(kb: KnowledgeBase, id: string): void {
  const ok = kb.remove(id);
  console.log(ok ? `✓ 已删除 ${id}` : `未找到 ${id}`);
}

export function opKbVerify(storage: Storage, id: string): void {
  const ok = storage.setKbEntryVerified(id, true);
  console.log(ok ? `✓ 已背书 ${id}` : `未找到 ${id}`);
}

export function opKbStats(kb: KnowledgeBase): void {
  const s = kb.stats();
  console.log(`\n知识库统计：`);
  console.log(`  总条目: ${s.total}`);
  for (const [t, n] of Object.entries(s.byType)) {
    console.log(`    ${t}: ${n}`);
  }
  console.log(`  来源线程: ${s.threads}`);
  console.log(`  已背书: ${s.verified}`);
  if (s.lastAddedAt) console.log(`  最近添加: ${new Date(s.lastAddedAt).toLocaleString()}`);
}

/** 单 Agent 回复渲染（one-shot 分支 1 / REPL 共用） */
export function printReply(agentId: string, content: string, a2aReplies?: Array<{ agentId: string; content: string }>): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`@${agentId}:`);
  console.log(`${"─".repeat(60)}`);
  console.log(content);
  if (a2aReplies && a2aReplies.length > 0) {
    for (const reply of a2aReplies) {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`@${reply.agentId} (A2A):`);
      console.log(`${"─".repeat(60)}`);
      console.log(reply.content);
    }
  }
}

/** 显示工具调用记录（--show-tools / REPL /show tools 共用） */
export function showToolCalls(storage: Storage, threadId: string): void {
  const calls = storage.getToolCallsByThread(threadId);
  if (calls.length === 0) {
    console.log(`会话 ${threadId} 没有工具调用记录。`);
    return;
  }
  console.log(`\n会话 ${threadId} 的工具调用记录：\n`);
  for (const c of calls) {
    const icon = c.status === "ok" ? "✓" : c.status === "blocked" ? "🚫" : "✗";
    let inputPreview = "";
    try {
      inputPreview = c.input ? JSON.stringify(JSON.parse(c.input)).slice(0, 60) : "";
    } catch {
      inputPreview = (c.input ?? "").slice(0, 60);
    }
    console.log(`  ${icon} ${c.agentId} · ${c.toolName}(${inputPreview}) · ${c.durationMs}ms · ${c.status}`);
  }
}

/** 显示记忆注入记录（--show-memory，Phase 7）：注入必须可证明 */
export function showMemoryReads(storage: Storage, kb: KnowledgeBase, threadId: string): void {
  const reads = storage.getKbReadsByThread(threadId);
  if (reads.length === 0) {
    console.log(`会话 ${threadId} 没有记忆注入记录。`);
    return;
  }
  console.log(`\n会话 ${threadId} 的记忆注入记录：\n`);
  for (const r of reads) {
    const time = new Date(r.createdAt).toLocaleString();
    console.log(`  ${time} · ${r.consumer}`);
    console.log(`    query: ${r.query.slice(0, 60)}${r.query.length > 60 ? "…" : ""}`);
    for (const id of r.entryIds) {
      const e = kb.get(id);
      if (e) {
        console.log(`    → [${e.type}] ${e.title}${e.verified ? " ✓" : ""}`);
      } else {
        console.log(`    → ${id}（已删除）`);
      }
    }
    console.log();
  }
}

/** Phase 8 回执行：一轮结束打 tokens/成本/耗时 + 轨迹入口（one-shot 分支 1/2、REPL 共用） */
export function printReceipt(storage: Storage, traceId: string): void {
  const trace = storage.getTrace(traceId);
  if (!trace) return;
  const usage = storage.getTraceLlmUsage(traceId);
  const durS = ((trace.endedAt ?? Date.now()) - trace.startedAt) / 1000;
  // 成本按模型分算（单价不同）；任一模型未配价 → 整体 "?"（不猜）
  let cost = 0;
  let unknown = false;
  for (const [model, u] of Object.entries(usage.byModel)) {
    const c = costOf(model, u.inputTokens, u.outputTokens);
    if (c === null) unknown = true;
    else cost += c;
  }
  const costStr = unknown && usage.calls > 0 ? "?" : formatCost(cost);
  console.log(
    `📊 本轮: in ${formatTokens(usage.inputTokens)} / out ${formatTokens(usage.outputTokens)} tok` +
      ` · ${costStr} · ${durS.toFixed(1)}s · 轨迹回放: npm run p8 -- trace show ${traceId}`
  );
}

/** Phase 8 轨迹列表（trace 子命令 / REPL /trace 共用） */
export function opTraceList(storage: Storage, limit = 10): void {
  const traces = storage.listTraces(limit);
  if (traces.length === 0) {
    console.log("还没有任何轨迹（先跑一轮对话 / Pattern / 提炼）。");
    return;
  }
  const kindIcon: Record<string, string> = { chat: "💬", pattern: "🔀", distill: "🫙" };
  console.log(`\n近期轨迹（${traces.length}）：\n`);
  for (const t of traces) {
    const usage = storage.getTraceLlmUsage(t.id);
    let cost = 0;
    let unknown = false;
    for (const [model, u] of Object.entries(usage.byModel)) {
      const c = costOf(model, u.inputTokens, u.outputTokens);
      if (c === null) unknown = true;
      else cost += c;
    }
    const dur = t.endedAt ? t.endedAt - t.startedAt : Date.now() - t.startedAt;
    const status = t.status === "ok" ? "✅" : t.status === "error" ? "❌" : "⏳";
    console.log(
      `  ${kindIcon[t.kind] ?? "·"} ${t.id}  ${t.kind}/${t.entry} · ${status} ${fmtMs(dur)}` +
        ` · in ${formatTokens(usage.inputTokens)} / out ${formatTokens(usage.outputTokens)} tok` +
        ` · ${unknown && usage.calls > 0 ? "$?" : formatCost(cost)}`
    );
    const title = t.title ? t.title.replace(/\s+/g, " ").slice(0, 50) : "（无标题）";
    console.log(`    ${title} · ${new Date(t.startedAt).toLocaleString()}`);
  }
  console.log();
}

/** Phase 8 轨迹详情瀑布树（trace show 子命令 / REPL /trace show 共用） */
export function opTraceShow(storage: Storage, ref: string, full = false): void {
  const trace = ref === "last" ? storage.getLastTrace() : storage.getTrace(ref);
  if (!trace) {
    console.log(ref === "last" ? "还没有任何轨迹。" : `未找到轨迹 "${ref}"（trace list 查看）`);
    return;
  }
  const spans = storage.getSpansByTrace(trace.id);
  const usage = storage.getTraceLlmUsage(trace.id);
  console.log();
  for (const line of renderTrajectory(trace, spans, usage, full)) {
    console.log(line);
  }
  console.log();
}

/** Phase 8 token 计费聚合（stats 子命令 / REPL /stats 共用） */export function opStats(storage: Storage, by: "agent" | "thread" | "day", limit = 20): void {
  const rows = storage.summarizeLlmUsage(by, limit);
  if (rows.length === 0) {
    console.log("还没有任何 LLM 调用记录（先跑一轮对话或 Pattern）。");
    return;
  }
  // 按 key 归并（同 key 多模型 → tokens 累加、成本分模型算）
  const groups = new Map<string, { models: string[]; calls: number; inputTokens: number; outputTokens: number; cost: number | null }>();
  for (const r of rows) {
    const g = groups.get(r.key) ?? { models: [], calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    g.models.push(r.model);
    g.calls += r.calls;
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    const c = costOf(r.model, r.inputTokens, r.outputTokens);
    g.cost = g.cost === null || c === null ? null : g.cost + c;
    groups.set(r.key, g);
  }
  const label = by === "agent" ? "Agent" : by === "thread" ? "会话" : "日期";
  console.log(`\nToken 计费（按 ${label}，llm span 聚合）：\n`);
  for (const [key, g] of groups) {
    const models = g.models.length > 1 ? `${g.models.length} 个模型` : g.models[0];
    console.log(`  ${key}`);
    console.log(`    调用 ${g.calls} 次 · in ${formatTokens(g.inputTokens)} / out ${formatTokens(g.outputTokens)} tok · 成本 ${formatCost(g.cost)} · ${models}`);
  }
  console.log();
}

/** 组装提炼输入：会话消息 + workflow 步骤（中间步产出是教训主矿藏） */function buildDistillTranscript(storage: Storage, threadId: string): { transcript: string; task?: string } {
  const messages = storage.getMessages(threadId);
  const executions = storage.getWorkflowExecutionsByThread(threadId);

  const parts: string[] = [];
  let budget = 12000; // 总字符预算
  let task: string | undefined;

  // 会话消息（[user]/[agentId]: content）
  for (const m of messages) {
    if (m.role === "user" && !task) task = m.content;
    if (budget <= 0) {
      parts.push("…（已达预算上限，后续记录省略）");
      break;
    }
    const speaker = m.role === "user" ? "user" : (m.agentId ?? "agent");
    let content = m.content;
    if (content.length > 1500) content = content.slice(0, 1500) + "…";
    if (content.length > budget) content = content.slice(0, budget) + "…";
    budget -= content.length;
    parts.push(`[${speaker}]: ${content}`);
  }

  // workflow 中间步（不在 messages 里）
  for (const exec of executions) {
    if (!task) task = exec.task;
    const steps = storage.getWorkflowSteps(exec.id);
    for (const s of steps) {
      if (budget <= 0) {
        parts.push("…（已达预算上限，后续记录省略）");
        return { transcript: parts.join("\n\n"), task };
      }
      let output = s.outputText;
      if (output.length > 1500) output = output.slice(0, 1500) + "…";
      if (output.length > budget) output = output.slice(0, budget) + "…";
      budget -= output.length;
      parts.push(`[${s.agentId} · ${exec.patternName} step${s.stepNumber}]: ${output}`);
    }
  }

  return { transcript: parts.join("\n\n"), task };
}

/** 执行提炼（--kb-distill / --auto-distill / REPL /distill 共用）：scope 级幂等 + 失败显形落库
 *  kb 显式传参（不依赖 globalKb —— REPL 路径不经过 main()，全局量不可靠）
 *  Phase 8：tracer 提供则包 distill trace（llm span 计费归属 'distiller'） */
export async function runDistill(
  storage: Storage,
  kb: KnowledgeBase,
  threadId: string,
  opts: { force?: boolean; distillModel?: string | null; tracer?: Tracer; entry?: "cli" | "repl" }
): Promise<void> {
  const { transcript, task } = buildDistillTranscript(storage, threadId);

  // scope 级幂等：该 thread 已成功提炼过且未 --force → 跳过
  const latest = storage.getLatestDistillRun(threadId);
  if (!opts.force && latest && (latest.status === "ok" || latest.status === "duplicate_skipped")) {
    console.log(`已提炼过（${latest.status}，${latest.entriesAdded} 条），跳过；重跑请加 --force`);
    storage.addDistillRun({ threadId, scopeId: threadId, status: "duplicate_skipped", entriesAdded: 0 });
    return;
  }

  if (!transcript.trim()) {
    console.log("会话没有可提炼的记录。");
    storage.addDistillRun({ threadId, scopeId: threadId, status: "skipped_empty" });
    return;
  }

  console.log(`🫙 开始提炼（${transcript.length} 字记录）…`);
  const { Distiller } = await import("./knowledge/distiller.js");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const distiller = new Distiller(
    new Anthropic(),
    opts.distillModel ?? "claude-opus-4-8",
    kb,
    // Phase 8：llm span（挂在 distill span 下；计费归属 'distiller'）
    (info) => {
      opts.tracer?.recordSpan(
        `llm:${info.model}`,
        "llm",
        { startTs: Date.now() - info.durationMs, endTs: Date.now() },
        {
          model: info.model,
          turn: info.turn,
          input_tokens: info.inputTokens,
          output_tokens: info.outputTokens,
          ...(info.stopReason ? { stop_reason: info.stopReason } : {}),
        },
        { agentId: info.agentId, status: info.error ? "error" : "ok", error: info.error }
      );
    }
  );

  // Phase 8：distill trace + distill span（一次提炼一记；distill 报错不打断 trace 收口）
  const runIt = async (): Promise<void> => {
    try {
      const result = await distiller.distill({ threadId, transcript, task, force: opts.force });
      storage.addDistillRun({
        threadId,
        scopeId: threadId,
        status: result.status,
        entriesAdded: result.addedIds.length,
        rawOutput: result.status === "parse_failed" ? result.raw : undefined,
      });

      if (result.status === "ok") {
        console.log(`✓ 提炼完成：新增 ${result.addedIds.length} 条（重复跳过 ${result.skippedDuplicates}）`);
        for (const e of result.entries) {
          console.log(`  [${e.type}] ${e.title}`);
        }
      } else if (result.status === "duplicate_skipped") {
        console.log(`全部条目与已有重复，跳过 ${result.skippedDuplicates} 条`);
      } else if (result.status === "parse_failed") {
        console.error(`✗ 提炼输出解析失败，原始输出已存 kb_distill_runs（sqlite3 查 raw_output）`);
      } else {
        console.log(`状态: ${result.status}`);
      }
    } catch (err) {
      storage.addDistillRun({
        threadId,
        scopeId: threadId,
        status: "error",
        rawOutput: err instanceof Error ? err.message : String(err),
      });
      console.error("提炼失败:", err);
    }
  };

  if (opts.tracer) {
    const trace = opts.tracer.startTrace("distill", {
      entry: opts.entry ?? "cli",
      threadId,
      title: `提炼会话 ${threadId.slice(-8)}`,
    });
    await opts.tracer.run(trace, () =>
      opts.tracer!.runSpan("distill", "distill", async (span) => {
        span.setAttribute("thread_id", threadId);
        span.setAttribute("transcript_chars", transcript.length);
        await runIt();
      })
    );
    printReceipt(storage, trace.id);
  } else {
    await runIt();
  }
}

/** 工作流执行详情（--show-workflow / REPL /show workflow 共用） */
export function showWorkflowDetails(storage: Storage, threadId: string): void {

  const executions = storage.getWorkflowExecutionsByThread(threadId);
  if (executions.length === 0) {
    console.log(`会话 ${threadId} 没有工作流执行记录。`);
    return;
  }
  console.log(`\n会话 ${threadId} 的工作流执行记录：\n`);
  for (const execution of executions) {
    console.log(`  执行 ID: ${execution.id}`);
    console.log(`  Pattern: ${execution.patternName}`);
    console.log(`  任务: ${execution.task}`);
    console.log(`  状态: ${execution.status}`);
    console.log(`  开始时间: ${new Date(execution.startedAt).toLocaleString()}`);
    if (execution.completedAt) {
      console.log(`  完成时间: ${new Date(execution.completedAt).toLocaleString()}`);
      console.log(`  耗时: ${execution.completedAt - execution.startedAt}ms`);
    }
    console.log(`  参与 Agent: ${execution.agents.join(", ")}`);
    const steps = storage.getWorkflowSteps(execution.id);
    if (steps.length > 0) {
      console.log(`  执行步骤:`);
      for (const step of steps) {
        const status = step.success ? "✓" : "✗";
        console.log(`    ${status} Step ${step.stepNumber}: ${step.agentId} (${step.duration}ms)`);
        if (!step.success && step.error) console.log(`       错误: ${step.error}`);
      }
    }
    if (execution.error) console.log(`  错误: ${execution.error}`);
    console.log();
  }
}

/** 打印用法（分组；kb/trace 子命令为主推入口，旧 flag 兼容保留） */
function printUsage(): void {
  console.log(`
Phase 8 CLI — 对话 / 知识库 / 协作模式 / 可观测

对话:
  npm run phase8                                     # 无参数 → 交互模式（连续对话，免抄 thread ID）
  npm run phase8 -- "@agent 任务"                     # 单 Agent + 工具 + 记忆注入
  npm run phase8 -- "任务" --pattern=NAME --agents=A,B # Pattern 编排
  npm run phase8 -- "继续..." --thread=last           # 接着最近会话聊（last = 最近一条）

会话:
  npm run phase8 -- threads [N]                       # 最近会话列表（默认 10）
  npm run phase8 -- --thread=<id|last> --show-tools   # 工具调用回放
  npm run phase8 -- --thread=<id|last> --show-memory  # 记忆注入回放
  npm run phase8 -- --thread=<id|last> --show-workflow

可观测（Phase 8，子命令）:
  npm run phase8 -- trace [list] [N]                  # 近期轨迹列表（kind/耗时/tokens/成本/状态）
  npm run phase8 -- trace show <id|last> [--full]     # 轨迹瀑布树（route→step→agent→llm/tool）
  npm run phase8 -- stats [--by=agent|thread|day]     # token 计费聚合
  --verbose / --log-level=debug|info|warn|error       # 结构化日志 stderr 阈值
  （每轮对话/编排/提炼结束自动打 📊 回执行：tokens/成本/耗时/轨迹 id）

知识库（子命令，推荐）:
  npm run phase8 -- kb add "内容" --type=lesson --title=标题 [--keywords=a,b] [--thread=] [--agent=]
                                                     # type: decision|lesson|observation|outcome
  npm run phase8 -- kb search "词" [--type=] [--limit=N]
  npm run phase8 -- kb list [--type=] [--limit=N] · kb stats
  npm run phase8 -- kb del <id> · kb verify <id>
  npm run phase8 -- kb distill <threadId|last> [--force] [--distill-model=M]

知识库（旧 flag 写法，继续可用）:
  --kb-add= / --kb-search= / --kb-list / --kb-stats / --kb-del= / --kb-verify=
  --kb-distill --thread= / --auto-distill / --no-memory / --allow-kb-write

工具:
  --tools=A,B,C        限定可用工具（覆盖 Agent 配置）   --list-tools 列出
  --workdir=PATH       沙箱工作目录（默认当前目录）
  --allow-write        允许写文件    --allow-exec 允许非白名单命令

Pattern（与工具正交）:
  --pattern=NAME       pipeline / parallel / debate / hierarchy   --list-patterns 列出
  --agents=A,B,C / --aggregator=ID（parallel） / --rounds=N（debate）
  --manager=ID + --workers=A,B（hierarchy）

其他: --list-agents / help / -h / --help

示例:
  # 沉淀经验 → 下次对话自动注入
  npm run phase8 -- kb add "时间戳必须毫秒显式插入" --type=lesson --title="时间戳单位" --keywords=时间戳,毫秒
  npm run p8 -- "@bob 怎么处理时间戳存储？"

  # Pattern + 自动提炼 + 看轨迹
  npm run p8 -- "设计配置模块" --pattern=pipeline --agents=bob,ji-tui --auto-distill
  npm run p8 -- trace show last
`);
}

/** 主函数 */
async function main() {
  const args = parseArgs();

  // ─── --help / help / -h：分组用法，退出码 0 ─────────────────────
  if (args.help) {
    printUsage();
    return;
  }

  // ─── 无任何参数 → 进入 REPL 交互模式 ──────────────────────────
  if (process.argv.slice(2).length === 0) {
    const { startRepl } = await import("./repl.js");
    return startRepl();
  }

  // 初始化组件
  const storage = new Storage();
  const registry = new AgentRegistry();
  const threads = new ThreadManager(storage);

  // Phase 8：观测器 + 结构化日志（stderr 阈值默认 warn；--verbose/--log-level 放开）
  const tracer = new Tracer(storage);
  ensureLogDir();
  if (args.logLevel) {
    const lv = args.logLevel as LogLevel;
    if (["debug", "info", "warn", "error"].includes(lv)) setStderrLevel(lv);
    else console.warn(`⚠️  未知日志级别 "${lv}"（可用: debug|info|warn|error）`);
  }

  // Phase 7：知识库（--no-memory 时为 undefined → 全程零查询零注入零落盘）
  const kb = args.noMemory ? undefined : new KnowledgeBase(storage);

  const router = new Router(registry, threads, storage, { kb, tracer });
  const orchestrator = new Orchestrator(storage, { kb, tracer });

  // 注册所有 Pattern
  globalPatternRegistry.register(new PipelinePattern());
  globalPatternRegistry.register(new ParallelPattern());
  globalPatternRegistry.register(new DebatePattern());
  globalPatternRegistry.register(new HierarchyPattern());

  // 构建工具：沙箱 + 注册表（注册全部内置工具 + 知识库工具）
  const workDir = resolve(args.workdir ?? process.cwd());
  const sandbox = new Sandbox({
    workDir,
    allowWrite: args.allowWrite,
    allowExec: args.allowExec,
  });
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerAll(createBuiltinTools(sandbox));
  // Phase 7：kb 工具（kb_search 常驻只读；kb_write 受 --allow-kb-write 门控）
  if (kb) {
    toolRegistry.registerAll(createKbTools(kb, { allowWrite: args.allowKbWrite }));
  }

  // ─── Phase 7：知识库管理（旧 flag 入口；子命令入口在 parseArgs 里回填同一批字段）──
  if (args.kbAdd !== null) {
    opKbAdd(kb!, {
      content: args.kbAdd,
      type: args.kbType,
      title: args.kbTitle,
      keywords: args.kbKeywords,
      threadId: args.threadId,
      agent: args.kbAgent,
    });
    return;
  }

  if (args.kbSearch !== null) {
    opKbSearch(kb!, args.kbSearch, { type: args.kbType, limit: args.kbLimit });
    return;
  }

  if (args.kbList) {
    opKbList(kb!, { type: args.kbType, limit: args.kbLimit });
    return;
  }

  if (args.kbDel !== null) {
    opKbDel(kb!, args.kbDel);
    return;
  }

  if (args.kbVerify !== null) {
    opKbVerify(storage, args.kbVerify);
    return;
  }

  if (args.kbStats) {
    opKbStats(kb!);
    return;
  }

  // --thread=last / kb distill last → 最近会话 ID（必须在所有消费 threadId 的分支之前）
  if (args.threadId === "last") {
    const resolved = resolveThreadRef(storage, "last");
    if (!resolved) {
      console.error("错误: 还没有任何会话，无法使用 --thread=last");
      process.exit(1);
    }
    args.threadId = resolved;
  }

  // 处理 --list-* 命令
  if (args.listTools) return listTools(toolRegistry);
  if (args.listPatterns) return listPatterns();
  if (args.listAgents) return listAgents(registry);

  // 会话列表（threads 子命令 / --show-threads）
  if (args.showThreads) return printThreads(storage, args.threadsLimit ?? 10);

  // 处理 --show-* 命令
  if (args.showTools && args.threadId) return showToolCalls(storage, args.threadId);
  if (args.showWorkflow && args.threadId) return showWorkflowDetails(storage, args.threadId);
  if (args.showMemory && args.threadId) return showMemoryReads(storage, kb ?? new KnowledgeBase(storage), args.threadId);

  // Phase 8：轨迹查询（trace 子命令）
  if (args.traceList) return opTraceList(storage, args.traceLimit ?? 10);
  if (args.traceShow !== null) return opTraceShow(storage, args.traceShow, args.traceFull);

  // Phase 8：stats 计费聚合（stats 子命令）
  if (args.statsBy !== null) {
    const by = args.statsBy as "agent" | "thread" | "day";
    if (!["agent", "thread", "day"].includes(by)) {
      console.error(`错误: --by 只支持 agent|thread|day（当前: ${by}）`);
      process.exitCode = 1;
      return;
    }
    return opStats(storage, by, args.kbLimit ?? 20);
  }

  // 提炼命令（--kb-distill --thread=X）
  if (args.kbDistill) {
    if (!args.threadId) {
      console.error("错误: --kb-distill 需要 --thread=<id>");
      process.exit(1);
    }
    return runDistill(storage, kb!, args.threadId, {
      force: args.force,
      distillModel: args.distillModel,
      tracer,
      entry: "cli",
    });
  }

  // 验证输入
  if (!args.input) {
    printUsage();
    console.error("错误: 请提供输入内容（无参数运行 npm run phase8 进入交互模式）");
    process.exit(1);
  }

  // 确定会话 ID
  let threadId = args.threadId;
  if (!threadId) {
    const conversation = storage.createConversation();
    threadId = conversation.id;
  }

  /**
   * 构建 Agent 构造选项：注入工具 + onToolCall/onLlmCall（实时输出 + 落盘 + span）
   * 这是 Phase 6 的关键 —— 所有 Agent（路由 / Pattern）都通过此函数获得工具能力。
   */
  const makeAgentOptions = makeAgentOptionsFactory(storage, toolRegistry, sandbox, tracer);

  /** 构建 Agent（解析 allowedTools：CLI --tools 优先，否则 Agent 配置 tools，否则全部） */
  const buildAgent = buildAgentFactory(registry, storage, makeAgentOptions, args.tools);

  // ─── 分支 1：单 Agent 路由（无 --pattern）──────────────────────
  if (!args.patternName) {
    try {
      const userInput = args.input!; // 上面已验证非空
      // Phase 8：chat trace（一轮对话一 trace；route→agent→llm/tool span 树）
      const trace = tracer.startTrace("chat", {
        entry: "cli",
        threadId: threadId ?? undefined,
        title: userInput.slice(0, 200),
      });
      const result = await tracer.run(trace, () =>
        router.route(userInput, threadId ?? undefined, buildAgent)
      );

      printReply(result.agentId, result.content, result.a2aReplies);

      console.log(`\n会话 ID: ${result.threadId}`);
      printReceipt(storage, trace.id);
      console.log(`工具调用回放: npm run phase8 -- --thread=${result.threadId} --show-tools`);
      console.log(`记忆注入回放: npm run phase8 -- --thread=${result.threadId} --show-memory`);
      console.log(`继续此会话: npm run phase8 -- "继续" --thread=${result.threadId}\n`);
    } catch (error) {
      console.error("执行失败:", error);
      process.exit(1);
    }
    return;
  }

  // ─── 分支 2：Pattern 编排（有 --pattern）──────────────────────
  const config = buildPatternConfig(args.patternName, {
    noA2a: args.noA2a,
    agents: args.agents,
    aggregator: args.aggregator,
    rounds: args.rounds,
    manager: args.manager,
    workers: args.workers,
  });

  try {
    await runPattern({
      patternName: args.patternName,
      task: args.input,
      threadId: threadId!,
      config,
      registry,
      threads,
      storage,
      orchestrator,
      buildAgent,
      autoDistill: args.autoDistill,
      force: args.force,
      distillModel: args.distillModel,
      kb,
      tracer,
      entry: "cli",
    });
    process.exitCode = process.exitCode || 0;
  } catch (error) {
    console.error("执行失败:", error);
    process.exit(1);
  }
}

// 运行
main().catch((error) => {
  console.error("未处理的错误:", error);
  process.exit(1);
});
