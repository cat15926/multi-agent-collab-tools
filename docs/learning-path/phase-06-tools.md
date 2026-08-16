# Phase 6 — 工具调用（给 Agent 装手）

> **这是 Agent 从"只会说"到"会做事"的跨越** —— Phase 1-5 的 Agent 全靠"嘴巴"（生成文本）工作；Phase 6 给它装上"手"（工具），让它能读文件、写文件、执行命令、真正地操作环境。
>
> **核心目标**：实现 Anthropic Tool Use（function calling）协议，让 Agent 在一次回复中自主决定**调用哪些工具、按什么顺序、调用几次**，直到收集够信息再给出最终回答。
>
> **对应抽象**：① Agent 的 `tools?` 字段（core-abstractions 里明确标注"Phase 6 才有"）+ 平台层"工具调用 / 文件操作 / 命令执行"职责。
>
> **安全基调**：**Hard Rails + Soft Power**。工具 = 能力，也是风险。Phase 6 的硬护栏（沙箱、白名单、确认）不可协商；护栏之上才释放 Agent 的自主性。

---

## 🎯 Phase 目标

| 能力 | Phase 5（只有嘴） | Phase 6（有手） |
|------|------------------|-----------------|
| 信息来源 | 只能用 system prompt + 历史里已有的内容 | **能主动读文件 / 跑命令 / 检索**获取真实信息 |
| 输出影响 | 只产生文本回复 | **能写文件 / 创建产物**，改变环境状态 |
| 回复结构 | 单次 `messages.create` → 取 text | **多轮 tool loop**：tool_use → 执行 → tool_result → 再推理 |
| 能力边界 | 固定（LLM 训练知识 + 注入上下文） | **可扩展**（注册新工具 = 给 Agent 新能力） |
| 危险性 | 低（只输出文字） | **高**（能删文件、跑任意命令）→ 必须有沙箱 |

**一句话**：Phase 1-5 的 Agent 是"嘴"；Phase 6 让它长出"手"。手能干活，也可能闯祸——所以这一阶段的**一半工作量在安全**。

---

## 📋 验收标准

完成本 Phase 后，以下场景应能运行：

```bash
# 1. 读文件：Agent 自主调用 read_file，读取真实文件后总结
pnpm phase6 "@agent 读取 package.json，总结这个项目用了哪些依赖"
# 预期：Agent 调 read_file → 拿到内容 → 总结依赖（不是瞎编）

# 2. 多步工具链：Agent 连续调用多个工具
pnpm phase6 "@agent 在 src 目录下找出所有定义了 reply 函数的文件"
# 预期：list_files → 逐个 read_file（或多文件）→ 汇报结果

# 3. 写文件：受保护操作，触发确认
pnpm phase6 "@agent 创建一个 hello.txt，内容写『Phase 6 works!』" --allow-write
# 预期：Agent 调 write_file → 沙箱确认 → 文件真的被创建

# 4. 执行命令：只读命令直接放行，危险命令被拦
pnpm phase6 "@agent 用 git log 看最近 3 条提交"
# 预期：Agent 调 run_command("git log -n 3") → 白名单放行 → 返回提交记录

# 5. 工具调用全程可观测 + 可回放
pnpm phase6 --thread=xxx --show-tools
# 预期：显示这次会话里 Agent 调了哪些工具、输入输出、耗时、成功/失败
```

**验收铁律**（来自项目设计原则 P5"验证 = 完成"）：
- Agent **必须真的调用了工具**（不是把工具名写进文本里假装调了）——靠 `--show-tools` 落盘记录证明。
- 工具结果**必须来自真实环境**（读到的文件内容 = 磁盘上的真实内容）。
- **危险操作必须被拦下**（`rm -rf /`、写沙箱外路径、未知命令 → 拒绝或要求确认）。

---

## 🏗️ 架构设计

### 核心抽象 1：Tool（工具）

一个工具 = **给 LLM 看的 schema** + **给运行时执行的 handler**。

