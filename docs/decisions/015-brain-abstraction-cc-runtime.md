# ADR-015：Brain 可替换化 + 接入 Claude Code 运行时

- **状态**：accepted
- **日期**：2026-08-23
- **关联 Phase**：P9

## 背景

Phase 8 收官后，bob/nim/ji-tui 的能力边界 = 5 个自研 builtin 工具 + 10 轮 tool loop。用户诉求：让三个 Agent 附上 Claude Code 的完整能力（Read/Edit/Bash/Grep 原生工具、子代理、skills）。经可行性讨论（三条路线：SDK 内嵌 / CLI 子进程 / CC-as-tool）确认走 **Agent SDK 内嵌**，分三步落地：Brain 接口抽取（纯重构）→ ClaudeCodeBrain（`query()`）→ 观测映射。

## 决策

### 1. Brain 接口：`reply(req, events) → Promise<string>`

```
Agent（persona / 记忆渲染 / 会话投影 / 截断）   ← brain 无关，留在 Agent
  └─ Brain.reply({agentId, threadId, systemPrompt, messages}, {onLlmCall, onToolCall})
       ├─ AnthropicBrain    = Phase 6/8 的 messages.create + tool loop 原样搬入
       └─ ClaudeCodeBrain   = Agent SDK query() 完整 agentic loop
```

这是「Agent ≠ LLM」原则的终极验证：同一 persona/Thread/Pattern，换 brain 能力完全不同，router/pattern/a2a 三个 `reply()` 调用点零改动。`AgentOptions.brain?` 缺省构造 AnthropicBrain（旧调用零变化）。

选择 SDK 内嵌而非 CLI 子进程（Clowder 模式）的理由：`canUseTool` 能精确接现有 Sandbox（Hard Rails 保值）、`createSdkMcpServer` 让 Phase 7 kb 工具进程内注入、类型安全。CLI 子进程留作对照学习素材。

### 2. 无状态 CC：项目 Thread 是唯一记忆源

不用 `resume`/CC session——每次 reply() 历史 prompt 重发（`<conversation_history>` 标签包裹 + `<current_message>` 显式框住当前输入）。理由：现有架构本就每轮重发全量历史（AnthropicBrain 同款）；引入 CC session 会形成两层记忆，漂移无解。代价：prompt 随历史增长（truncateMessages(50) 沿用兜底）。

### 3. 双层沙箱（实测踩坑记录）

- **第一层** = CC 自带 cwd 边界（`cwd: sandbox.realWorkDir`，`additionalDirectories` 不传）
- **第二层** = `canUseTool` → 项目 Sandbox 映射（`cc-permissions.ts`）：Read/Glob/Grep 出 cwd → `validatePath`；Edit/Write → `requireWrite` + `validatePath`；Bash → `validateCommand`；`mcp__team-kb__*` → allow（kb_write 自门控）；未识别工具 **fail-closed deny**

**关键坑（实测发现）**：SDK 的 `settingSources` **省略时加载全部文件系统设置**（与早期调研相反）——项目 `.claude/settings.local.json` 里用户日常累积的 `Bash(npx tsx *)` 等 allow 规则被 CC 子进程继承，`npx tsx -e "import('fs')…writeFileSync"` 被**自动放行、根本不进 canUseTool**，无 `--allow-write` 也写盘成功。**修复：显式 `settingSources: []`（SDK 隔离模式）**——Agent 的权限只由本项目 Sandbox 决定，不继承用户个人 allow 规则。

**残余风险（接受的取舍）**：
- CC 内部安全分类器会自动放行它判定安全的命令（实测 `ls … 2>/dev/null` 带重定向未过 canUseTool）——第一层语义由 CC 定义；破坏性/复杂命令（Write、循环、非白名单）仍进第二层。未来收紧杠杆：`managedSettings` 强制 ask 规则。
- Bash 只读白名单（cat/head/find/grep…）不检查路径——`head /etc/hosts` 可读 cwd 外文件。Phase 6 起的既有特性，非本 phase 回归。
- `allowedTools` **绝不传**：它 = 自动批准 = 绕过 canUseTool。per-Agent `tools` 白名单实现为 canUseTool 内 deny（项目名→CC 名翻译表）。
- WebFetch/WebSearch/Task/KillBash/BashOutput/NotebookEdit/AskUserQuestion 走 `disallowedTools`（模型看不到，省 turn），而非 deny（会反复重试）。

