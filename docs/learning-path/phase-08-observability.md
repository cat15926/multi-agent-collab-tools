# Phase 8 — 可观测性（Observability：Trace / Span 树 / Token 计费 / 回放）

> 路线图要求：结构化日志、trace、token 计费、回放。**验收：一次协作产出完整"轨迹"**。
> 对应第 6 个隐含抽象：**观测平面**——领域平面记录"做了什么"（全文），观测平面记录"何时、多久、花多少"（时序/指标/层级）。

## 🎯 Phase 目标

| Phase 7 结束时 | Phase 8 目标 |
|----------------|--------------|
| "一次协作发生了什么"要翻 4 张表 | `trace show` 一屏瀑布树（含并行结构） |
| LLM token usage 在 3 个调用点全部丢弃 | llm span 全量落盘，stats 按 agent/thread/day 计费 |
| console.log 散落，无级别无结构 | JSONL 结构化日志（stderr 阈值可调，绝不污染 stdout） |
| 无 trace 关联——事件各自为政 | 一个 trace id 贯穿 route→step→agent→llm/tool |

## 📋 验收标准

```bash
# 1. 主验收：一次编排产出完整轨迹（树 + tokens + 成本）
npm run phase8 -- "任务" --pattern=hierarchy --manager=bob --workers=nim,ji-tui
npm run phase8 -- trace show last
# → trace 头（kind/耗时/tokens/成本/状态）+ 瀑布树 + 汇总脚注

# 2. chat + 工具：llm turn 递增、tool span 挂 agent 下
npm run phase8 -- "@bob 读 package.json 并总结"
npm run phase8 -- trace show last
# → agent span 下 turn 1 (tool_use) → tool:read_file → turn 2 (end_turn)

# 3. 计费可对账：stats = llm span 聚合 × pricing.json
npm run phase8 -- stats [--by=agent|thread|day]

# 4. REPL：每轮独立 trace（ALS 隔离）+ /trace /stats 就地回放
npm run phase8   # → /trace · /trace show last · /stats

# 5. 零回归：Phase 7 全部命令行为不变；phase≤07 目录零改动
# 6. 日志：JSONL 每行可 parse；stdout 与日志开关无关
```

## 🏗️ 架构设计

### 双平面（核心分工）

- **观测平面（新）**：`traces` + `spans`——时序/层级/指标 + 200 字 preview + 领域行链接 id
- **领域平面（既有，零改动）**：`tool_calls`/`kb_reads`/`workflow_executions` 照旧存全文

Span 不复制大 payload（OTel 的 attributes + links 思路），`--show-tools` 等旧回放全部不变。

### Span 层级（一次 hierarchy 协作，实测输出）

```
trace (kind=pattern)
├─ 🧭 route（决策：targets/fallback）           ← chat 模式
├─ 🧠 kb（记忆注入：entries/consumer）
├─ 🤖 agent:bob · step 1（manager 分解）
├─ 🤖 agent:nim · step 2（worker，+1.6s）  ┐ 并行：同刻起跑
├─ 🤖 agent:ji-tui · step 3（worker，+1.6s）┘
│  └─ 💬 llm（model/tokens/stop_reason/turn）
│     └─（tool span 亦可挂 agent 下）
└─ 🤖 agent:bob · step 4（manager 汇总）
```

kind 语义：`route` 路由决策 · `kb` 记忆注入 · `step`*（并入 agent attrs）· `agent` 一次 reply · `llm` 一次 messages.create · `tool` 一次工具执行 · `a2a` handoff 一跳 · `distill` 蒸馏。

### 上下文传播：AsyncLocalStorage（正是 OTel Context 的机制）

```
await tracer.run(trace, async () => {          // 建立 {traceId}
  await router.route(...)                       // 内部任意深处：
})                                              // tracer.currentSpan() 取父
```

