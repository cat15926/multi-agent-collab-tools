/**
 * Phase 2 — CLI 入口（升级版）
 *
 * 用法：
 *   pnpm phase2 --agent=ji-tui "你好"
 *   pnpm phase2 --list                    # 列出所有可用 Agent
 *   pnpm phase2 --agent=ji-tui --reset   # 清空对话历史
 *
 * 相比 Phase 1 的变化：
 * - 支持从配置文件加载多个 Agent
 * - 对话历史持久化到 SQLite
 * - 支持会话重置和列表查询
 */

import { Agent } from "./agent.js";
import { listAgentIds, loadAgentConfig, type AgentConfig } from "./config.js";

/** 解析命令行参数 */
function parseArgs(): {
  agentId: string | null;
  input: string | null;
  list: boolean;
  reset: boolean;
} {
  const args = process.argv.slice(2);
  let agentId: string | null = null;
  let input: string | null = null;
  let list = false;
  let reset = false;

  for (const arg of args) {
    if (arg.startsWith("--agent=")) {
      agentId = arg.split("=")[1];
    } else if (arg === "--list" || arg === "-l") {
      list = true;
    } else if (arg === "--reset" || arg === "-r") {
      reset = true;
    } else if (!arg.startsWith("--")) {
      input = arg;
    }
  }

  return { agentId, input, list, reset };
}

/** 列出所有可用的 Agent */
function listAgents(): void {
  const ids = listAgentIds();

  if (ids.length === 0) {
    console.log("没有找到任何 Agent 配置文件。");
    console.log("请在 config/agents/ 目录下创建 .json 配置文件。");
    return;
  }

  console.log("\n可用的 Agent：\n");
  for (const id of ids) {
    try {
      const config = loadAgentConfig(id);
      console.log(`  ${config.emoji} ${config.name} (${id})`);
      console.log(`     模型: ${config.model}`);
      console.log(`     人格: ${config.persona.slice(0, 60)}...`);
      console.log();
    } catch (err) {
      console.log(`  ⚠️  ${id} (配置加载失败: ${err})`);
    }
  }
}

/** 打印用法 */
function printUsage(): void {
  console.log(`
用法:
  pnpm phase2 --agent=<id> "你的问题"    # 与指定 Agent 对话
  pnpm phase2 --list                    # 列出所有可用 Agent
  pnpm phase2 --agent=<id> --reset     # 清空指定 Agent 的对话历史

示例:
  pnpm phase2 --agent=ji-tui "你好"
  pnpm phase2 -l
  pnpm phase2 --agent=ji-tui --reset
`);
}

async function main() {
  const { agentId, input, list, reset } = parseArgs();

  // 列出所有 Agent
  if (list) {
    listAgents();
    return;
  }

  // 需要 agentId
  if (!agentId) {
    console.error("错误: 请指定 --agent=<id>");
    printUsage();
    process.exit(1);
  }

  // 创建 Agent
  const agent = new Agent({ configId: agentId });

  // 重置对话历史
  if (reset) {
    agent.clearHistory();
    console.log(`${agent.emoji} ${agent.name} 的对话历史已清空。`);
    agent.close();
    return;
  }

  // 需要输入
  if (!input) {
    console.error("错误: 请提供输入内容");
    printUsage();
    agent.close();
    process.exit(1);
  }

  // 流式打印回复
  process.stdout.write(`${agent.emoji}: `);
  try {
    for await (const chunk of agent.reply(input)) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n");
  } catch (err) {
    console.error("\n错误:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    agent.close();
  }
}

main().catch((err) => {
  console.error("\n出错了:", err instanceof Error ? err.message : err);
  process.exit(1);
});