```ts
/** 工具执行结果 */
export interface ToolResult {
  content: string;        // 文本结果，喂回 LLM 的 tool_result
  isError?: boolean;      // true = 工具执行失败（LLM 会据此重试或改方案）
}

/** 工具接口 */
export interface Tool {
  /** 工具名（LLM 用它来调用，必须唯一） */
  name: string;
  /** 描述（LLM 据此判断"该不该用这个工具"——写清楚 = LLM 调得准） */
  description: string;
  /** 输入 schema（JSON Schema 格式，直接传给 Anthropic API 的 input_schema） */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** 执行函数：LLM 传来的参数 → 真实环境操作 → 文本结果 */
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}
```

**设计要点**：
- `inputSchema` 用 **JSON Schema**，因为这就是 Anthropic API 原生格式（`tools[].input_schema`），零转换。
- `execute` 返回 `ToolResult` 而非裸 `string`——`isError` 让"工具失败"有结构化语义（Clowder 的 `status: ok|error` 同理），失败时 LLM 能感知并调整，而不是把错误文本当正常结果。
- 工具是**纯函数式的执行单元**，不持有状态——状态（当前会话、工作目录、权限）由调用方传入。

### 核心抽象 2：ToolRegistry（工具注册表）

```ts
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void { ... }
  get(name: string): Tool | undefined { ... }
  list(): Tool[] { ... }

  /** 返回给 Anthropic API 的 tools 数组（只暴露 name/description/input_schema，不含 execute） */
  toAnthropicTools(): AnthropicTool[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /** 按 Agent 授权过滤：某 Agent 只能用白名单里的工具 */
  filterFor(agentId: string, allowed: string[]): Tool[] { ... }
}
```

**关键决策**：工具与 Agent 解耦——工具全局注册，Agent 配置里声明**可用工具白名单**（`config/agents/*.json` 加 `tools: [...]` 字段）。同一个 `read_file` 工具，只读 Agent 不给 `write_file`。这正是 Clowder "环境感知过滤"思想的学习版简化。

### 核心抽象 3：Agent 的 tool-use loop（本 Phase 灵魂）

这是 Phase 6 最核心、最难的改造。当前 Phase 5 的 `Agent.reply`（`agent/agent.ts:48-74`）是**单次** `messages.create` + 只取 `text` block——**会直接漏掉 `tool_use` block**。Phase 6 要把它变成一个**循环**：

```
用户输入
   │
   ▼
┌──────────────────────────────────────────────┐
│  for turn in 0..MAX_TOOL_TURNS:              │  ← 循环上限（防无限调用）
│    ① messages.create(messages, tools)        │
│    ② response.stop_reason?                   │
│       ├─ "end_turn" / 其它 → 跳出循环 ★      │
│       └─ "tool_use" → 进入 ③                 │
│    ③ 提取所有 tool_use block                 │
│    ④ 逐个执行 tool.execute(input)            │  ← 真正"动手"
│       （沙箱校验 + 落盘记录）                 │
│    ⑤ 把 tool_use + tool_result 追加进 messages│
│  end                                         │
└──────────────────────────────────────────────┘
   │
   ▼
返回最终 text（Agent 收集够信息后的回答）
```

**代码骨架**（非流式版，学习项目首选）：

```ts
async reply(content: string, options: AgentReplyOptions): Promise<string> {
  const tools = this.toolRegistry?.toAnthropicTools() ?? [];
  const messages = this.buildMessages(options.history, content);

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {     // ① 循环 + 上限
    const response = await this.client.messages.create({
      model: this.model, max_tokens: 4096,
      system: this.buildSystemPrompt(options.participants),
      messages, tools,                                    // ← 关键：带上 tools
    });

    // ② 终止判断
    if (response.stop_reason !== "tool_use") break;       // end_turn → 收集够信息

    // ③④ 提取 + 执行所有 tool_use
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type !== "tool_use") continue;
      const result = await this.executeTool(block, options);  // 沙箱 + 记录
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    // ⑤ 喂回结果，进入下一轮
    messages.push({ role: "user", content: toolResults });
  }

  // 取最终文本（最后一次 end_turn 的回复）
  return this.extractText(lastResponse);
}
```

**5 个必须处理好的细节**（都是 Clowder 踩过并解决的）：

