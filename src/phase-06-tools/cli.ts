/**
 * Phase 6 — CLI 入口（Tool Use 版）
 *
 * 在 Phase 5 基础上给 Agent 装上"手"（工具）。两条路径都能用工具：
 *   - 单 Agent 路由（无 --pattern）：@agent 读文件 / 跑命令 / 多步工具链
 *   - Pattern 编排（有 --pattern）：pipeline/parallel/debate/hierarchy，每步 Agent 各自调工具
 *
 * 用法：
 *   pnpm phase6 --list-tools                               # 列出工具
 *   pnpm phase6 --list-agents                              # 列出 Agent
 *   pnpm phase6 --list-patterns                            # 列出 Pattern
 *   pnpm phase6 "@agent 读 package.json，总结依赖"           # 单 Agent + 工具
 *   pnpm phase6 "@agent ..." --tools=read_file,list_files  # 限定工具
 *   pnpm phase6 "@agent 创建 hello.txt" --allow-write      # 允许写文件
 *   pnpm phase6 "@agent 跑 git log" --allow-exec           # 允许非白名单命令
 *   pnpm phase6 "@agent ..." --workdir=PATH                # 指定沙箱根（默认 cwd）
 *   pnpm phase6 "@a,@b 任务" --pattern=pipeline --agents=a,b  # Pattern + 工具（正交）
 *   pnpm phase6 --thread=xxx --show-tools                  # 工具调用回放
 *   pnpm phase6 --thread=xxx --show-workflow               # Pattern 执行回放（Phase 5）
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
import { ToolRegistry, Sandbox, createBuiltinTools } from "./tools/index.js";

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
  };

  for (const arg of args) {
    if (arg === "--list-tools" || arg === "-lt") r.listTools = true;
    else if (arg === "--list-patterns" || arg === "-lp") r.listPatterns = true;
    else if (arg === "--list-agents" || arg === "-la" || arg === "--list" || arg === "-l")
      r.listAgents = true;
    else if (arg === "--show-workflow" || arg === "-sw") r.showWorkflow = true;
    else if (arg === "--show-tools" || arg === "-st") r.showTools = true;
    else if (arg === "--no-a2a") r.noA2a = true;
    else if (arg === "--allow-write") r.allowWrite = true;
    else if (arg === "--allow-exec") r.allowExec = true;
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
    else if (!arg.startsWith("--")) r.input = arg;
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

/** 显示工作流执行详情（--show-workflow，Phase 5） */
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
  pnpm phase6 "@agent 任务"                      # 单 Agent + 工具（默认）
  pnpm phase6 "任务" --pattern=NAME --agents=A,B  # Pattern 编排 + 工具
  pnpm phase6 --list-tools                        # 列出工具
  pnpm phase6 --thread=<id> --show-tools          # 工具调用回放

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
  # 读文件
  pnpm phase6 "@agent 读 package.json，总结依赖"

  # 多步工具链
  pnpm phase6 "@agent src 下哪些文件定义了 reply 函数？"

  # 写文件（需授权）
  pnpm phase6 "@agent 创建 hello.txt 写入 hi" --allow-write

  # 危险命令被拦
  pnpm phase6 "@agent 执行 rm -rf /tmp/x"

  # Pattern + 工具（正交）
  pnpm phase6 "@a,@b 总结项目" --pattern=pipeline --agents=a,b
`);
}

/** 主函数 */
async function main() {
  const args = parseArgs();

  // 初始化组件
  const storage = new Storage();
  const registry = new AgentRegistry();
  const threads = new ThreadManager(storage);
  const router = new Router(registry, threads, storage);
  const orchestrator = new Orchestrator(storage);

  // 注册所有 Pattern
  globalPatternRegistry.register(new PipelinePattern());
  globalPatternRegistry.register(new ParallelPattern());
  globalPatternRegistry.register(new DebatePattern());
  globalPatternRegistry.register(new HierarchyPattern());

  // 构建工具：沙箱 + 注册表（注册全部内置工具）
  const workDir = resolve(args.workdir ?? process.cwd());
  const sandbox = new Sandbox({
    workDir,
    allowWrite: args.allowWrite,
    allowExec: args.allowExec,
  });
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerAll(createBuiltinTools(sandbox));

  // 处理 --list-* 命令
  if (args.listTools) return listTools(toolRegistry);
  if (args.listPatterns) return listPatterns();
  if (args.listAgents) return listAgents(registry);

  // 处理 --show-* 命令
  if (args.showTools && args.threadId) return showToolCalls(storage, args.threadId);
  if (args.showWorkflow && args.threadId) return showWorkflowDetails(storage, args.threadId);

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
      console.log(`工具调用回放: pnpm phase6 --thread=${result.threadId} --show-tools`);
      console.log(`继续此会话: pnpm phase6 "继续" --thread=${result.threadId}\n`);
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

    console.log(`工具调用回放: pnpm phase6 --thread=${threadId} --show-tools`);
    console.log(`继续此会话: pnpm phase6 "继续" --thread=${threadId} --pattern=${args.patternName}\n`);
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
