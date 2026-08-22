# Phase 7.5 — 交互体验优化（参照 Claude Code）

> **功能面完备 ≠ 好用**。Phase 7 之后 CLI 的能力线（对话/工具/Pattern/知识库）已经齐了，但交互停留在"批处理时代"——用户发出消息后进入黑洞，结果一次性倾泻出来。本篇以 Claude Code 为参照系，逐层对照分析差距，产出可执行的优化清单。
>
> **不是新抽象，是给 Phase 1-7 的成果做"体验硬化"**。不引入框架、不加运行时依赖，全部在现有壳层（REPL/CLI/Agent 回调）内完成。

---

## 🎯 为什么以 Claude Code 为参照

Claude Code 是目前终端 Agent 交互的事实标杆。它的交互好，核心不是某个功能，而是五条可迁移的设计原则：

| # | 原则 | Claude Code 的做法 | 本质 |
|---|------|-------------------|------|
| 1 | **永不黑洞** | 文字流式输出、spinner 显示"正在做什么 + 耗时" | 等待本身要有信息量 |
| 2 | **用户随时掌舵** | Esc 打断当前轮；写/执行操作前交互确认（允许一次/总是/拒绝） | 授权是运行时对话，不是启动时 flag |
| 3 | **输入成本最低化** | `/命令` Tab 补全、`@` 补全、粘贴多行不误触发 | 打字越少，越愿意用 |
| 4 | **渐进式披露** | 工具调用默认折叠一行、verbose 展开、thinking 折叠 | 默认给概览，细节按需看 |
| 5 | **状态永远可见** | prompt 状态栏（模型/目录/分支）、`/context` `/cost` | 系统内部状态投影到界面 |

Phase 7 现状对照：**原则 3、5 部分做到**（斜杠命令体系、`/show memory`、prompt 显示会话 ID），**原则 1、2、4 基本缺失**。

---

## 📋 差距分析（16 项，按层展开）

### 第一梯队：感知层 —— "等待黑洞"问题

**1. 无流式输出**（影响最大）
`agent.ts` 的 `replyStream` 是假的——内部还是 `await reply()` 再一次性 yield；`replyWithTools` 也是非流式 `messages.create`。一次复杂回复（MAX_TOKENS 8192 + 多轮工具循环）用户盯着空白屏 30-60 秒；Pattern 串行 3 步时等待叠加。
→ 方案：`client.messages.stream()`，事件增量解析 text / tool_use block，REPL 打字机渲染。加 `--stream/--no-stream` 开关保留退路。

**2. 工具调用归属不可见**
`cli.ts` 的 `onToolCall` 打印 `🔧 toolName(...)`——没有 agentId。单 Agent 没问题，但 parallel 模式 3 个 Agent 并发时，不知道是谁在读文件、谁被沙箱拦截。多 Agent 是本项目卖点，归属标注是底线 observability。

**3. A2A 跳转无实时输出**
Pattern 有 `onStepStart/onStepComplete` 事件，但普通对话触发的 A2A 委派（`router/index.ts` handleA2A）全程静默，结束后一次性倒出 `a2aReplies`。"谁把球踢给谁"（Ball Ownership）应该在发生时看见。

### 第二梯队：控制层 —— 用户无法掌舵

**4. 无法打断当前轮**
Esc/Ctrl-C 直接杀进程，REPL 上下文丢弃。Claude Code：Esc 中断当前轮、会话继续；Ctrl-C 两段式（第一次清空输入行并提示，第二次才退出）。
→ 方案：Agent 传 `AbortController`，SDK `messages.create({signal})` 原生支持；REPL 捕获 Esc。

**5. 危险操作无运行时授权**
`--allow-write`/`--allow-exec` 是启动时 flag。REPL 场景是明显退化：Agent 想写文件 → 直接被拒，用户得退出重启。Claude Code 模式是工具执行前交互确认：

```
@bob 想执行 write_file("src/x.ts")
  1) 允许一次   2) 本会话总是允许   3) 拒绝
```

→ 方案：`AgentOptions` 加 `onToolConfirm` 回调，`executeTool` 在写/执行类工具前询问；"总是允许"记 session 内存不落盘（Hard Rails：授权不持久化）。与 ADR-012 的 REPL 定位契合。

### 第三梯队：输入层 —— 打字成本

**6. 无 Tab 补全**：`/pattern` `/kb` `@agent` 全靠手打全。readline 原生 completer 即可做两级补全（命令名 / agent id），零风险。

**7. 粘贴多行文本会误触发**：REPL 的 `on("line")` 串行队列下，粘贴带换行的代码/报错 → 每行被当成独立消息依次发给 LLM（各花一次 API 调用）。→ 方案：bracketed paste 识别，粘贴作为整体多行输入。

**8. 未知命令无相似度提示**：只说"未知命令"。加 Levenshtein 距离 ≤2 的 "是不是想输入 /xxx"。

### 第四梯队：可观测层 —— 内部状态投影不足

**9. token/成本不可见**：`response.usage` 被丢弃。每轮显示 `tokens: in/out`，REPL 累计进 `/status`。学习项目额外价值：量化"记忆注入吃掉多少上下文"，让 MEMORY_BUDGET 护栏可验证。

**10. `/show tools` 是逃逸舱口**：REPL 里提示"请退出用 one-shot 命令"，违背 REPL 存在的意义（ADR-012：就地完成）。