**不可变上下文**是并行正确性的关键：每开一个 span 派生 `{...ctx, currentSpanId: 新id}`（绝不原地改）→ `Promise.all` 各分支在开 span 那刻各自快照父 id。实测：parallel 两 worker 时间重叠且各挂正确父；REPL 未来并行轮次天然隔离。

三个落盘取舍（详见 ADR-013）：span 结束一次性 INSERT（崩溃丢 in-flight；故 parent_id 不设外键）；token 只存事实、读时乘价（单价更新自动修正历史账单）；Agent 层只发 `onLlmCall` 事件（镜像 onToolCall 先例），事件→span 转换集中在 CLI 工厂。

### 数据模型（2 张新表，毫秒）

```sql
traces(id, kind chat|pattern|distill, entry cli|repl, thread_id, title,
       status running|ok|error, error, started_at, ended_at)
spans(id, trace_id, parent_id→spans.id, kind, name, agent_id,
      status ok|error, error, start_ts, end_ts, duration_ms, attributes JSON)
```

llm span attributes：`model/input_tokens/output_tokens/cache_*/stop_reason/turn`（聚合查询用 `json_extract` 对齐键名）。tool span attributes：`tool_name/status/input_preview/tool_call_id`（链接领域行）。

## 🔬 与 Clowder 对照

| 本项目（学习版） | Clowder（生产） | 差异 |
|------------------|-----------------|------|
| Tracer + ALS（手写 ~200 行） | OpenTelemetry SDK | 学习期不用框架，但机制 1:1 |
| spans 表（SQLite 全量） | LocalTraceStore 环形缓冲 + OTLP 导出 | 学习库全量直写，无采样 |
| Logger（JSONL 按天文件） | pino + RedactingLogProcessor | 无 PII 假名化需求（单机） |
| trace show 瀑布树 | /api/telemetry/traces + Hub UI | CLI 渲染 vs Web |
| pricing.json 读时计价 | burn-rate-monitor | 同为读时计算思想 |

## ✅ 验证记录（2026-08-22 实跑）

| # | 场景 | 结果 |
|---|------|------|
| 1 | hierarchy 主验收：`trace show` 完整树（manager→2 worker 并行同刻起跑→汇总），tokens/成本/耗时齐全 | ✅ 41.6s · $0.194 |
| 2 | chat+工具：`@bob 读 package.json` → turn 1 (tool_use) → tool:read_file ✓ → turn 2 (end_turn)，tool span 带 tool_call_id 链接 | ✅ |
| 3 | stats 对账：SQL 直算 llm span tokens × 单价 = stats 输出（bob 9 次 $0.115，手工核算 $0.114 ✓） | ✅ |
| 4 | REPL 两轮：`/trace` 两条 entry=repl 记录互不串扰（ALS 隔离） | ✅ |
| 5 | parallel：bob(+2ms,2.1s) 与 nim(+12ms,2.0s) 时间重叠（真并行），aggregator 在两者完成后起跑 | ✅ |
| 6 | 回归：--show-tools/--show-memory/threads/kb/--no-memory 零注入全通过；patterns/tools/thread/registry/knowledge-base 与 phase-07 逐字节相同；phase≤07 git 零改动 | ✅ |
| 7 | JSONL 每行可 parse；--verbose 前后 stdout 同形（唯一 diff 是 npm 自身 banner）；stderr debug/info 正常输出 | ✅ |
| 8 | 旧库（有历史数据）直接升级：建表幂等、二次启动无错、旧行不受影响 | ✅ |
| 9 | 冒烟脚本 `npm run smoke8`：嵌套/并行/错误/防御/Logger 13 项 | ✅ 全过 |

**附带成果**：轨迹视图首次显形"实际执行了几个 Agent"，暴露并修复 Phase 7 回归 **P7-001**（pipeline/parallel 的 `--agents=` 被静默忽略，见 ADR-014）——可观测性的直接价值证明。

## 🗄️ 数据库扩展

