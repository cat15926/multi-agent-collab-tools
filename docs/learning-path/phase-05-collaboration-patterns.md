# Phase 5 — 协作模式 Pattern（系统灵魂）

> **这是"真正协作"的抽象层** —— Phase 4 实现了 Agent 间自然的 A2A 协作，Phase 5 将协作模式抽象化，支持可插拔的结构化编排。
>
> **核心目标**：将协作模式抽象为可复用的 Pattern，支持 pipeline/parallel/debate/hierarchy 等模式。
>
> **对应抽象**：⑤ Pattern（协作模式）+ ② Message（结构化传递）+ ③ Router/Orchestrator（编排）

---

## 🎯 Phase 目标

| 功能 | Phase 4 (A2A) | Phase 5 (Pattern) |
|------|--------------|-------------------|
| 协作触发 | Agent 自发 @ | **结构化 Pattern 定义** |
| 协作拓扑 | 动态（Agent 决定） | **静态/半静态（预先定义）** |
| 可预测性 | 低（Agent 随机性） | **高（流程可控）** |
| 可复用性 | 无 | **Pattern 可复用** |
| 球权控制 | Agent @mention 决定 | **Pattern 决定球权流转** |

---

## 📋 验收标准

完成本 Phase 后，以下场景应能运行：

```bash
# 1. 顺序流水线：写代码 → 审查 → 测试
pnpm phase5 "@alice 写个登录函数" --pattern=pipeline --agents=alice,bob,carol
# alice 写代码 → bob 审查 → carol 测试

# 2. 并行多视角：3 个 Agent 各出方案，汇总
pnpm phase5 "设计登录页" --pattern=parallel --agents=alice,bob,carol --aggregator=dave
# alice,bob,carol 并出方案 → dave 汇总决策

# 3. 辩论：A vs B 多轮对抗
pnpm phase5 "这个方案是否可行" --pattern=debate --agents=alice,bob --rounds=3
# alice 和 bob 辩论 3 轮，直到收敛

# 4. 层级分工：Manager 拆任务 → Workers 执行
pnpm phase5 "实现用户系统" --pattern=hierarchy --manager=alice --workers=bob,carol
# alice 分解任务 → bob,carol 并行实现 → alice 汇总

# 5. 查看协作结果（包含中间状态）
pnpm phase5 --thread=xxx --show-workflow
# 显示完整的执行步骤、耗时、成功/失败状态
```

---

## 🏗️ 架构设计

### 核心抽象：Pattern

```ts
interface Pattern {
  name: string;
  description: string;
  execute(context: PatternContext): Promise<PatternResult>;
  validateConfig(config: PatternConfig): ValidationResult;
}
```

**关键设计原则**：
- **可插拔**：同一任务可切换不同 Pattern
- **可复用**：Pattern 定义与具体 Agent 解耦
- **可观测**：每步执行都有详细记录（PatternStep）

### 四种基础 Pattern

| Pattern | 拓扑 | 球权流转 | 典型场景 | 配置参数 |
|---------|------|---------|---------|---------|
| **Pipeline** | A→B→C | 线性传递 | 写代码 → 审查 → 测试 | `agentOrder`, `continueOnError` |
| **Parallel** | A,B,C → Aggregator | 一分多聚 | 多 Agent 各出方案，汇总 | `aggregator`, `awaitAll` |
| **Debate** | A↔B → 收敛 | 往返传递 | 方案 A vs 方案 B 互驳 | `agentA`, `agentB`, `maxRounds` |
| **Hierarchy** | Manager → Workers → Manager | 中心化分发 | 架构师拆需求给开发 Agent | `manager`, `workers` |

### Orchestrator（编排器）

**职责**：
- Pattern 注册和查找
- 执行上下文构建
- 工作流追踪（WorkflowTracker）
- 结果持久化

```ts
class Orchestrator {
  async executePattern(params: {
    patternName: string;
    task: string;
    agents: Agent[];
    threadId: string;
    config?: PatternConfig;
  }): Promise<PatternResult>;
}
```

---

## 🗄️ 数据库扩展

### Phase 5 新增表

