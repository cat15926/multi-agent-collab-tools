/**
 * Phase 4 — CLI 入口（A2A 版）
 *
 * 用法：
 *   pnpm phase4 --list                    # 列出所有可用 Agent
 *   pnpm phase4 "@alice 你好"             # 与 alice 对话
 *   pnpm phase4 "@alice @bob 讨论"         # A2A 协作
 *   pnpm phase4 --thread=xxx "继续"       # 指定会话继续
 *   pnpm phase4 --no-a2a "@alice 设计"     # 禁用 A2A
 *   pnpm phase4 --a2a-mode=confirm "@alice 设计"  # 确认模式
 *   pnpm phase4 --chain --thread=xxx      # 查看协作链
 *
 * 相比 Phase 3 的变化：
 * - 支持 A2A 协作
 * - 添加 --no-a2a 选项
 * - 添加 --a2a-mode 选项
 * - 添加 --chain 选项查看协作链
 */

import { AgentRegistry } from "./registry/agent-registry.js";
import { Router } from "./router/index.js";
import { ThreadManager } from "./thread/manager.js";
import { Storage } from "./storage/sqlite.js";
import { Agent } from "./agent/agent.js";
import { A2ADecider, type A2AConfig } from "./a2a/decider.js";

/** 命令行参数 */
interface CliArgs {
  input: string | null;
  list: boolean;
  threadId: string | null;
  showChain: boolean;
  noA2a: boolean;
  a2aMode: string | null;
}

/** 解析命令行参数 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let input: string | null = null;
  let list = false;
  let threadId: string | null = null;
  let showChain = false;
  let noA2a = false;
  let a2aMode: string | null = null;

  for (const arg of args) {
    if (arg === "--list" || arg === "-l") {
      list = true;
    } else if (arg === "--chain" || arg === "-c") {
      showChain = true;
    } else if (arg === "--no-a2a") {
      noA2a = true;
    } else if (arg.startsWith("--a2a-mode=")) {
      a2aMode = arg.split("=")[1];
    } else if (arg.startsWith("--thread=")) {
      threadId = arg.split("=")[1];
    } else if (!arg.startsWith("--")) {
      input = arg;
    }
  }

  return { input, list, threadId, showChain, noA2a, a2aMode };
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
  pnpm phase4 --list                    # 列出所有可用 Agent
  pnpm phase4 "@handle 你的问题"         # 与指定 Agent 对话
  pnpm phase4 --thread=<id> "继续"      # 指定会话继续对话
  pnpm phase4 "你好"                    # 使用默认 Agent
  pnpm phase4 --no-a2a "@alice 设计"    # 禁用 A2A 协作
  pnpm phase4 --a2a-mode=confirm "@alice 设计"  # 确认模式
  pnpm phase4 --chain --thread=<id>    # 查看协作链

示例:
  pnpm phase4 "@ji-tui 你好"
  pnpm phase4 "@bob 审查这段代码"
  pnpm phase4 "@ji-tui 设计登录页"      # ji-tui 可能会 @bob

提示:
  - 使用 @handle 指定 Agent
  - A2A 模式下 Agent 可以主动 @其他 Agent
  - 使用 --no-a2a 禁用协作
  - 使用 --chain 查看协作链
`);
}

async function main() {
  const { input, list, threadId, showChain, noA2a, a2aMode } = parseArgs();

  // 构建 A2A 配置
  const a2aConfig: A2AConfig = A2ADecider.fromArgs({
    noA2a,
    a2aMode: a2aMode || undefined,
  });

  // 初始化组件
  const storage = new Storage();
  const registry = new AgentRegistry();
  const threads = new ThreadManager(storage);
  const router = new Router(registry, threads, storage, { a2a: a2aConfig });

  // 列出所有 Agent
  if (list) {
    listAgents(registry);
    storage.close();
    return;
  }

  // 查看协作链
  if (showChain && threadId) {
    const chainHistory = router.formatA2AChainHistory(threadId);
    console.log(`\n协作链 (${threadId}):`);
    console.log(chainHistory);
    storage.close();
    return;
  }

  // 需要输入
  if (!input) {
    console.error("错误: 请提供输入内容");
    printUsage();
    storage.close();
    process.exit(1);
  }

  // 路由并获取回复
  try {
    const result = await router.route(input, threadId ?? undefined, (agentId) => {
      const config = registry.get(agentId);
      if (!config) {
        throw new Error(`Agent ${agentId} 不存在`);
      }
      return new Agent(config);
    });

    // 输出回复
    const agentConfig = registry.get(result.agentId);
    const emoji = agentConfig?.emoji ?? "🤖";
    const name = agentConfig?.name ?? result.agentId;

    console.log(`\n${emoji} ${name}:`);
    console.log(result.content);
    console.log(`\n(会话: ${result.threadId})`);

    if (!result.hasMention) {
      console.log("(使用默认 Agent)");
    }

    // 显示 A2A 信息
    if (result.a2aTriggered && result.a2aChains && result.a2aChains.length > 0) {
      console.log("\n🔄 A2A 协作:");
      for (const chain of result.a2aChains) {
        const source = registry.get(chain.sourceAgentId);
        const target = registry.get(chain.targetAgentId);
        const sourceName = source ? source.name : chain.sourceAgentId;
        const targetName = target ? target.name : chain.targetAgentId;
        console.log(`  • ${sourceName} → ${targetName}`);
      }
    }

    // 显示 A2A 模式
    if (a2aConfig.mode !== "disabled") {
      console.log(`(A2A 模式: ${a2aConfig.mode})`);
    }
  } catch (err) {
    console.error("\n错误:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error("\n出错了:", err instanceof Error ? err.message : err);
  process.exit(1);
});