新增 `traces` + `spans`（毫秒时间戳，显式 Date.now()）。无 ALTER 迁移——既有表零改动，`CREATE TABLE IF NOT EXISTS` 对旧库天然幂等。日志文件：`~/.multi-agent-collab-tools/logs/<YYYY-MM-DD>.jsonl`（与 DB 同级目录）。

## 📁 文件组织

```
src/phase-08-observability/          # = phase-07 拷贝 + 增改
├── observability/                   # ★ 新增
│   ├── tracer.ts                    #   Tracer（ALS 上下文 + runSpan/recordSpan）
│   ├── logger.ts                    #   结构化日志（JSONL + stderr 阈值）
│   ├── pricing.ts                   #   单价表读取 + 读时计价
│   ├── trajectory.ts                #   装配 Span 树 + 瀑布渲染（纯函数）
│   └── smoke.ts                     #   冒烟脚本（npm run smoke8）
├── agent/agent.ts                   # + onLlmCall 事件 + 两调用点计时/usage
├── knowledge/distiller.ts           # + onLlmCall（第 3 个 LLM 调用点）
├── router/index.ts                  # + route/kb/agent span
├── pattern/base.ts                  # + executeAgent 咽喉点 agent span
├── pattern/context.ts               # + tracer?/executionId? 字段
├── orchestrator/index.ts            # + tracer 注入 + kb span + executionId 链接
├── a2a/handler.ts                   # + a2a span（每跳一记）
├── cli.ts                           # + trace/stats 子命令 + 回执行 + 布线
├── repl.ts                          # + 每轮包 trace + /trace /stats
├── runtime.ts                       # + Tracer 构造/注入
└── storage/{schema.sql,sqlite.ts}   # + traces/spans 表 + CRUD + 聚合
config/pricing.json                  # ★ 新增：$/1M tok 单价表
```

零改动：`patterns/*` `tools/*` `thread/*` `registry/*` `knowledge/knowledge-base.ts` `knowledge/types.ts` `a2a/{parser,decider}.ts` `pattern/{result,registry}.ts` 及全部 phase≤07（已 diff 证明）。

## 🔧 实现顺序（实际）

1. 拷贝 + typecheck 基线 → 2. Schema/Storage/聚合 + 旧库幂等 → 3. Tracer(ALS)+Logger+冒烟（发现 parent_id 外键与"子先落盘"冲突，去掉外键）→ 4. onLlmCall 埋点（agent+distiller）→ 5. 布线（入口→router/base/a2a→工厂；发现并修 P7-001）→ 6. pricing+stats → 7. trajectory 装配+渲染 → 8. REPL 集成 → 9. E2E 验收（9 场景全过）→ 10. 文档。

## 🎯 下一步（Phase 9，按需）

Web UI 与产品化（浏览器聊天界面、多线程、@路由、Agent 卡片、轨迹可视化——spans 表已把数据备好）。⚠️ 内核（P1-P8）已稳。

## ⏱️ 时间估算

| 步骤 | 估时 | 实际 |
|------|------|------|
| Schema/Storage | 2.5h | ~2h |
| Tracer+Logger+冒烟 | 3h | ~2.5h（含外键问题修复） |
| LLM 采集 | 2.5h | ~1.5h |
| 布线 | 3.5h | ~3h（含 P7-001 排查修复） |
| pricing+stats | 2h | ~1h |
| trajectory+渲染 | 4h | ~2.5h |
| REPL 集成 | 1.5h | ~1h |
| E2E 验收 | 2.5h | ~2h |
| 文档 | 2.5h | ~1.5h |
| **合计** | **≈26h** | **≈17h** |

## 📚 相关文档

- [ADR-013：Span 树 + ALS 设计](../decisions/013-trace-span-tree-als.md)
- [ADR-014：P7-001 --agents= 回归修复](../decisions/014-fix-p7-001-pattern-agents-flag-ignored.md)
- [Clowder OTel 实现](../../../clowder-ai/packages/api/src/infrastructure/telemetry/)（对照实物）