| 细节 | 处理方式 | 参照 Clowder |
|------|---------|--------------|
| **无限循环** | `MAX_TOOL_TURNS`（建议 **10**）硬上限 | `MAX_TOOL_TURNS = 15` |
| **结果爆炸** | 工具输出**截断**（如 2000 字符），避免撑爆上下文 | `TOOL_RESULT_DIGEST_LIMIT = 500` |
| **工具失败** | 返回 `isError: true` 的 tool_result，让 LLM 自己决定重试/换方案 | `status: ok\|error` |
| **多工具并发** | LLM 可在一轮返回多个 tool_use → **全部执行**再回传（顺序即可，简单） | 一轮多 block |
| **stop_reason** | 只有 `"tool_use"` 才继续循环；`"end_turn"`/`"max_tokens"`/`"stop_sequence"` 都终止 | `TERMINAL_STOP_REASONS` |

> ⚠️ **易错点**：`messages` 数组里 `assistant` 消息的 `content` 必须是**完整的 `response.content` 数组**（含 text + tool_use blocks），不能只塞 text。Anthropic API 要求 tool_use 和后续 tool_result 的 `tool_use_id` 严格配对，否则报错。

### 核心抽象 4：安全沙箱（Hard Rails）—— 本 Phase 一半工作量

工具能干活也能闯祸。沙箱是**多层防御**，借鉴 Clowder 的成熟做法（但学习项目**不做 OS 级隔离**，只做应用层校验）：

| 层 | 防什么 | 实现 | Clowder 对应 |
|----|--------|------|--------------|
| **① 工作目录限制** | 读写沙箱外文件 | 所有文件工具的 path 先 resolve，必须落在 `workDir` 内；**跟随符号链接**防 `../../etc/passwd` 逃逸 | `path-validator.ts` `isPathAllowed` + `tryRealpathSync` |
| **② 输入 Schema 校验** | LLM 传畸形参数 | 执行前校验：拒绝未声明字段、检查必填、类型匹配 | `validateToolInput`（`rejectUndeclaredFields`） |
| **③ 命令白名单** | 执行危险命令 | `run_command` 只放行**只读命令正则白名单**（`ls/cat/pwd/git log/git status/git diff/git show`）；默认拒绝 | `READ_ONLY_PATTERNS` 正则 |
| **④ 危险模式黑名单** | rm/fork bomb/删库 | 硬拒绝 `rm -rf /`、fork bomb `:(){...}`、控制字符 `><\|;&`、`$` 变量、glob `*?[]` | `FORBIDDEN_PATTERNS` + `SHELL_CONTROL_PATTERN` |
| **⑤ flag 注入** | LLM 往命令塞 `-rf` | 用户参数不允许以 `-` 开头；强制 `--` 分隔符 | `buildSafeCommand` |
| **⑥ 高危确认** | 写/删/执行 | 写文件、删文件、执行命令 → **要求确认**（`--allow-write` / `--allow-exec` 或交互 y/N）；只读工具免确认 | `HIGH_RISK_VERBS` + `requiresConfirmation` |
| **⑦ 工具白名单** | Agent 越权用工具 | Agent 配置 `tools: [...]` 限定可用工具集 | `READONLY_ALLOWED_TOOLS` |

**沙箱不是可选的**——它是 Phase 6 的验收前提。没有沙箱的工具调用 = 给 LLM 一个不受限的 shell，这是项目"Hard Rails"原则的硬性要求。

---

## 🗄️ 数据库扩展

### Phase 6 新增表：`tool_calls`

记录每次工具调用，用于可观测、回放、审计。

```sql
-- tool_calls 表：工具调用记录
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,          -- 归属会话
  agent_id TEXT NOT NULL,           -- 调用方 Agent
  tool_name TEXT NOT NULL,          -- 工具名（read_file / run_command ...）
  tool_use_id TEXT,                 -- Anthropic 原生 tool_use.id（配对用）
  input TEXT,                       -- 工具输入（JSON）
  output TEXT,                      -- 工具输出（截断后）
  status TEXT NOT NULL CHECK(status IN ('ok', 'error', 'blocked')),  -- blocked = 沙箱拦截
  duration_ms INTEGER NOT NULL,     -- 执行耗时（毫秒）
  created_at INTEGER NOT NULL,      -- ⚠️ 毫秒时间戳（显式插入 Date.now()，不依赖 DEFAULT）
  FOREIGN KEY (thread_id) REFERENCES conversations(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_thread
  ON tool_calls(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent
  ON tool_calls(agent_id, created_at);
```

