/**
 * Phase 8 — REPL 交互模式
 *
 * `npm run phase8`（无参数）进入。解决 one-shot 的最大摩擦：
 *   - 连续对话不重启进程，thread 常驻（首条消息时才创建，空退不留脏会话）
 *   - 斜杠命令就地完成知识库/会话/开关操作，不用退出再拼 flag
 *
 * 设计：
 *   - 裸文本 → Router 路由对话（@bob 指定 Agent，与 one-shot 分支 1 同路径）
 *   - /pattern → 一次性 Pattern 编排（不驻留模式状态机，见 ADR-012）
 *   - /memory、/kbwrite → 运行时开关（Runtime.rebuild() 重建 Router/工具表）
 *   - LLM 报错 catch 打印后继续循环（REPL 不因单轮失败退出）；EOF/Ctrl-D 优雅退出
 *   - Phase 8：每轮包 chat trace（entry=repl，ALS 串行队列天然隔离轮次）；
 *     /trace /stats 就地回放轨迹与计费
 */

import * as readline from "readline/promises";
import { Runtime } from "./runtime.js";
import { Agent } from "./agent/agent.js";
import type { EvidenceType } from "./knowledge/types.js";
import {
  opKbAdd,
  opKbSearch,
  opKbList,
  opKbDel,
  opKbVerify,
  opKbStats,
  opTraceList,
  opTraceShow,
  opStats,
  printReply,
  printReceipt,
  printThreads,
  resolveThreadRef,
  listTools,
  listPatterns,
  listAgents,
  showMemoryReads,
  showToolCalls,
  showWorkflowDetails,
  runDistill,
  makeAgentOptionsFactory,
  buildAgentFactory,
  buildPatternConfig,
  runPattern,
  makeBrainFactory,
} from "./cli.js";
import { KnowledgeBase } from "./knowledge/knowledge-base.js";
import { globalPatternRegistry } from "./pattern/registry.js";
import { CC_GUARDS_DEFAULT } from "./agent/claude-code-brain.js";

/** REPL 命令表（相似度提示 + Tab 补全共用；与 handleLine 的 switch case 一一对应） */
const REPL_COMMANDS = [
  "help", "exit", "quit", "q", "new",
  "threads", "thread", "agents", "patterns", "tools",
  "memory", "kbwrite", "kb", "distill", "show", "pattern",
  "trace", "stats",
];

/** 编辑距离（未知命令相似度提示用；命令都是短词，朴素 DP 足够） */
function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,                                    // 删除
        curr[j - 1] + 1,                                // 插入
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)   // 替换
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/** 相似命令提示：编辑距离最小且 ≤2 → 返回 "/xxx"，否则 null */
function suggestCommand(input: string): string | null {
  if (!input) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of REPL_COMMANDS) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= 2 ? best : null;
}

/** Tab 补全（readline completer 协议：completions = 整行候选串，第二参 = 当前行）
 *  两级：行首 "/" 且尚无空格 → 补全命令名；行尾 "@xxx" token → 补全 Agent id */
function makeCompleter(agentIds: string[]): (line: string) => [string[], string] {
  return (line) => {
    if (line.startsWith("/") && !/\s/.test(line)) {
      const hits = REPL_COMMANDS.filter((c) => (`/${c}`).startsWith(line)).map(
        (c) => `/${c} `
      );
      return [hits, line];
    }
    const m = line.match(/(^|\s)@(\S*)$/);
    if (m) {
      const frag = m[2].toLowerCase();
      const hits = agentIds
        .filter((id) => id.toLowerCase().startsWith(frag))
        .map((id) => `${line}${id.slice(m[2].length)} `);
      return [hits, line];
    }
    return [[], line];
  };
}