```sql
-- workflow_executions 表：Pattern 执行记录
CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  pattern_name TEXT NOT NULL,
  task TEXT NOT NULL,
  agents TEXT NOT NULL,              -- JSON 数组
  status TEXT NOT NULL,              -- pending/running/completed/failed/cancelled
  started_at INTEGER DEFAULT (strftime('%s', 'now')),
  completed_at INTEGER,
  result TEXT,                       -- 元数据 JSON
  error TEXT,
  FOREIGN KEY (thread_id) REFERENCES conversations(id)
);

-- workflow_steps 表：执行步骤记录
CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  input_text TEXT NOT NULL,
  output_text TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  duration INTEGER NOT NULL,          -- 毫秒
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  error TEXT,
  FOREIGN KEY (execution_id) REFERENCES workflow_executions(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

**查询能力**：
- 按会话查询所有 Pattern 执行记录
- 按状态查询（如所有 running 的执行）
- 追踪每个 Pattern 的详细步骤

---

## 📁 文件组织

```
src/phase-05-patterns/
├── cli.ts                        # 入口：支持 --pattern, --agents 等
├── pattern/                      # Pattern 核心抽象
│   ├── base.ts                  # Pattern 接口 + BasePattern
│   ├── context.ts               # PatternContext + PatternConfig
│   ├── result.ts                # PatternResult + PatternStep
│   ├── registry.ts              # PatternRegistry
│   └── index.ts
├── patterns/                     # 具体 Pattern 实现
│   ├── pipeline.ts              # 顺序流水线
│   ├── parallel.ts              # 并行多视角
│   ├── debate.ts                # 辩论
│   ├── hierarchy.ts             # 层级分工
│   └── index.ts
├── orchestrator/                 # 编排器
│   ├── index.ts                 # Orchestrator 主类
│   └── workflow-tracker.ts     # 工作流追踪
├── agent/                        # 复用 Phase 4 Agent
├── router/                       # 复用 Phase 4 Router
├── thread/                       # 复用 Phase 4 Thread
├── registry/                     # 复用 Phase 4 Registry
├── a2a/                          # 复用 Phase 4 A2A
└── storage/
    ├── schema.sql               # 扩展：workflow 表
    └── sqlite.ts                # 扩展：workflow 操作
```

---

## 🔧 实现顺序

### Step 1：核心抽象定义（1 小时）✅
- [x] 定义 `Pattern` 接口
- [x] 定义 `PatternContext` / `PatternResult`
- [x] 实现 `PatternRegistry`
- [x] 编写单元测试

### Step 2：Orchestrator 框架（2 小时）✅
- [x] 实现 `Orchestrator` 主类
- [x] 实现 `WorkflowTracker`
- [x] 集成 Storage（持久化执行记录）
- [x] CLI 基础支持（`--pattern` 参数）

### Step 3：Pipeline Pattern（2 小时）✅
- [x] 实现 `PipelinePattern`
- [x] 支持动态 Agent 列表
- [x] 错误处理（单步失败策略）
- [x] 验收测试

### Step 4：Parallel Pattern（3 小时）✅
- [x] 实现 `ParallelPattern`
- [x] 并行执行引擎（Promise.all）
- [x] 聚合器逻辑（map-reduce）
- [x] 验收测试

### Step 5：Debate Pattern（3 小时）✅
- [x] 实现 `DebatePattern`
- [x] 轮次限制
- [x] 收敛检测（相似度判断）
- [x] 验收测试

### Step 6：Hierarchy Pattern（3 小时）✅
- [x] 实现 `HierarchyPattern`
- [x] 任务分解逻辑
- [x] Worker 分发
- [x] 结果汇总
- [x] 验收测试

### Step 7：CLI 扩展与测试（2 小时）✅
- [x] 完善 CLI 参数（`--agents`, `--aggregator`, `--rounds`, `--manager`, `--workers`）
- [x] `--show-workflow` 选项（显示执行详情）
- [x] 集成测试（所有 Pattern）
- [x] 性能测试

### Step 8：文档与 ADR（1 小时）✅
- [x] 编写 `phase-05-collaboration-patterns.md`
- [ ] ADR-007: Pattern 抽象设计
- [x] 更新 `docs/learning-path/README.md`

---

## 🎯 验收场景

### 场景 1：Pipeline 模式

```bash
$ pnpm phase5 "@alice 写个登录函数" --pattern=pipeline --agents=alice,bob,carol

使用 pipeline 模式执行任务...
会话 ID: 1734982345678
参与 Agent: alice, bob, carol

============================================================
执行结果: 成功
执行步骤: 3
总耗时: 15230ms
============================================================

✓ Step 1: alice (4520ms)

好的，这是登录函数：

```javascript
function login(username, password) {
  // 验证逻辑...
}
```

✓ Step 2: bob (5800ms)

我审查了代码，建议：
1. 添加输入验证
2. 使用 bcrypt 处理密码
3. 添加错误处理

✓ Step 3: carol (4910ms)

基于修改后的代码，我写了以下测试用例...