> ⚠️ **吸取 ADR-007 教训**：本项目时间戳单位混乱（多数表 `strftime('%s','now')` 是秒，workflow 表插入用毫秒），导致过显示 bug。**Phase 6 的 `tool_calls` 表统一用毫秒**：`created_at` 显式插入 `Date.now()`，duration 用毫秒，并在 schema 注释里标明单位。新增工具操作时**禁止**依赖 `DEFAULT strftime('%s','now')`（那是秒）。

**查询能力**：
- 按会话查所有工具调用（`--show-tools` 回放）
- 按状态查（`blocked` → 审查沙箱是否误拦 / 漏拦）
- 按 Agent 查（谁最爱调工具 / 谁老失败）

---

## 📁 文件组织

```
src/phase-06-tools/
├── cli.ts                        # 入口：--tools, --workdir, --allow-write, --allow-exec, --show-tools
├── agent/
│   └── agent.ts                  # ★ 改造：reply 加 tool-use loop（复用 Phase 5 Agent，扩展）
├── tools/                        # ★ Phase 6 新增核心
│   ├── tool.ts                   # Tool / ToolResult 接口
│   ├── registry.ts               # ToolRegistry（注册 + Agent 授权过滤）
│   ├── sandbox.ts                # ★ 安全沙箱（路径校验 + 命令白名单 + 确认）
│   ├── builtin/                  # 内置工具
│   │   ├── read-file.ts          # read_file
│   │   ├── write-file.ts         # write_file（高危，需确认）
│   │   ├── list-files.ts         # list_files
│   │   ├── search-files.ts       # search_files（grep 内容）
│   │   └── run-command.ts        # run_command（高危，白名单 + 需确认）
│   └── index.ts
├── storage/
│   ├── schema.sql                # 扩展：tool_calls 表（毫秒时间戳）
│   └── sqlite.ts                 # 扩展：addToolCall / getToolCallsByThread
├── router/  thread/  registry/  a2a/  orchestrator/  pattern/   # 复用 Phase 5
└── ...
```

**复用策略**（与 Phase 5 一致）：Phase 6 是在 Phase 5 基础上**叠加工具能力**，不重写协作层。`Agent`、`Router`、`Orchestrator`、4 个 Pattern 全部复用——**工具与 Pattern 正交**（pipeline 里每一步的 Agent 都可以自己调工具）。

---

## 🔧 实现顺序

### Step 1：Tool 接口 + ToolRegistry（1.5h）
- [x] 定义 `Tool` / `ToolResult` 接口（`tools/tool.ts`）
- [x] 实现 `ToolRegistry`（register / get / list / `toAnthropicTools` / `forAgent`）
- [x] 单元测试：注册、查找、过滤、schema 转换

### Step 2：改造 Agent.reply 的 tool-use loop（3h）⭐ 核心
- [x] `reply` 加 `tools` 参数（从 Registry 取，按 Agent 授权过滤）
- [x] 实现 `for (turn < MAX_TOOL_TURNS)` 循环：create → 判 stop_reason → 执行 → 追加 messages
- [x] `executeTool`：分发到 registry.get(name).execute + 落盘记录 + 沙箱钩子
- [x] 结果截断（防上下文爆炸）
- [x] 测试：mock 一个 echo 工具，验证多轮 loop、终止、失败回传

### Step 3：内置只读工具（2h）
- [x] `read_file`（带工作目录 + 路径校验）
- [x] `list_files`
- [x] `search_files`（grep 内容，返回匹配行）
- [x] 端到端：`@agent 读 package.json` 能拿到真实内容

### Step 4：安全沙箱（3h）⭐ 重点工作量
- [x] `sandbox.ts`：`validatePath`（resolve + 跟随 symlink + workDir 边界）
- [x] `validateInput`（schema 校验，拒绝未声明字段）
- [x] 命令白名单 + 危险模式黑名单 + 控制字符拒绝 + `--` 分隔
- [x] 确认机制（高危操作 `requiresConfirmation`）
- [x] 测试：路径逃逸、flag 注入、`rm -rf`、未知命令 **全部被拦**（21/21 用例通过）

