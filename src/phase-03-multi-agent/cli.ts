/**
 * Phase 3 — CLI 入口（多 Agent 版）
 *
 * 用法：
 *   pnpm phase3 --list                    # 列出所有可用 Agent
 *   pnpm phase3 "@alice 你好"             # 与 alice 对话
 *   pnpm phase3 "@bob 自我介绍"          # 与 bob 对话
 *   pnpm phase3 --thread=xxx "继续"       # 指定会话
 *   pnpm phase3 "你好"                    # 使用默认 Agent
 *
 * 相比 Phase 2 的变化：
 * - 支持 @mention 路由
 * - 支持多 Agent 同时存在
 * - 支持会话隔离（--thread=）
 * - 移除 --reset（改用 --list 管理会话）
 */

import { AgentRegistry } from "./registry/agent-registry.js";
import { Router } from "./router/index.js";
import { ThreadManager } from "./thread/manager.js";
import { Storage } from "./storage/sqlite.js";
import { Agent } from "./agent/agent.js";

/** 命令行参数 */
interface CliArgs {
  input: string | null;
  list: boolean;
  threadId: string | null;
}

/** 解析命令行参数 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let input: string | null = null;
  let list = false;
  let threadId: string | null = null;

  for (const arg of args) {
    if (arg === "--list" || arg === "-l") {
      list = true;
    } else if (arg.startsWith("--thread=")) {
      threadId = arg.split("=")[1];
    } else if (!arg.startsWith("--")) {
      input = arg;
    }
  }

  return { input, list, threadId };
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
  pnpm phase3 --list                    # 列出所有可用 Agent
  pnpm phase3 "@handle 你的问题"         # 与指定 Agent 对话
  pnpm phase3 --thread=<id> "继续"      # 指定会话继续对话
  pnpm phase3 "你好"                    # 使用默认 Agent

示例:
  pnpm phase3 "@alice 你好"
  pnpm phase3 "@bob 自我介绍一下"
  pnpm phase3 --thread=thread-xxx "继续上次的话题"

提示:
  - 使用 @handle 指定 Agent
  - 会话自动隔离，每个会话独立历史
  - 不指定 @handle 时使用默认 Agent
`);
}

async function main() {
  const { input, list, threadId } = parseArgs();

  // 初始化组件
  const storage = new Storage();
  const registry = new AgentRegistry();
  const threads = new ThreadManager(storage);
  const router = new Router(registry, threads, storage);

  // 列出所有 Agent
  if (list) {
    listAgents(registry);
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
