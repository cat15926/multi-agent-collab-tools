---
decision_id: ADR-012
date: 2026-08-16
status: accepted
phase: 7
---

# ADR-012：CLI 体验优化 —— 子命令层 + REPL 交互模式

- **状态**：accepted
- **日期**：2026-08-16
- **关联 Phase**：7（落地后追加的使用体验优化）

## 背景

Phase 7 落地后 CLI 膨胀到 30+ 个 flag，使用摩擦集中在：

1. **动词当 flag 用**：`--kb-add= --kb-del=` 语义随上下文漂移（`--type=` 只对 add 有意义却长得像全局参数）
2. **每句话一个进程**：续聊必须抄上一轮 stdout 的 thread ID
3. **线程发现缺口**：`Storage.listConversations()` 存在但 CLI 无入口
4. **无 `--help`**

## 决策

### 1. 三入口共用同一批 op 函数（而非三套实现）

```
旧 flag（--kb-add=…）──┐
kb 子命令（kb add …）──┼─→ opKbAdd/opKbSearch/… （cli.ts 导出）
REPL 斜杠（/kb add …）─┘
```

- 子命令解析**回填同一 `CliArgs` 字段**（`kb add "x" --type=lesson` → `kbAdd="x"; kbType="lesson"`），后续走既有分支——零新增处理层
- 旧 flag 全量保留（历史文档/肌肉记忆零破坏）

### 2. 无参数 → REPL（readline 串行队列）

- **不用 `rl.question()` 循环**：管道输入（`printf | npm run phase7`）时所有行一次到达，question 的 `once('line')` 只接住第一行，后续全丢。改 `on("line")` + 串行 Promise 队列（实测复现并修复）
- thread **懒创建**：首条消息才 `createConversation()`，空退不留脏会话（DB 取证 42→42）
- LLM 报错 catch 打印后继续循环；EOF/Ctrl-D 优雅退出

### 3. 运行时开关（/memory、/kbwrite）= Runtime.rebuild()

- 新建 `runtime.ts`：Router/Orchestrator/ToolRegistry 均无状态，toggle 时按当前开关重建（毫秒级），不做更细粒度注入
- **`globalKb` 反面教训**：原 `runDistill` 依赖模块级 `globalKb`（仅 one-shot main() 赋值），REPL 路径不经过 main() → 空引用 → distill 静默 error（实测复现）。修复：**kb 显式传参，全局量删除**。教训与 ADR-011 的"注入必须可证明"同源——隐性依赖在多入口下必坏

### 4. 零 schema 变更、phase≤06 零触碰

纯 CLI 层改动。`conversations` 表秒级时间戳是历史遗留，渲染层 ×1000，不改表。

## 验证（2026-08-16 实跑）

| 项 | 结果 |
|---|---|
| 旧 flag 回归（--kb-list/--kb-search/--list-agents/--show-memory） | ✅ 输出与改前一致 |
| 子命令全量（add/search/list/stats/del/verify/distill + threads + help） | ✅ CRUD 闭环（临时条目验后删） |
| `--thread=last` / `kb distill last` / `/thread last` | ✅（发现并修复 distill 分支在 last 解析前消费的 bug） |
| REPL 连续 2 轮同会话 | ✅ DB 取证 4 条消息同一 conv |
| REPL 注入链 | ✅ 🧠 行 + kb_reads 落盘 + bob 引用教训 |
| `/memory off` | ✅ 0 行 🧠、kb_reads 计数不变（真零查询） |
| `/kbwrite on` | ✅ kb_write 落 tool_calls，source_agent=bob |
| REPL `/distill` | ✅ 提炼 1 条 + 重跑幂等（globalKb bug 修复后） |
| `/pattern pipeline` 一次性 | ✅ 2 步成功 |
| 空退不留会话 | ✅ conversations 42→42 |
| DB 取证 | ✅ 零新表零 schema 变更；phase≤06 零触碰 |

## 后果

- **好处**：连续对话免抄 thread ID（最大摩擦消除）；知识库操作可读；REPL 成为后续 Phase 8 可观测性的天然宿主（/show 系列可扩展）
- **代价**：cli.ts 承担 op 库职责（~1100 行）；子命令保留字 `kb`/`threads`/`help` 不可作为聊天首词（`kb search 好用吗` 会被当检索——返回"未找到"自解释，接受）
- **已知局限**：REPL `/pattern` 是一次性执行，不驻留模式状态机（复杂化不值得；连续编排用 one-shot）

## Related

- [Phase 7 文档](../learning-path/phase-07-shared-memory.md)（CLI 优化节）
- [ADR-011](./011-knowledge-base-design.md)（KB 本体设计；globalKb 教训同源于其"可证明性"原则）
