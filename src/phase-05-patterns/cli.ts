/**
 * Phase 5 — CLI 入口（Pattern 版）
 *
 * 用法：
 *   pnpm phase5 --list-patterns           # 列出所有可用的 Pattern
 *   pnpm phase5 --list-agents            # 列出所有可用的 Agent
 *   pnpm phase5 "@alice 任务" --pattern=pipeline --agents=alice,bob
 *   pnpm phase5 "任务" --pattern=parallel --agents=alice,bob,carol --aggregator=dave
 *   pnpm phase5 "任务" --pattern=debate --agents=alice,bob --rounds=3
 *   pnpm phase5 "任务" --pattern=hierarchy --manager=alice --workers=bob,carol
 *   pnpm phase5 --thread=xxx --show-workflow    # 查看工作流执行详情
 *
 * 相比 Phase 4 的变化：
 * - 支持 --pattern 指定协作模式
 * - 支持 --agents, --aggregator, --rounds, --manager, --workers 等 Pattern 特定参数
 * - 支持 --show-workflow 查看执行详情
 * - 兼容 Phase 4 的 A2A 模式（--a2a-mode, --no-a2a）
 */

import { AgentRegistry } from "./registry/agent-registry.js";
import { Router } from "./router/index.js";
import { ThreadManager } from "./thread/manager.js";
import { Storage } from "./storage/sqlite.js";
import { Agent } from "./agent/agent.js";
import { Orchestrator } from "./orchestrator/index.js";
import { globalPatternRegistry, type PatternConfig } from "./pattern/registry.js";
import { PipelinePattern } from "./patterns/pipeline.js";
import { ParallelPattern } from "./patterns/parallel.js";
import { DebatePattern } from "./patterns/debate.js";
import { HierarchyPattern } from "./patterns/hierarchy.js";

/** 命令行参数 */
interface CliArgs {
  input: string | null;
  listPatterns: boolean;
  listAgents: boolean;
  threadId: string | null;
  showWorkflow: boolean;
  patternName: string | null;
  agents: string[];
  aggregator: string | null;
  rounds: number | null;
  manager: string | null;
  workers: string[];
  noA2a: boolean;
  a2aMode: string | null;
}

/** 解析命令行参数 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let input: string | null = null;
  let listPatterns = false;
  let listAgents = false;
  let threadId: string | null = null;
  let showWorkflow = false;
  let patternName: string | null = null;
  let agents: string[] = [];
  let aggregator: string | null = null;
  let rounds: number | null = null;
  let manager: string | null = null;
  let workers: string[] = [];
  let noA2a = false;
  let a2aMode: string | null = null;

  for (const arg of args) {
    if (arg === "--list-patterns" || arg === "-lp") {
      listPatterns = true;
    } else if (arg === "--list-agents" || arg === "-la" || arg === "--list" || arg === "-l") {
      listAgents = true;
    } else if (arg === "--show-workflow" || arg === "-sw") {
      showWorkflow = true;
    } else if (arg === "--no-a2a") {
      noA2a = true;
    } else if (arg.startsWith("--pattern=")) {
      patternName = arg.split("=")[1];
    } else if (arg.startsWith("--agents=")) {
      agents = arg.split("=")[1].split(",");
    } else if (arg.startsWith("--aggregator=")) {
      aggregator = arg.split("=")[1];
    } else if (arg.startsWith("--rounds=")) {
      rounds = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--manager=")) {
      manager = arg.split("=")[1];
    } else if (arg.startsWith("--workers=")) {
      workers = arg.split("=")[1].split(",");
    } else if (arg.startsWith("--a2a-mode=")) {
      a2aMode = arg.split("=")[1];
    } else if (arg.startsWith("--thread=")) {
      threadId = arg.split("=")[1];
    } else if (!arg.startsWith("--")) {
      input = arg;
    }
  }

  return {
    input,
    listPatterns,
    listAgents,
    threadId,
    showWorkflow,
    patternName,
    agents,
    aggregator,
    rounds,
    manager,
    workers,
    noA2a,
    a2aMode,
  };
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
    console.log("请在 config/agents/ 目录下创建 .json 配置文件。");
    return;
  }

  console.log("\n可用的 Agent：\n");
  for (const agent of agents) {
    const isDefault = agent.id === registry.getDefaultAgentId() ? " (默认)" : "";
    console.log(`  ${agent.emoji} ${agent.name} (${agent.id})${isDefault}`);
    console.log(`     模型: ${agent.model}`);
    console.log(`     人格: ${agent.persona.slice(0, 60)}...`);
    console.log();
  }
}

/** 打印用法 */
function printUsage(): void {
  console.log(`
用法:
  pnpm phase5 --list-patterns                    # 列出所有可用的 Pattern
  pnpm phase5 --list-agents                     # 列出所有可用的 Agent
  pnpm phase5 "@handle 任务" --pattern=NAME     # 使用指定 Pattern 执行任务
  pnpm phase5 --thread=<id> "继续"              # 指定会话继续对话
  pnpm phase5 --thread=xxx --show-workflow      # 查看工作流执行详情

Pattern 参数:
  --pattern=NAME          指定协作模式 (pipeline, parallel, debate, hierarchy)
  --agents=A,B,C          指定参与 Agent
  --aggregator=ID         指定聚合器 Agent (parallel 模式)
  --rounds=N              辩论轮数 (debate 模式，默认 3)
  --manager=ID            指定管理者 Agent (hierarchy 模式)
  --workers=A,B           指定工作者 Agent (hierarchy 模式)

A2A 参数（兼容 Phase 4）:
  --no-a2a                禁用 A2A 协作
  --a2a-mode=MODE         A2A 模式 (auto, confirm, disabled)

示例:
  # Pipeline 模式：顺序执行
  pnpm phase5 "@alice 写个登录函数" --pattern=pipeline --agents=alice,bob,carol

  # Parallel 模式：并行 + 聚合
  pnpm phase5 "设计登录页" --pattern=parallel --agents=alice,bob,carol --aggregator=dave

  # Debate 模式：辩论
  pnpm phase5 "这个方案是否可行" --pattern=debate --agents=alice,bob --rounds=3

  # Hierarchy 模式：层级分工
  pnpm phase5 "实现用户系统" --pattern=hierarchy --manager=alice --workers=bob,carol

  # 查看工作流详情
  pnpm phase5 --thread=xxx --show-workflow
`);
}