### 4. 事件映射（观测平面接住 CC）

- **逐 assistant 消息发 onLlmCall**（turn 递增，usage/stop_reason 逐 API 调用粒度）——与 AnthropicBrain 语义对齐，stats 的 calls 计数不失真
- **最后一条延迟到 result 后补发**，挂 `ccTotalCostUsd`（SDK `total_cost_usd`，含子代理）+ `ccNumTurns` → span attributes `cc_cost_usd`/`cc_num_turns`
- **工具调用**：assistant 的 tool_use block 记 pending → user 的 tool_result 配对发 onToolCall（content 归一化）；**canUseTool deny 的调用在拒绝点即发 status=blocked 事件**并记 `toolUseID` 入 denied 集合，配对时跳过（防双记）；收尾与 `permission_denials` 数对账，不符 warn
- **成本双口径**：receipt/stats 用 pricing.json 读时计价（近似）；CC run 以 `cc_cost_usd` 为权威（SDK 重度依赖 prompt cache，两口径差异可能很大）。relay 环境（本项目实测 `glm-4.7`）usage 不上报 → tokens 0、成本 `?`，但 `cc_cost_usd` 仍可用
- **durationMs 是诚实近似**：拿不到纯 API 时延，用消息自带 ISO timestamp 差值（turn 1 含子进程冷启动、turn N+1 含前置工具执行）。实测冷启动 3-12s/轮

### 5. 预算守卫自实现

SDK 无逐消息成本回调（`total_cost_usd` 只在 result 到达，事后才知道）→ 每条 assistant 用 `costOf(model, in, out)` 读时计价累计，超 `--cc-budget`（默认 $0.5）即 `abortController.abort()` + throw（含累计额）。pricing 未配价 → 降级仅 `maxTurns`（默认 15），warn 一次。

### 6. error_max_turns 的双路径

本版 SDK（0.3.241）对轮数上限**直接 throw**（"Reached maximum number of turns"）而非发 result 消息 → catch 里按消息特征转换：返回已产出部分文本不 throw（对齐 AnthropicBrain 的 maxToolTurns 行为）。result 消息路径（success / error_during_execution / error_max_budget_usd）另作处理。

## 后果

- **好处**：三个 Agent 获得 CC 完整能力（实测：pipeline 两步 22 个 LLM 调用、8 次真实 Read/grep 调研后作答）；Hard Rails 经 settingSources 修复后实测守住（未授权 Write/元字符命令/黑名单命令全拦）；kb 工具带归属标注穿透 MCP；`--show-tools`/trace 树零改动可用
- **代价**：成本 5-20×（护栏：maxTurns 15 + budget $0.5）；冷启动 3-12s/轮；SDK 交互封在 claude-code-brain.ts + cc-permissions.ts 两个文件（锁版本 0.3.241）
- **回退**：`--brain=anthropic`（CLI 级）/ 删 agent JSON 的 runtime 字段（配置级），行为与 Phase 8 完全一致

## Future Work

- CC 原生 `agents` 选项（AgentDefinition 子代理）——与本项目"自建多 Agent"哲学的对照实验
- 流式输出（`includePartialMessages` + replyStream 真实现）
- `managedSettings` 强制全量 ask（消灭 CC 内部分类器残余旁路）
- distiller 接 Brain（当前保持裸 Anthropic，第 3 个 LLM 调用点）

## 相关链接

- [Phase 9 文档](../learning-path/phase-09-claude-code-brain.md)
- [ADR-013 Span 树设计](./013-trace-span-tree-als.md)（观测映射的载体）
- [Agent SDK 文档](https://docs.claude.com/en/api/agent-sdk/typescript)
