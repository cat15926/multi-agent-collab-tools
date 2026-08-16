/**
 * Phase 7 — CLI 入口（Shared Memory / KnowledgeBase 版）
 *
 * 在 Phase 6 基础上给 Agent 装上"长期共享记忆"。三条能力线：
 *   - 注入（push）：Router/Orchestrator 每轮检索知识库，注入 system prompt（--no-memory 关闭）
 *   - 检索（pull）：kb_search / kb_write 工具，Agent 对话中自主查/写（写受 --allow-kb-write 门控）
 *   - 提炼（distill）：--kb-distill / --auto-distill 从会话+workflow 记录提炼知识入库
 *
 * 用法（Phase 6 全部用法不变）：
 *   npm run phase7 -- --kb-add="经验内容" --type=lesson --title=标题 --keywords=a,b
 *   npm run phase7 -- --kb-search="检索词"                # 评分检索（带 score）
 *   npm run phase7 -- --kb-list / --kb-stats              # 治理
 *   npm run phase7 -- --kb-del=<id> / --kb-verify=<id>
 *   npm run phase7 -- --kb-distill --thread=xxx [--force] # 手动提炼
 *   npm run phase7 -- "任务" --pattern=pipeline --agents=a,b --auto-distill
 *   npm run phase7 -- "@agent ..." --no-memory            # 本轮零注入
 *   npm run phase7 -- --thread=xxx --show-memory          # 记忆注入回放
 *   npm run phase7 -- "@agent ..." --allow-kb-write       # 开 kb_write
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

/** 全局 KB 引用（runDistill 用；main 里赋值） */
let globalKb: KnowledgeBase | undefined;

/** 命令行参数 */
interface CliArgs {
  input: string | null;
  listTools: boolean;
  listPatterns: boolean;
  listAgents: boolean;
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
}