/** 显示工作流执行详情 */
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

    // 显示步骤
    const steps = storage.getWorkflowSteps(execution.id);
    if (steps.length > 0) {
      console.log(`  执行步骤:`);
      for (const step of steps) {
        const status = step.success ? "✓" : "✗";
        console.log(`    ${status} Step ${step.stepNumber}: ${step.agentId} (${step.duration}ms)`);
        if (!step.success && step.error) {
          console.log(`       错误: ${step.error}`);
        }
      }
    }

    if (execution.error) {
      console.log(`  错误: ${execution.error}`);
    }

    console.log();
  }
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

  // 处理 --list-patterns
  if (args.listPatterns) {
    listPatterns();
    return;
  }

  // 处理 --list-agents
  if (args.listAgents) {
    listAgents(registry);
    return;
  }

  // 处理 --show-workflow
  if (args.showWorkflow && args.threadId) {
    showWorkflowDetails(storage, args.threadId);
    return;
  }

  // 验证输入
  if (!args.input) {
    printUsage();
    console.error("错误: 请提供输入内容");
    process.exit(1);
  }

  // 验证 Pattern
  if (!args.patternName) {
    printUsage();
    console.error("错误: 请指定 --pattern 参数");
    process.exit(1);
  }

  const pattern = globalPatternRegistry.get(args.patternName);
  if (!pattern) {
    console.error(`错误: Pattern "${args.patternName}" 不存在`);
    console.error("运行 --list-patterns 查看可用的 Pattern");
    process.exit(1);
  }

  // 构建 Pattern 配置
  const config: PatternConfig = {
    patternName: args.patternName,
    a2aEnabled: !args.noA2a,
  };

  // Pattern 特定配置
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

  // 确定会话 ID
  let threadId = args.threadId;
  if (!threadId) {
    const conversation = storage.createConversation();
    threadId = conversation.id;
  }

  // 获取参与 Agent
  const agentIds = args.patternName === "hierarchy"
    ? [args.manager!, ...args.workers]
    : args.patternName === "parallel"
    ? [...args.agents, args.aggregator!]
    : args.agents.length > 0
    ? args.agents
    : [registry.getDefaultAgentId() || "ji-tui"];

  const agents: Agent[] = [];
  for (const agentId of agentIds) {
    const agentConfig = registry.get(agentId);
    if (!agentConfig) {
      console.error(`错误: 找不到 Agent "${agentId}"`);
      process.exit(1);
    }

    storage.upsertAgent(agentConfig);
    threads.addParticipant(threadId, agentId);

    agents.push(new Agent(agentConfig));
  }

  // 存储用户消息
  storage.addMessage({
    conversationId: threadId,
    role: "user",
    content: args.input,
  });

  console.log(`\n使用 ${pattern.name} 模式执行任务...`);
  console.log(`会话 ID: ${threadId}`);
  console.log(`参与 Agent: ${agentIds.join(", ")}\n`);

  try {
    // 执行 Pattern
    const result = await orchestrator.executePattern({
      patternName: args.patternName,
      task: args.input,
      agents,
      threadId,
      config,
    });

    // 存储最终输出
    storage.addMessage({
      conversationId: threadId,
      role: "assistant",
      content: result.finalOutput,
      agentId: agentIds[agentIds.length - 1], // 最后一个 Agent
    });

    // 显示结果
    console.log(`\n${"=".repeat(60)}`);
    console.log(`执行结果: ${result.success ? "成功" : "失败"}`);
    console.log(`执行步骤: ${result.steps.length}`);
    console.log(`总耗时: ${result.metadata.duration}ms`);
    console.log(`${"=".repeat(60)}\n`);

    for (const step of result.steps) {
      const status = step.success ? "✓" : "✗";
      console.log(`${status} Step ${step.stepNumber}: ${step.agentId} (${step.duration}ms)`);
      if (step.success) {
        console.log(`\n${step.output}\n`);
      } else {
        console.log(`  错误: ${step.error}\n`);
      }
    }

    if (!result.success) {
      console.error(`执行失败: ${result.failureReason}`);
    }

    console.log(`\n使用以下命令继续此会话:`);
    console.log(`  pnpm phase5 "继续" --thread=${threadId} --pattern=${args.patternName}\n`);
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