### Step 5：高危工具（1.5h）
- [x] `write_file`（需 `--allow-write` 或确认）
- [x] `run_command`（白名单内放行，其余确认/拒绝）
- [x] 端到端：写文件真的落盘；危险命令被拦并记录为 `status=blocked`

### Step 6：Agent 工具授权 + 持久化（1.5h）
- [x] Agent 配置加 `tools: [...]` 字段（接口 + Registry 支持；省略 = 全部工具，已 E2E 验证）
- [x] `tool_calls` 表 + `addToolCall` / `getToolCallsByThread`
- [x] loop 内每次 execute 落盘

### Step 7：CLI（2h）
- [x] `--tools=a,b,c`（指定可用工具）/ `--workdir=PATH`（沙箱根）/ `--allow-write` / `--allow-exec`（免确认开关）
- [x] `--show-tools`（回放会话工具调用）
- [x] 实时输出：复用 Phase 5 的 `PatternEvents` 思路，工具调用时打印 `🔧 tool_name(args) → 结果`

### Step 8：文档 + ADR（1h）
- [x] 完成本文档
- [ ] ADR-008：Tool Use loop 设计（为什么放 Agent 层而非 Orchestrator；MAX_TOOL_TURNS 取值）— 待补
- [ ] ADR-009：沙箱设计（多层防御 + 为何不做 OS 级隔离）— 待补
- [x] 更新 `docs/learning-path/README.md`

---

## 🎯 验收场景

### 场景 1：读文件（单工具）

```bash
$ pnpm phase6 "@agent 读取 package.json，总结依赖"

🔧 read_file({ path: "package.json" })
   → ok · 120ms

这个项目的依赖有：
- @anthropic-ai/sdk（LLM 调用）
- better-sqlite3（存储）
- tsx（直接跑 TS）
- typescript
...
```

### 场景 2：多步工具链

```bash
$ pnpm phase6 "@agent src 目录下哪些文件定义了 reply 函数？"

🔧 list_files({ path: "src" })
   → ok · 8ms
🔧 search_files({ path: "src", pattern: "reply" })
   → ok · 15ms

在 src 下，以下文件定义了 reply 函数：
- src/phase-01-single-agent/agent.ts（reply, replyStream）
- src/phase-05-patterns/agent/agent.ts（reply）
...
```

### 场景 3：写文件（高危确认）

```bash
$ pnpm phase6 "@agent 创建 hello.txt 写入 Phase 6 works!" --allow-write

🔧 write_file({ path: "hello.txt", content: "Phase 6 works!" })
   → ok · 3ms

已创建 hello.txt，内容已写入。
```

### 场景 4：危险命令被拦

```bash
$ pnpm phase6 "@agent 执行 rm -rf /tmp/test"

🔧 run_command({ command: "rm -rf /tmp/test" })
   → ✗ BLOCKED · 命令不在白名单（rm 非只读），已拒绝并记录

抱歉，`rm -rf` 不在允许的只读命令白名单内，出于安全考虑我无法执行删除操作。
如果你确实需要删除，请用 --allow-exec 显式授权，或手动执行。
```

### 场景 5：工具调用回放

```bash
$ pnpm phase6 --thread=xxx --show-tools

会话 xxx 的工具调用记录：

  ✓ read_file(package.json) · 120ms · ok
  ✓ list_files(src) · 8ms · ok
  ✓ search_files(src, "reply") · 15ms · ok
  ✗ run_command(rm -rf ...) · 2ms · blocked
```

---

## 🔑 关键设计决策

### 决策 1：Tool loop 放 Agent 层，不放 Orchestrator

**选择**：tool-use 循环写在 `Agent.reply` 内部。

**理由**：
- 工具调用是**单个 Agent 的推理行为**（"我需要先读个文件才能回答"），属于 Agent 的"大脑+手"协同，不是多 Agent 编排。
- Orchestrator 管"Agent 之间怎么协作"（Phase 5），Agent 管"我自己怎么完成任务"（Phase 6）——**职责正交**。
- 这样 pipeline 的每一步、debate 的每一轮，**各自**的 Agent 都能独立调工具，组合自然。
- 对照 Clowder：它的 agentic loop 也在 `CatAgentService`（单个 Agent 服务）内，不在编排层。