使用以下命令继续此会话:
  pnpm phase5 "继续" --thread=1734982345678 --pattern=pipeline
```

### 场景 2：Parallel 模式

```bash
$ pnpm phase5 "设计登录页" --pattern=parallel --agents=alice,bob,carol --aggregator=dave

✓ Step 1: alice (4200ms)
✓ Step 2: bob (4100ms)
✓ Step 3: carol (4300ms)
✓ Step 4: dave (3500ms) [Aggregator]

## 汇总结论

综合三位设计师的方案，我建议采用以下设计...
```

### 场景 3：Debate 模式

```bash
$ pnpm phase5 "这个方案是否可行" --pattern=debate --agents=alice,bob --rounds=3

✓ Step 1: alice (3200ms)
✓ Step 2: bob (3400ms)
✓ Step 3: alice (2800ms)
✓ Step 4: bob (3100ms)
✓ Step 5: alice (2500ms)
✓ Step 6: bob (2900ms)

## 辩论总结

双方未达成一致，辩论结束。

### 辩论记录

**方 A 第 1 轮**:
我认为这个方案可行，因为...

**方 B 第 1 轮**:
我不同意，主要风险在于...

...
```

### 场景 4：Hierarchy 模式

```bash
$ pnpm phase5 "实现用户系统" --pattern=hierarchy --manager=alice --workers=bob,carol

✓ Step 1: alice (5200ms) [Manager: 任务分解]
✓ Step 2: bob (6800ms) [Worker: 用户注册]
✓ Step 3: carol (6200ms) [Worker: 用户认证]
✓ Step 4: alice (4100ms) [Manager: 结果汇总]

## 综合结论

用户系统已按计划实现。Bob 完成了注册模块，Carol 完成了认证模块...
```

---

## 🔑 关键设计决策

### 决策 1：Pattern 配置方式

**选择**：CLI 参数

```bash
pnpm phase5 "任务" --pattern=pipeline --agents=alice,bob
```

**理由**：
- 学习项目保持简单
- 避免 YAML/JSON 配置文件的复杂性
- 更容易调试和测试

### 决策 2：错误处理策略

| Pattern | 单步失败时的行为 |
|---------|-----------------|
| Pipeline | `continueOnError=false` 停止；`true` 继续 |
| Parallel | 等待所有完成，标记失败项 |
| Debate | 继续下一轮，记录失败 |
| Hierarchy | 标记任务失败，继续其他任务 |

### 决策 3：与 A2A 的关系

- **兼容**：Pattern 模式下，Phase 4 的 A2A 仍然可用
- **独立**：Pattern 不依赖 A2A，两者是正交的协作方式
- **混合**：可通过 `--a2a-enabled=true` 在 Pattern 中启用 A2A

---

## 📚 相关文档

- [核心抽象：Pattern](../architecture/core-abstractions.md#抽象-5--collaboration-pattern协作模式)
- [核心抽象：Ball Ownership](../architecture/core-abstractions.md#核心概念球权ball-ownership)
- [Phase 4 文档](./phase-04-agent-to-agent-collaboration.md)
- [Phase 6 文档](./phase-06-tools.md)（下一步：工具调用）

---

## 🎯 下一步（Phase 6）

Phase 5 实现了"结构化的协作编排"。

**Phase 6 重点**：给 Agent 装上"手" —— 工具调用（function calling）：
- 文件读写
- 命令执行
- 网络请求
- **安全沙箱**

> 关键区别：
> - Phase 4：A2A 是"自然发生"的（Agent 自发 @）
> - Phase 5：Pattern 是"结构化"的（定义协作拓扑）
> - Phase 6：Tools 是 Agent 的"手"（扩展能力边界）

---

## ⏱️ 时间估算

| 步骤 | 时间 | 累计 |
|------|------|------|
| 核心抽象 | 1h | 1h |
| Orchestrator | 2h | 3h |
| Pipeline | 2h | 5h |
| Parallel | 3h | 8h |
| Debate | 3h | 11h |
| Hierarchy | 3h | 14h |
| CLI + 测试 | 2h | 16h |
| 文档 + ADR | 1h | 17h |

**总计**：约 17 小时（2-3 个工作日）

---

## 🚀 快速验证

```bash
# 1. 类型检查
npm run typecheck

# 2. 列出所有 Pattern
npm run phase5 -- --list-patterns

# 3. 测试 Pipeline 模式
npm run phase5 "@ji-tui 介绍你自己" --pattern=pipeline --agents=ji-tui

# 4. 查看工作流详情
npm run phase5 --thread=xxx --show-workflow
```
