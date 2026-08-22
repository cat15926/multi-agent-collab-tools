# ADR-013：可观测性 = 完整 Span 树 + AsyncLocalStorage 传播（mini-OTel）

- **状态**：accepted
- **日期**：2026-08-22
- **关联 Phase**：P8

## 背景

Phase 7 收官时的问题："一次协作发生了什么"要分别翻 `workflow_steps` / `tool_calls` / `kb_reads` 四张表，没有统一时间线；LLM 调用的 token usage 在三个调用点（`agent.ts` 两处 + `distiller.ts`）全部被丢弃，无法计费；日志是散落的 console.log。Phase 8 路线图要求：结构化日志、trace、token 计费、回放，验收 = "一次协作产出完整轨迹"。

两个核心设计选择：**trace 数据怎么存**、**trace 上下文怎么流**。

## 考虑过的方案

### 数据模型

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 关联模型：既有表加 trace_id + 新 llm_calls，UNION 装配 | 侵入最小，埋点复用 | 要 ALTER 四张表；"装配"逻辑分散；学不到 span 层级 |
| B. 事件溯源：单一 append-only trace_events 表 | 概念纯粹，写入路径统一 | 既有落盘要么双写要么弃用；token 聚合在 JSON 里挖，SQL 不友好 |
| **C. 完整 Span 树：traces + spans（parent_id 自引用）** | **1:1 对齐 OTel，概念可迁移到 Clowder 生产实现** | 树装配/渲染复杂度最高；层级与既有表部分重复 |

### 上下文传播

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A. AsyncLocalStorage（ALS）** | **零签名穿透（reply 等 4 处稳定接口零改动）；正是 OTel Context Propagation 的底层机制；并行分支天然隔离** | "魔法感"强，需讲透 |
| B. 显式参数透传 | 数据流全程可见，教学直白 | ~8 处接口签名要改；pattern/a2a 链路逐层穿参 |

## 决策

**数据模型选 C（Span 树），传播选 A（ALS）**——mini-OTel 路线。理由：学习项目的目标是概念可迁移（左手指 Clowder 的 OTel 实现，右手写简化版），Span/trace/context 是工业标准词汇，值得按原样学一遍。

### 关键机制：不可变上下文

ALS 上下文 `{ traceId, currentSpanId }` **绝不原地修改**——每开一个 span 就派生新对象（`{ ...ctx, currentSpanId: 新id }`）并用 `als.run` 为子调用树建立。这是并行正确性的关键：`Promise.all` 扇出时各分支在开 span 那一刻各自快照父 id，互不串扰。验证：parallel 模式 bob(+2ms) 与 nim(+12ms) 时间重叠且各挂 trace 根；hierarchy 两个 worker 同刻 +1.6s 起跑。（如果用可变栈 push/pop，分支 A 的子 span 可能挂到分支 B 的 span 上——这是 ALS 的经典陷阱。）

### 双平面分工

- **观测平面（新）**：`traces` + `spans` 只存时序/层级/指标（tokens、延迟、状态）+ 小 preview（截 200）+ 领域行链接 id（如 `tool_call_id`）
- **领域平面（既有，零改动）**：`tool_calls` / `kb_reads` / `workflow_executions` 照旧存完整 input/output——Phase 6/7 的 `--show-*` 全部不变

这是 OTel 的做法（span attributes + links，payload 留在业务存储），也保证了 phase≤07 零回归。

### 三个实现取舍

1. **span 结束时一次性 INSERT**（而非开始 insert + 结束 update）：崩溃丢 in-flight span，换写入减半 + duration 落盘即算。副作用：子 span 先于父落盘 → **spans.parent_id 不能设外键**（立即检查必失败），树完整性由 Tracer 生成/引用 id 保证。
2. **落库只存 token 事实，读时乘单价**（config/pricing.json，$/1M tok）：单价更新自动修正历史账单；未知模型成本显示 `?`（relay 模型 usage 可能缺，不猜）。
3. **Agent 不依赖观测层**：`onLlmCall` 事件镜像 Phase 6 的 `onToolCall` 先例，事件→span 的转换集中在 CLI 工厂（`makeAgentOptionsFactory`）。回调在包裹作用域内触发，ALS 保证 recordSpan 挂到正确父 span。

## 与 OTel / Clowder 的概念映射

| 本项目 | OTel / Clowder | 备注 |
|--------|----------------|------|
| `traces` 行 | Trace | 一次协作的根 |
| `spans` 行（parent_id 成树） | Span | kind: route/kb/step/agent/llm/tool/a2a/distill |
| ALS `{traceId, currentSpanId}` | Context Propagation | OTel 用同一机制（Node ALS） |
| `attributes` JSON | Span attributes | tokens/model/stop_reason/preview/链接 id |
| span kind | SpanKind | 本项目按领域动作分，非 OTel 标准枚举 |
| 未做：Sampler / Exporter / 采样率 | OTel 采集管线 | 学习项目全量采集，直写 SQLite |
| 未做：HMAC 假名化（Clowder） | 隐私 | 单机学习库无此需求 |

## 后果

- **好处**：`trace show` 一屏看清一次协作（含并行结构、token/成本、失败点）；token 计费可对账（stats = llm span 聚合 × 单价，已验收核对）；REPL 未来并行轮次天然隔离（ALS 正确性红利）
- **代价**：spans 表与 workflow_steps 层级信息部分重复（领域行是全文，span 是时序——分工明确故可接受）；崩溃丢未完成 span（trace 状态会停在 running，可辨识）
- **约束**：埋点新增动作须在 SpanKind 枚举内；大 payload 永远不进 spans（走领域表）；日志（JSONL）定位排障、轨迹定位审计回放，两者不混