**11. prompt 状态栏太薄**：只有 `[会话 xxx] > `。memory/kbwrite 开关直接影响下一句话的行为，应该一眼可见（Claude Code statusline 思路）。

### 第五梯队：会话层 —— 连续性

**12. REPL 无法接续最近会话**：one-shot 有 `--thread=last`，无参启动永远新会话。加 `--continue`（对齐 `claude -c`）。

**13. 会话无标题**：会话列表用最后一条消息前 40 字做预览，多会话后不可扫读。低成本：首条用户消息截断做 title；进阶：distill 时生成。

**14. 退出时不提醒蒸馏**：`/exit` 直接走。REPL 检测会话 >N 轮且未 distill → 提示"本会话尚未提炼"。把 distill 从"要记得用的功能"变成流程的一部分（Claude Code 的 hook 思维）。

### 第六梯队：输出层（可选，建议缓做）

**15. Markdown 渲染/折叠**：Agent 回复是 markdown 但终端裸打；Pattern 中间步全文倾泻。第三方 TUI 库会打破"学习项目零框架"的克制 → 先用 verbosity 开关（`/quiet`）解决 80% 痛点。

**16. API 错误自动重试**：Claude Code 对 429/5xx 带退避重试；现在单次失败放弃本轮。属健壮性，可与 #4 顺带做。

---

## 📊 优先级矩阵与分批计划

| # | 改进 | 交互原则 | 价值 | 工作量 | 批次 |
|---|------|---------|------|--------|------|
| 2 | 工具调用归属标注 | 状态可见 | ★★★★☆ | 极小 | **一** |
| 10 | `/show tools\|workflow` 就地回放 | 状态可见 | ★★★☆☆ | 极小 | **一** |
| 8 | 命令相似度提示 | 输入成本 | ★★☆☆☆ | 极小 | **一** |
| 11 | prompt 状态栏 | 状态可见 | ★★★☆☆ | 小 | **一** |
| 6 | Tab 补全（/命令 + @agent） | 输入成本 | ★★★★☆ | 小 | **一** |
| 4 | Esc 打断 + Ctrl-C 两段式（+16 重试） | 掌舵 | ★★★★★ | 中 | 二 |
| 5 | 工具执行前交互授权 | 掌舵 | ★★★★☆ | 中 | 二 |
| 1 | 流式输出（含工具循环） | 永不黑洞 | ★★★★★ | 大 | 三 |
| 3 | A2A 实时跳转输出 | 永不黑洞 | ★★★☆☆ | 小 | 三（随 #1） |
| 9 | token 统计 /cost | 状态可见 | ★★★☆☆ | 小 | 待排 |
| 12 | REPL --continue | 连续性 | ★★★☆☆ | 小 | 待排 |
| 13/14 | 会话标题 / 退出提醒蒸馏 | 连续性 | ★★☆☆☆ | 小 | 待排 |
| 7 | 粘贴多行安全 | 输入成本 | ★★★★☆ | 中 | 待排 |
| 15 | Markdown/折叠 | 渐进披露 | ★★☆☆☆ | 中 | 缓做 |

**分批理由**：第一批全是 REPL 壳层改动，不碰 LLM 链路，零风险先把"面子"立起来；第二批动 Agent 控制流但接口封闭（AbortSignal / onToolConfirm）；第三批改 LLM 调用方式风险最高，放最后独立验证。

---

## ✅ 执行记录

### 第一批（快赢，REPL 壳层）— ✅ 2026-08-20 完成

改动集中在 `repl.ts`（命令表/补全器/相似度/prompt 状态栏）+ `cli.ts`（归属标注/导出回放函数）。

| # | 改动 | 验证证据 |
|---|------|---------|
| 2 | `onToolCall` 输出加 `@agentId` 归属前缀 | 实跑 `@bob 读 package.json` → `🔧 @bob read_file({"path":"package.json"})`；回放路径本就带归属（bob/ji-tui 并存可见） |
| 10 | 导出 `showToolCalls`/`showWorkflowDetails`，`/show tools\|workflow` 就地回放 | `/thread last` + `/show tools` 就地输出 19 条记录；`/show workflow` 无记录时正确提示 |
| 8 | 未知命令 Levenshtein ≤2 提示 | `/ditsill` → `是不是想输入 /distill？`；`/xyz` 无误报；`/patternx` → `/patterns` |
| 11 | prompt 显示 memory/kbwrite 开关；启动 banner 加沙箱目录 | pty 实测 prompt 渲染 `[新会话 · 记忆on · kbwriteoff] > `；banner 显示 `📁 沙箱目录: …`（顺带修掉硬编码"记忆注入: on"） |
| 6 | readline completer：`/` 前缀补全命令，尾部 `@token` 补全 agent id | pty 实测 `/pa`+Tab → `/pattern`；`@ji-`+Tab → `@ji-tui ` 并成功路由 |

实现要点：`REPL_COMMANDS` 单一数据源服务三个消费者（相似度提示 / Tab 补全 / switch case 对齐）；completer 遵循 readline 协议（completions = 整行候选串 + 尾随空格，第二参 = 当前行）；`makeCompleter(agentIds)` 工厂便于注入注册表。

### 第二批（待做）：Esc 打断 + Ctrl-C 两段式 + API 重试 → 工具执行前交互授权

### 第三批（待做）：流式输出（含工具循环）+ A2A 实时跳转
