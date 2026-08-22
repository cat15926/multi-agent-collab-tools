---
decision_id: ADR-014
date: 2026-08-22
status: accepted
phase: 8
type: bugfix
---

# ADR-014: [P7-001] pipeline/parallel 的 --agents= 被静默忽略（Phase 7 重构回归）

## Issue 信息

- **Issue**: P7-001 — `--pattern=pipeline --agents=A,B` 只跑默认 Agent
- **严重度**: High（CLAUDE.md 记载的标准用法静默失效，无任何报错）
- **状态**: ✅ Fixed（phase-08 内修复；phase-07 目录按"历史 phase 零改动"惯例未回移，待定）
- **修复日期**: 2026-08-22

## 问题描述

Phase 8 跑 `npm run phase8 -- "任务" --pattern=pipeline --agents=bob,ji-tui` 验收时，轨迹（trace show）只出现一个 agent span；`workflow_executions.agents` 为 `["ji-tui"]`（仅默认 Agent）。

### 预期行为

```
参与 Agent: bob, ji-tui      # 两个 Agent 依次执行两个 step
```

### 实际行为

```
参与 Agent: ji-tui           # --agents= 被静默丢弃，只跑默认 Agent，无警告
```

## 根因分析

### 根因 1：共享函数读 `config.agents`，但配置组装从不写入

**位置**: `src/phase-07-knowledge/cli.ts:393`（`runPattern`）与 `buildPatternConfig`（同文件）

```typescript
// runPattern（Phase 7 从 main 里抽出共享化后改读 config）
const cfgAgents = (params.config.agents as string[] | undefined) ?? [];  // ❌ 永远是 undefined
const agentIds = ... : cfgAgents.length > 0 ? cfgAgents : [registry.getDefaultAgentId()...];
// 而 buildPatternConfig 只给 debate（agentA/B）、hierarchy（manager/workers）、
// parallel（aggregator）写字段，从未设置 config.agents
```

Phase 6 的 main 是直接读 `args.agents` 解析的（`phase-06-tools/cli.ts:425`）；Phase 7 抽出 `runPattern` 共享函数时改从 `config` 取，`buildPatternConfig` 没跟上——典型重构半途回归。debate/hierarchy 走 `agentA/B`、`manager/workers` 不受影响，所以 Phase 7 验收没暴露。

**为何 Phase 8 才发现**：轨迹视图第一次把"实际执行了几个 Agent"一屏显形——可观测性的直接收益。

## 修复方案

### 修复 1：buildPatternConfig 统一带上 agents（phase-08）

```typescript
// ✅ src/phase-08-observability/cli.ts buildPatternConfig
// 修复 Phase 7 回归：runPattern 从 config.agents 解析参与 Agent，但此处从未
// 写入 → pipeline/parallel 的 --agents= 被静默忽略、只跑默认 Agent（hierarchy/
// debate 走 manager/workers、agentA/B 不受影响）。统一带上，下游按模式取用。
config.agents = opts.agents;
```

下游消费：pipeline 直接用 `cfgAgents`；parallel 用 `[...cfgAgents, aggregator]`；hierarchy/debate 走自己的字段，多余的 `agents` 字段无副作用。

## 验证方法

```bash
npm run phase8 -- "写一句关于秋天的诗并点评" --pattern=pipeline --agents=bob,ji-tui
# 修复前: 参与 Agent: ji-tui（1 个 step）
# 修复后: 参与 Agent: bob, ji-tui（2 个 step，轨迹树 agent×2 · llm×2）✅

npm run phase8 -- "用一个词形容秋天" --pattern=parallel --agents=bob,nim --aggregator=ji-tui
# 修复后: 参与 Agent: bob, nim, ji-tui，轨迹树两个 worker 时间重叠（并行）✅
```

## 经验总结

### 设计层面

1. **重构挪数据来源时，追到写入端**: 读端从 `args.agents` 改成 `config.agents`，就必须确认写端有人赋值。**教训**: 重构共享函数时，grep 所有消费字段 + 确认每个生产点；"编译通过 + debate/hierarchy 能跑"不等于没回归。

### 流程层面

1. **验收要覆盖每条文档化用法**: CLAUDE.md 里记载的 `--agents=` 标准用法（pipeline/parallel）在 Phase 7 验收时没跑正例。**教训**: 验收清单直接从文档的用法示例生成。

### 测试层面

1. **可观测性是回归的照妖镜**: 此 bug 存活一个 phase，第一次被看见就是在轨迹视图里。**教训**: 关键路径加"结构显形"（谁实际执行了）比加断言更早暴露问题。

## 影响范围

### 修改的文件

- `src/phase-08-observability/cli.ts`（buildPatternConfig +2 行注释 1 行代码）

### 破坏性变更

无（config.agents 是 PatternConfig 的 index-signature 已有字段）。

### 后续 Phase 影响

- **Phase 7**: 目录内仍带此 bug（按"历史 phase 零改动"惯例未回移）。如需回移：同款 1 行改动 + 本文记录。

## 相关链接

- [Phase 8 文档](../learning-path/phase-08-observability.md)
- [ADR-013 Span 树设计](./013-trace-span-tree-als.md)（轨迹视图发现本 bug 的载体）