### 决策 2：非流式起步，流式留作进阶

**选择**：Phase 6 的 tool loop 用非流式 `messages.create`（Phase 5 现状）。

**理由**：
- 非流式下 tool_use block 是完整的，配对、执行、回传逻辑最简单，**先跑通协议**。
- 流式（SSE）要处理 `tool_use` 的 input_json 增量拼接，复杂度高——这是 Phase 8（可观测性）或单独的"流式 tool use"子任务再做的事。
- 实时性靠 **Phase 5 已有的 `PatternEvents` 思路**弥补：工具调用时打印进度（`🔧 tool → 结果`），用户不干等。
- 对照 Clowder：生产版用流式 SSE，但它也是先有非流式逻辑再加流式包装。

### 决策 3：沙箱做应用层校验，不做 OS 级隔离

**选择**：路径校验 + 命令白名单 + 确认机制，**不**用 Docker / chroot / seccomp。

**理由**：
- 学习项目，复杂度要可控；OS 沙箱是运维级工程，偏离"理解原理"目标。
- 应用层校验已能挡住绝大多数风险（路径逃逸、危险命令、flag 注入）。
- 真正的隔离留给"进阶主题"（Phase 10）或参考 Clowder 的部署层。
- **但**：借鉴 Clowder 的关键细节——**路径校验跟随符号链接**（`tryRealpathSync`），否则 `ln -s` 就能绕过 workDir 限制。这个细节必须做对。

### 决策 4：工具与 Pattern 正交

**选择**：Phase 5 的 4 个 Pattern 零改动，自然获得工具能力。

**理由**：Pattern 调 `executeAgent` → `agent.reply`，而 tool loop 在 `reply` 内。所以 `pipeline --agents=a,b,c` 时，a/b/c 各自回复时都能自主调工具——这是"叠加"而非"耦合"。验收时可以跑 `pnpm phase6 "..." --pattern=pipeline --agents=a,b` 验证两者共存。

### 决策 5：内置工具最小集（5 个）

**选择**：`read_file` / `write_file` / `list_files` / `search_files` / `run_command`。

**理由**：
- 这 5 个足以验证 tool loop 的所有路径（单工具、多步链、读、写、执行、被拦）。
- 对照 Clowder 几十个工具——它是生产平台；学习项目先证明"机制跑通"，扩展工具是后面加 config 的事。
- 不做 `web_search`（要外部 API key，引入新依赖）、不做 MCP 接入（那是 Phase 10 进阶）。

---

## 📚 生产参考：Clowder 怎么做的

调研 Clowder AI（`~/lhz/clowder-ai`）的工具调用实现，提炼可借鉴的设计（**学习项目做简化版**）：

| 维度 | Clowder（生产） | 本项目 Phase 6（学习简化） |
|------|----------------|--------------------------|
| **Tool 接口** | `{ name, description, inputSchema, handler }`（MCP）或 `{ schema, execute, permission }`（CatAgent） | `{ name, description, inputSchema, execute } → ToolResult` |
| **Schema 格式** | Zod 定义 → JSON Schema | 直接 JSON Schema（Anthropic 原生） |
| **注册表** | 按 toolset 分类 + 环境感知过滤（readonly / agentKey / desktopMode 白名单） | `ToolRegistry` + Agent 配置白名单 |
| **Agent loop** | `agenticLoop`（流式 SSE，`CatAgentService.ts:134-233`），`MAX_TOOL_TURNS=15` | 非流式 `for` 循环，`MAX_TOOL_TURNS=10` |
| **结果截断** | `TOOL_RESULT_DIGEST_LIMIT=500` 字符 | 截断到 ~2000 字符 |
| **沙箱-路径** | `path-validator.ts`：`isPathAllowed` + 跟随 symlink `tryRealpathSync` | `validatePath`（同样跟随 symlink） |
| **沙箱-命令** | `READ_ONLY_PATTERNS` 正则白名单 + `FORBIDDEN_PATTERNS` + 拒绝 `><\|;&$*?[]` + `buildSafeCommand` 强制 `--` | 同款多层校验（简化版） |
| **沙箱-确认** | `HIGH_RISK_VERBS`（write/delete/execute/run...）→ `requiresConfirmation` | 写/删/执行 → 确认 |
| **持久化** | `StoredToolEvent`（type/toolUseId/status: ok\|error\|unknown/startTimeMs/endTimeMs/toolName）存进 `StoredMessage.toolEvents` | `tool_calls` 表（独立表，同样字段语义） |
| **流式展示** | SSE 实时 yield `tool_use` / `tool_result` 事件，前端渲染进度 | 非流式；用 `PatternEvents` 思路打印 `🔧` 进度 |