/** /kb 与 kb 子命令共用的动作分发（rest: operand + flag 串） */
function dispatchKb(rt: Runtime, rest: string[]): void {
  const [action, ...tail] = rest;
  const operand = tail.find((a) => !a.startsWith("-")) ?? null;
  const flag = (name: string): string | null => {
    const hit = tail.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const kb = rt.kb;

  switch (action) {
    case "add":
      if (!operand) return void console.log('用法: /kb add "内容" --type=lesson --title=标题 [--keywords=a,b]');
      opKbAdd(kb, {
        content: operand,
        type: flag("type"),
        title: flag("title"),
        keywords: (flag("keywords") ?? "").split(",").map((k) => k.trim()).filter(Boolean),
        threadId: rt.currentThreadId,
        agent: flag("agent"),
      });
      return;
    case "search":
      if (!operand) return void console.log('用法: /kb search "词" [--type=] [--limit=N]');
      opKbSearch(kb, operand, {
        type: flag("type"),
        limit: flag("limit") ? parseInt(flag("limit")!, 10) : null,
      });
      return;
    case "list":
      opKbList(kb, {
        type: flag("type"),
        limit: flag("limit") ? parseInt(flag("limit")!, 10) : null,
      });
      return;
    case "stats":
      opKbStats(kb);
      return;
    case "del":
      if (!operand) return void console.log("用法: /kb del <id>");
      opKbDel(kb, operand);
      return;
    case "verify":
      if (!operand) return void console.log("用法: /kb verify <id>");
      opKbVerify(rt.storage, operand);
      return;
    default:
      console.log(`未知动作 "${action ?? ""}"。可用: add | search | list | stats | del | verify`);
  }
}

/** 单轮命令处理；返回 false 表示退出 REPL */
async function handleLine(rt: Runtime, line: string, state: { threadId: string | null }): Promise<boolean> {
  const input = line.trim();
  if (!input) return true;
  rt.currentThreadId = state.threadId;

  // ─── 斜杠命令 ────────────────────────────────────────────────
  if (input.startsWith("/")) {
    const tokens = input.slice(1).split(/\s+/);
    const [cmd, ...rest] = tokens;

    switch (cmd) {
      case "help":
        printReplHelp();
        return true;
      case "exit":
      case "quit":
      case "q":
        return false;
      case "new":
        state.threadId = null;
        rt.currentThreadId = null;
        console.log("✓ 已开新会话（首条消息时生效）");
        return true;
      case "threads":
        printThreads(rt.storage, rest[0] ? parseInt(rest[0], 10) : 10);
        return true;
      case "thread": {
        const ref = rest[0];
        if (!ref) {
          console.log("用法: /thread <id|last>");
          return true;
        }
        const resolved = resolveThreadRef(rt.storage, ref);
        if (!resolved) {
          console.log(`未找到会话 "${ref}"（/threads 查看列表）`);
          return true;
        }
        state.threadId = resolved;
        rt.currentThreadId = resolved;
        const n = rt.storage.getMessages(resolved).length;
        console.log(`✓ 已切换到会话 ${resolved}（${n} 条消息）`);
        return true;
      }
      case "agents":
        listAgents(rt.registry);
        return true;
      case "patterns":
        listPatterns();
        return true;
      case "tools":
        listTools(rt.toolRegistry);
        return true;
      case "memory": {
        const v = rest[0];
        if (v !== "on" && v !== "off") {
          console.log(`当前记忆注入: ${rt.memoryOn ? "on" : "off"}（/memory on|off 切换）`);
          return true;
        }
        rt.setMemory(v === "on");
        console.log(`✓ 记忆注入已${v === "on" ? "开启" : "关闭（零查询零注入 + kb 工具下线）"}`);
        return true;
      }
      case "kbwrite": {
        const v = rest[0];
        if (v !== "on" && v !== "off") {
          console.log(`当前 kb_write: ${rt.kbWriteOn ? "on" : "off"}（/kbwrite on|off 切换）`);
          return true;
        }
        rt.setKbWrite(v === "on");
        console.log(`✓ kb_write 已${v === "on" ? "开启（Agent 可写知识库，verified=0）" : "关闭"}`);
        return true;
      }
      case "kb":
        dispatchKb(rt, rest);
        return true;
      case "trace": {
        // /trace [N] · /trace show <id|last> [--full] —— 轨迹列表/瀑布树回放
        if (rest[0] === "show") {
          opTraceShow(rt.storage, rest[1] ?? "last", rest.includes("--full"));
        } else {
          const n = parseInt(rest[0] ?? "", 10);
          opTraceList(rt.storage, Number.isNaN(n) ? 10 : n);
        }
        return true;
      }
      case "stats": {
        // /stats [--by=agent|thread|day] —— token 计费聚合
        const byFlag = rest.find((a) => a.startsWith("--by="));
        const by = (byFlag ? byFlag.slice(5) : "agent") as "agent" | "thread" | "day";
        if (!["agent", "thread", "day"].includes(by)) {
          console.log("用法: /stats [--by=agent|thread|day]");
          return true;
        }
        opStats(rt.storage, by);
        return true;
      }
      case "distill": {
        if (!state.threadId) {
          console.log("当前还没有会话（先发一条消息，或 /thread <id> 切换）");
          return true;
        }
        await runDistill(rt.storage, rt.kb, state.threadId, {
          force: rest.includes("--force"),
          tracer: rt.tracer,
          entry: "repl",
        });
        return true;
      }
      case "show": {
        // /show memory|tools|workflow —— 回放当前会话（就地完成，不逃逸到 one-shot）
        const what = rest[0];
        if (!state.threadId) {
          console.log("当前还没有会话。");
          return true;
        }
        if (what === "memory") showMemoryReads(rt.storage, rt.kb, state.threadId);
        else if (what === "tools") showToolCalls(rt.storage, state.threadId);
        else if (what === "workflow") showWorkflowDetails(rt.storage, state.threadId);
        else console.log("用法: /show memory|tools|workflow");
        return true;
      }
      case "pattern": {
        // /pattern pipeline --agents=bob,ji-tui 任务文本…
        const m = input.match(/^\/pattern\s+(\S+)\s*([\s\S]*)$/);
        if (!m) {
          console.log("用法: /pattern <name> [--agents=A,B] [--aggregator=ID] [--rounds=N] [--manager=ID --workers=A,B] 任务");
          return true;
        }
        const [, name, tailStr] = m;
        if (!globalPatternRegistry.get(name)) {
          console.log(`Pattern "${name}" 不存在（/patterns 查看）`);
          return true;
        }
        const flags = tailStr.match(/--\w+(=[^\s]+)?/g) ?? [];
        const task = tailStr.replace(/--\w+(=[^\s]+)?/g, "").trim();
        const flagVal = (k: string): string | null => {
          const hit = flags.find((f) => f.startsWith(`--${k}=`));
          return hit ? hit.slice(k.length + 3) : null;
        };
        if (!task) {
          console.log("缺少任务文本（放在 flags 之后）");
          return true;
        }

        const tid = state.threadId ?? (state.threadId = rt.storage.createConversation().id);
        rt.currentThreadId = tid;
        try {
          const config = buildPatternConfig(name, {
            agents: flagVal("agents")?.split(",") ?? [],
            aggregator: flagVal("aggregator"),
            rounds: flagVal("rounds") ? parseInt(flagVal("rounds")!, 10) : null,
            manager: flagVal("manager"),
            workers: flagVal("workers")?.split(",") ?? [],
          });
          const makeAgentOptions = makeAgentOptionsFactory(rt.storage, rt.toolRegistry, rt.sandbox, rt.tracer);
          // Phase 9：每行重建 brain 工厂（取当前开关状态 → /kbwrite /memory 下一行生效）
          const makeBrain = makeBrainFactory(rt.brainDeps(), {
            override: rt.brainOpts.brainOverride,
            guards: {
              maxTurns: rt.brainOpts.ccMaxTurns ?? CC_GUARDS_DEFAULT.maxTurns,
              budgetUsd: rt.brainOpts.ccBudget ?? CC_GUARDS_DEFAULT.budgetUsd,
            },
          });
          const buildAgent = buildAgentFactory(rt.registry, rt.storage, makeAgentOptions, [], makeBrain);
          await runPattern({
            patternName: name,
            task,
            threadId: tid,
            config,
            registry: rt.registry,
            threads: rt.threads,
            storage: rt.storage,
            orchestrator: rt.orchestrator,
            buildAgent,
            kb: rt.kb,
            tracer: rt.tracer,
            entry: "repl",
          });
        } catch (err) {
          console.error(`Pattern 执行失败: ${err instanceof Error ? err.message : err}`);
        }
        return true;
      }
      default: {
        // 相似度提示：编辑距离 ≤2 的最近命令（/ditsill → /distill）
        const hint = suggestCommand(cmd);
        const suffix = hint ? `，是不是想输入 /${hint}？` : "";
        console.log(`未知命令 /${cmd || ""}${suffix}（/help 查看）`);
        return true;
      }
    }
  }

  // ─── 裸文本 → 路由对话（与 one-shot 分支 1 同路径）──────────────
  const tid = state.threadId ?? (state.threadId = rt.storage.createConversation().id);
  rt.currentThreadId = tid;
  const makeAgentOptions = makeAgentOptionsFactory(rt.storage, rt.toolRegistry, rt.sandbox, rt.tracer);
  // Phase 9：每行重建 brain 工厂（裸文本路径；/pattern 路径在其 case 内自建）
  const makeBrain = makeBrainFactory(rt.brainDeps(), {
    override: rt.brainOpts.brainOverride,
    guards: {
      maxTurns: rt.brainOpts.ccMaxTurns ?? CC_GUARDS_DEFAULT.maxTurns,
      budgetUsd: rt.brainOpts.ccBudget ?? CC_GUARDS_DEFAULT.budgetUsd,
    },
  });
  const buildAgent = (agentId: string): Agent => buildAgentFactory(rt.registry, rt.storage, makeAgentOptions, [], makeBrain)(agentId);

  try {
    // Phase 8：chat trace（每轮独立——REPL 串行队列保证轮次不重叠，ALS 天然隔离）
    const trace = rt.tracer.startTrace("chat", {
      entry: "repl",
      threadId: tid,
      title: input.slice(0, 200),
    });
    const result = await rt.tracer.run(trace, () => rt.router.route(input, tid, buildAgent));
    printReply(result.agentId, result.content, result.a2aReplies);
    printReceipt(rt.storage, trace.id);
  } catch (err) {
    console.error(`执行失败: ${err instanceof Error ? err.message : err}`);
    console.log("（REPL 继续运行，可重试或 /help）");
  }
  return true;
}

/** REPL 帮助 */
function printReplHelp(): void {
  console.log(`
命令:
  <文本> | @agent 文本        路由对话（@ 指定 Agent；每轮自动记轨迹 + 打 📊 回执行）
  /pattern <name> [flags] 任务 一次性 Pattern 编排（/patterns 列出）
  /trace [N]                  近期轨迹列表（kind/耗时/tokens/成本）
  /trace show <id|last> [--full]  轨迹瀑布树回放（route→agent→llm/tool）
  /stats [--by=agent|thread|day]  token 计费聚合
  /distill [--force]          提炼当前会话入知识库
  /kb add|search|list|stats|del|verify ...   知识库操作（同 kb 子命令）
  /memory on|off              记忆注入开关（off = 零注入 + kb 工具下线）
  /kbwrite on|off             kb_write 门控
  /threads [N] · /thread <id|last> · /new    会话管理
  /agents · /patterns · /tools              列表
  /show memory|tools|workflow 回放当前会话的记忆注入/工具调用/编排执行
  /help · /exit（Ctrl-D）

提示: 输入 "/" 或行尾 "@" 后按 Tab 可补全命令 / Agent 名`);
}

/** REPL 入口（cli.ts 无参数启动时动态 import 调用）
 *
 *  不用 rl.question() 循环：管道输入（printf | npm run phase7）时所有行
 *  一次到达，question 的 once('line') 只接住第一行，后续行全丢。
 *  改为 on("line") + 串行 Promise 队列：逐行顺序处理，TTY/管道两用。
 */
export async function startRepl(
  opts: {
    workdir?: string;
    allowWrite?: boolean;
    allowExec?: boolean;
    brainOverride?: string | null;
    ccMaxTurns?: number;
    ccBudget?: number;
  } = {}
): Promise<void> {
  const rt = new Runtime(opts);
  const state: { threadId: string | null } = { threadId: null };
  const isTTY = Boolean(process.stdin.isTTY);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
    completer: makeCompleter(rt.registry.listIds()),
  });

  // 状态栏：memory/kbwrite 开关直接影响下一句话的行为，必须在 prompt 里可见
  // （每轮 handleLine 后都会重设，toggle 即时刷新）
  const updatePrompt = (): void => {
    const thread = state.threadId ? `会话 ${state.threadId.slice(-8)}` : "新会话";
    rl.setPrompt(`[${thread} · 记忆${rt.memoryOn ? "on" : "off"} · kbwrite${rt.kbWriteOn ? "on" : "off"}] > `);
  };

  console.log(`🧩 Phase 9 交互模式 · Agent: ${rt.registry.listAll().length} · 工具: ${rt.toolRegistry.list().length} · 记忆注入: ${rt.memoryOn ? "on" : "off"}`);
  console.log(`📁 沙箱目录: ${rt.sandbox.config.workDir}`);
  console.log(
    `🧠 Brain: ${rt.brainOpts.brainOverride ? `--brain=${rt.brainOpts.brainOverride} 覆盖` : "按 Agent 配置 runtime（--list-agents 查看）"} · CC 护栏: ${rt.brainOpts.ccMaxTurns ?? CC_GUARDS_DEFAULT.maxTurns} 轮 / $${rt.brainOpts.ccBudget ?? CC_GUARDS_DEFAULT.budgetUsd}`
  );
  console.log(`输入 /help 查看命令，/exit 或 Ctrl-D 退出\n`);

  let exited = false;
  let chain: Promise<void> = Promise.resolve();

  rl.on("line", (line) => {
    // 串行排队：对话/Pattern 是异步的，下一行必须等上一行处理完
    chain = chain.then(async () => {
      const cont = await handleLine(rt, line, state);
      if (!cont) {
        exited = true;
        rl.close();
        return;
      }
      updatePrompt();
      if (isTTY) rl.prompt();
    });
  });

  return new Promise<void>((resolve) => {
    rl.on("close", () => {
      void chain.then(() => {
        if (!exited) process.stdout.write("\n");
        console.log(isTTY ? "再见 👋" : "");
        resolve();
      });
    });
  });
}