/** 解析命令行参数 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const r: CliArgs = {
    input: null,
    listTools: false,
    listPatterns: false,
    listAgents: false,
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
  };

  for (const arg of args) {
    if (arg === "--list-tools" || arg === "-lt") r.listTools = true;
    else if (arg === "--list-patterns" || arg === "-lp") r.listPatterns = true;
    else if (arg === "--list-agents" || arg === "-la" || arg === "--list" || arg === "-l")
      r.listAgents = true;
    else if (arg === "--show-workflow" || arg === "-sw") r.showWorkflow = true;
    else if (arg === "--show-tools" || arg === "-st") r.showTools = true;
    else if (arg === "--show-memory" || arg === "-sm") r.showMemory = true;
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
    else if (arg.startsWith("--")) console.warn(`⚠️  未识别的参数 "${arg}"（已忽略）`);
    else r.input = arg;
  }

  return r;
}

/** 列出所有工具 */
function listTools(registry: ToolRegistry): void {
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
function listPatterns(): void {
  const patterns = globalPatternRegistry.listAll();
  console.log("\n可用的协作模式 (Pattern)：\n");
  for (const pattern of patterns) {
    console.log(`  ${pattern.name}`);
    console.log(`     描述: ${pattern.description}`);
    console.log();
  }
}

/** 列出所有 Agent */
function listAgents(registry: AgentRegistry): void {
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

/** 显示工具调用记录（--show-tools） */
function showToolCalls(storage: Storage, threadId: string): void {
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
function showMemoryReads(storage: Storage, kb: KnowledgeBase, threadId: string): void {
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

/** 组装提炼输入：会话消息 + workflow 步骤（中间步产出是教训主矿藏） */
function buildDistillTranscript(storage: Storage, threadId: string): { transcript: string; task?: string } {
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

/** 执行提炼（--kb-distill / --auto-distill 共用）：scope 级幂等 + 失败显形落库 */
async function runDistill(
  storage: Storage,
  threadId: string,
  opts: { force?: boolean; distillModel?: string | null }
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
    globalKb!
  );

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
}

/** 工作流执行详情（--show-workflow，Phase 5） */
function showWorkflowDetails(storage: Storage, threadId: string): void {

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

/** 打印用法 */
function printUsage(): void {
  console.log(`
用法:
  npm run phase7 -- "@agent 任务"                      # 单 Agent + 工具 + 记忆注入（默认）
  npm run phase7 -- "任务" --pattern=NAME --agents=A,B  # Pattern 编排 + 记忆注入
  npm run phase7 -- --list-tools                        # 列出工具
  npm run phase7 -- --thread=<id> --show-tools          # 工具调用回放
  npm run phase7 -- --thread=<id> --show-memory         # 记忆注入回放（Phase 7）

知识库参数（Phase 7）:
  --kb-add="内容" --type=T --title=标题 [--keywords=a,b] [--thread=] [--agent=]
                       手动添加（type: decision|lesson|observation|outcome）
  --kb-search="词"     评分检索（[--type=] [--limit=N]）
  --kb-list [--type=T] [--limit=N] / --kb-stats / --kb-del=<id> / --kb-verify=<id>
  --kb-distill --thread=<id> [--force] [--distill-model=M]   从会话提炼知识
  --auto-distill       Pattern 成功后自动提炼
  --no-memory          本轮零查询零注入
  --allow-kb-write     开启 kb_write 工具（Agent 可写知识库）

工具参数:
  --tools=A,B,C        限定可用工具（覆盖 Agent 配置）
  --workdir=PATH       沙箱工作目录（默认当前目录）
  --allow-write        允许写文件（write_file）
  --allow-exec         允许执行非白名单命令（危险命令仍被拦）

Pattern 参数（可选，与工具正交）:
  --pattern=NAME       pipeline / parallel / debate / hierarchy
  --agents=A,B,C       参与 Agent
  --aggregator=ID      聚合器（parallel）
  --rounds=N           辩论轮数（debate，默认 3）
  --manager=ID         管理者（hierarchy）
  --workers=A,B        工作者（hierarchy）

示例:
  # 手动沉淀经验 + 下次注入
  npm run phase7 -- --kb-add="时间戳必须毫秒显式插入" --type=lesson --title="时间戳单位" --keywords=时间戳,毫秒
  npm run phase7 -- "@bob 怎么处理时间戳存储？"

  # Pattern + 自动提炼 + 幂等
  npm run phase7 -- "设计配置模块" --pattern=pipeline --agents=bob,ji-tui --auto-distill
  npm run phase7 -- --kb-distill --thread=<id>          # → 已提炼过，跳过
`);
}

/** 主函数 */
async function main() {
  const args = parseArgs();

  // 初始化组件
  const storage = new Storage();
  const registry = new AgentRegistry();
  const threads = new ThreadManager(storage);

  // Phase 7：知识库（--no-memory 时为 undefined → 全程零查询零注入零落盘）
  const kb = args.noMemory ? undefined : new KnowledgeBase(storage);
  globalKb = kb;

  const router = new Router(registry, threads, storage, { kb });
  const orchestrator = new Orchestrator(storage, { kb });

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

  // ─── Phase 7：知识库管理子命令（不进入对话/pattern 流程）──────────
  if (args.kbAdd !== null) {
    const type = args.kbType as EvidenceType;
    if (!EVIDENCE_TYPES.includes(type)) {
      console.error(`错误: --type 必须是 ${EVIDENCE_TYPES.join(" | ")}（当前: ${args.kbType ?? "未提供"}）`);
      process.exit(1);
    }
    const entry = kb!.add({
      type,
      title: args.kbTitle ?? args.kbAdd.slice(0, 20),
      content: args.kbAdd,
      keywords: args.kbKeywords,
      sourceThread: args.threadId ?? undefined,
      sourceAgent: args.kbAgent ?? "user",
      verified: true, // 人工添加 = 已验证
    });
    console.log(`✓ 已添加 [${entry.type}] ${entry.title}（id: ${entry.id}）`);
    return;
  }

  if (args.kbSearch !== null) {
    const hits = kb!.search(args.kbSearch, {
      limit: args.kbLimit ?? 10,
      type: (args.kbType as EvidenceType) ?? undefined,
    });
    if (hits.length === 0) {
      console.log(`未找到与 "${args.kbSearch}" 相关的条目。`);
    } else {
      console.log(`\n检索 "${args.kbSearch}" 命中 ${hits.length} 条：\n`);
      for (const h of hits) {
        const mark = h.entry.verified ? " ✓" : "";
        console.log(`  [${h.entry.type}] ${h.entry.title}${mark}（score ${h.score}）`);
        console.log(`    ${h.entry.content.slice(0, 100)}`);
        console.log(`    来源: ${h.entry.sourceThread ?? "手动"} · ${h.entry.sourceAgent ?? "-"} · ${new Date(h.entry.timestamp).toLocaleString()}`);
        console.log();
      }
    }
    return;
  }

  if (args.kbList) {
    const entries = kb!.list({
      type: (args.kbType as EvidenceType) ?? undefined,
      limit: args.kbLimit ?? 20,
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
    return;
  }

  if (args.kbDel !== null) {
    const ok = kb!.remove(args.kbDel);
    console.log(ok ? `✓ 已删除 ${args.kbDel}` : `未找到 ${args.kbDel}`);
    return;
  }

  if (args.kbVerify !== null) {
    const ok = storage.setKbEntryVerified(args.kbVerify, true);
    console.log(ok ? `✓ 已背书 ${args.kbVerify}` : `未找到 ${args.kbVerify}`);
    return;
  }

  if (args.kbStats) {
    const s = kb!.stats();
    console.log(`\n知识库统计：`);
    console.log(`  总条目: ${s.total}`);
    for (const [t, n] of Object.entries(s.byType)) {
      console.log(`    ${t}: ${n}`);
    }
    console.log(`  来源线程: ${s.threads}`);
    console.log(`  已背书: ${s.verified}`);
    if (s.lastAddedAt) console.log(`  最近添加: ${new Date(s.lastAddedAt).toLocaleString()}`);
    return;
  }

  // 处理 --list-* 命令
  if (args.listTools) return listTools(toolRegistry);
  if (args.listPatterns) return listPatterns();
  if (args.listAgents) return listAgents(registry);

  // 处理 --show-* 命令
  if (args.showTools && args.threadId) return showToolCalls(storage, args.threadId);
  if (args.showWorkflow && args.threadId) return showWorkflowDetails(storage, args.threadId);
  if (args.showMemory && args.threadId) return showMemoryReads(storage, kb ?? new KnowledgeBase(storage), args.threadId);

  // 提炼命令（--kb-distill --thread=X）
  if (args.kbDistill) {
    if (!args.threadId) {
      console.error("错误: --kb-distill 需要 --thread=<id>");
      process.exit(1);
    }
    return runDistill(storage, args.threadId, {
      force: args.force,
      distillModel: args.distillModel,
    });
  }

  // 验证输入
  if (!args.input) {
    printUsage();
    console.error("错误: 请提供输入内容");
    process.exit(1);
  }

  // 确定会话 ID
  let threadId = args.threadId;
  if (!threadId) {
    const conversation = storage.createConversation();
    threadId = conversation.id;
  }

  /**
   * 构建 Agent 构造选项：注入工具 + onToolCall（实时输出 + 落盘）
   * 这是 Phase 6 的关键 —— 所有 Agent（路由 / Pattern）都通过此函数获得工具能力。
   */
  const makeAgentOptions = (): AgentOptions => {
    return {
      toolRegistry,
      sandbox,
      onToolCall: (info) => {
        const icon =
          info.status === "ok" ? "🔧" : info.status === "blocked" ? "🚫" : "⚠️";
        const inputStr = JSON.stringify(info.input);
        const inputPreview =
          inputStr.length > 80 ? inputStr.slice(0, 80) + "..." : inputStr;
        console.log(`${icon} ${info.toolName}(${inputPreview})`);
        console.log(`   → ${info.status} · ${info.duration}ms`);

        // 落盘（失败不阻塞主流程）
        try {
          storage.addToolCall({
            threadId: info.threadId,
            agentId: info.agentId,
            toolName: info.toolName,
            input: inputStr,
            output: info.result.content.slice(0, 2000),
            status: info.status,
            durationMs: info.duration,
          });
        } catch {
          /* 落盘失败忽略 */
        }
      },
    };
  };

  /** 构建 Agent（解析 allowedTools：CLI --tools 优先，否则 Agent 配置 tools，否则全部） */
  const buildAgent = (agentId: string): Agent => {
    const cfg = registry.get(agentId);
    if (!cfg) {
      console.error(`错误: 找不到 Agent "${agentId}"`);
      process.exit(1);
    }
    storage.upsertAgent(cfg);
    const opts = makeAgentOptions();
    opts.allowedTools = args.tools.length > 0 ? args.tools : (cfg.tools ?? undefined);
    return new Agent(cfg, opts);
  };

  // ─── 分支 1：单 Agent 路由（无 --pattern）──────────────────────
  if (!args.patternName) {
    try {
      const result = await router.route(args.input, threadId ?? undefined, buildAgent);

      console.log(`\n${"─".repeat(60)}`);
      console.log(`@${result.agentId}:`);
      console.log(`${"─".repeat(60)}`);
      console.log(result.content);

      // A2A 协作回复
      if (result.a2aTriggered && result.a2aReplies && result.a2aReplies.length > 0) {
        for (const reply of result.a2aReplies) {
          console.log(`\n${"─".repeat(60)}`);
          console.log(`@${reply.agentId} (A2A):`);
          console.log(`${"─".repeat(60)}`);
          console.log(reply.content);
        }
      }

      console.log(`\n会话 ID: ${result.threadId}`);
      console.log(`工具调用回放: npm run phase7 -- --thread=${result.threadId} --show-tools`);
      console.log(`记忆注入回放: npm run phase7 -- --thread=${result.threadId} --show-memory`);
      console.log(`继续此会话: npm run phase7 -- "继续" --thread=${result.threadId}\n`);
    } catch (error) {
      console.error("执行失败:", error);
      process.exit(1);
    }
    return;
  }

  // ─── 分支 2：Pattern 编排（有 --pattern）──────────────────────
  const pattern = globalPatternRegistry.get(args.patternName);
  if (!pattern) {
    console.error(`错误: Pattern "${args.patternName}" 不存在`);
    console.error("运行 --list-patterns 查看可用的 Pattern");
    process.exit(1);
  }

  const config: PatternConfig = {
    patternName: args.patternName,
    a2aEnabled: !args.noA2a,
  };

  if (args.patternName === "parallel") {
    if (!args.aggregator) {
      console.error("错误: parallel 模式需要指定 --aggregator");
      process.exit(1);
    }
    config.aggregator = args.aggregator;
  }
  if (args.patternName === "debate") {
    if (args.agents.length !== 2) {
      console.error("错误: debate 模式需要恰好 2 个 Agent");
      process.exit(1);
    }
    config.agentA = args.agents[0];
    config.agentB = args.agents[1];
    config.maxRounds = args.rounds || 3;
  }
  if (args.patternName === "hierarchy") {
    if (!args.manager) {
      console.error("错误: hierarchy 模式需要指定 --manager");
      process.exit(1);
    }
    if (args.workers.length === 0) {
      console.error("错误: hierarchy 模式需要指定 --workers");
      process.exit(1);
    }
    config.manager = args.manager;
    config.workers = args.workers;
  }

  // 确定参与 Agent
  const agentIds =
    args.patternName === "hierarchy"
      ? [args.manager!, ...args.workers]
      : args.patternName === "parallel"
      ? [...args.agents, args.aggregator!]
      : args.agents.length > 0
      ? args.agents
      : [registry.getDefaultAgentId() || "ji-tui"];

  const agents = agentIds.map((id) => {
    threads.addParticipant(threadId!, id);
    return buildAgent(id);
  });

  // 存储用户消息
  storage.addMessage({
    conversationId: threadId,
    role: "user",
    content: args.input,
  });

  console.log(`\n使用 ${pattern.name} 模式执行任务...`);
  console.log(`会话 ID: ${threadId}`);
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

  try {
    const result = await orchestrator.executePattern({
      patternName: args.patternName,
      task: args.input,
      agents,
      threadId,
      config,
      events,
    });

    storage.addMessage({
      conversationId: threadId,
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

    // Phase 7：--auto-distill（pattern 成功后提炼；编排器本身零 LLM 直接调用）
    if (args.autoDistill && result.success && kb) {
      console.log();
      await runDistill(storage, threadId, {
        force: args.force,
        distillModel: args.distillModel,
      });
    }

    console.log(`工具调用回放: npm run phase7 -- --thread=${threadId} --show-tools`);
    console.log(`记忆注入回放: npm run phase7 -- --thread=${threadId} --show-memory`);
    console.log(`继续此会话: npm run phase7 -- "继续" --thread=${threadId} --pattern=${args.patternName}\n`);
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