**最值得借鉴的 3 点**：
1. **agentic loop 的结构**（`for turn < MAX` → create → 判 stop_reason → 执行 → 追加 messages）——这是 tool use 的标准骨架，照搬。
2. **多层沙箱**（路径跟随 symlink + 输入 schema 拒绝未声明字段 + 命令白名单 + flag 注入防护）——每一层都解决一个真实攻击面。
3. **结构化工具状态**（`isError` / `status: blocked`）——工具失败和被拦截是不同语义，不要混在文本里。

---

## 📚 相关文档

- [核心抽象：Agent 的 `tools` 字段](../architecture/core-abstractions.md#抽象-1--agent智能体)
- [设计哲学：Hard Rails + Soft Power](../architecture/core-abstractions.md#设计哲学hard-rails--soft-power)
- [Phase 5 文档（Pattern，本 Phase 复用其 Agent/Orchestrator）](./phase-05-collaboration-patterns.md)
- [ADR-007（时间戳单位教训——本 Phase tool_calls 表引以为戒）](../decisions/007-fix-p5-001-workflow-time-display.md)

---

## 🎯 下一步（Phase 7）

Phase 6 给 Agent 装上了"手"（操作环境）；Phase 7 给它们装上"共享的长期记忆"：

- **KnowledgeBase**：跨会话的决策 / 经验 / 证据库
- Agent 能"记住上次踩过的坑"，跨 Thread 协作
- 技术点：共享状态、（可选）向量检索

> 抽象演进：
> - Phase 5：Pattern = "怎么协作"（拓扑）
> - Phase 6：Tools = "能做什么"（能力）
> - Phase 7：KnowledgeBase = "记得什么"（长期共享状态）
>
> ✅ 已完成 → [Phase 7 文档](./phase-07-shared-memory.md)

---

## ⏱️ 时间估算

| 步骤 | 时间 | 累计 |
|------|------|------|
| Tool 接口 + Registry | 1.5h | 1.5h |
| Agent tool-use loop ⭐ | 3h | 4.5h |
| 内置只读工具 | 2h | 6.5h |
| 安全沙箱 ⭐ | 3h | 9.5h |
| 高危工具（write/exec） | 1.5h | 11h |
| 授权 + 持久化 | 1.5h | 12.5h |
| CLI | 2h | 14.5h |
| 文档 + ADR | 1h | 15.5h |

**总计**：约 15.5 小时（2-3 个工作日）。其中 **Agent loop + 沙箱**占近一半——这正是 Phase 6 的两个核心难点。

---

## 🚀 快速验证（实现完成后）

```bash
# 1. 类型检查
npm run typecheck

# 2. 列出可用工具
pnpm phase6 --list-tools

# 3. 读文件（验证 tool loop 跑通）
pnpm phase6 "@agent 读 package.json 总结依赖"

# 4. 多步工具链
pnpm phase6 "@agent src 下哪些文件有 reply 函数"

# 5. 写文件（确认 + 真实落盘）
pnpm phase6 "@agent 创建 hello.txt" --allow-write && cat hello.txt

# 6. 危险命令被拦（验证沙箱）
pnpm phase6 "@agent 执行 rm -rf /tmp/x"

# 7. 工具调用回放
pnpm phase6 --thread=xxx --show-tools

# 8. 与 Pattern 共存（正交性）
pnpm phase6 "@agent 总结项目" --pattern=pipeline --agents=agent-a,agent-b
```
