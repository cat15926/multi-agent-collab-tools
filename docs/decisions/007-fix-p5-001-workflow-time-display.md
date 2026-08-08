---
decision_id: ADR-007
date: 2026-08-08
status: accepted
phase: 5
type: bugfix
---

# ADR-007: P5-001 — `--show-workflow` 时间显示错乱（未来日期 + 耗时单位错误）

## Issue 信息

- **Issue**: P5-001 — `--show-workflow` 显示荒诞未来日期，且耗时单位标错
- **严重度**: Low（纯 CLI 展示层，不影响 Pattern 执行与持久化数据）
- **状态**: ✅ Fixed
- **修复日期**: 2026-08-08

## 问题描述

`phase5 --thread=<id> --show-workflow` 读回持久化的 workflow 执行记录时，时间字段完全错乱。这是 Phase 5 端到端验收（pipeline / parallel 实跑 + 读回）时发现。

### 预期行为

```
开始时间: 2026/8/8 下午2:16:40
完成时间: 2026/8/8 下午2:16:48
耗时: 8110ms
```

### 实际行为

```
开始时间: 58569/12/26 05:59:15
完成时间: 58569/12/26 08:14:25
耗时: 8110 秒
```

## 根因分析

### 根因 1：毫秒时间戳被当成秒，又 ×1000

**位置**: `src/phase-05-patterns/cli.ts:201,203`

```typescript
// ❌ 问题代码
new Date(execution.startedAt * 1000).toLocaleString()
new Date(execution.completedAt * 1000).toLocaleString()
```

`WorkflowTracker` 用 `Date.now()` 写入 `startedAt` / `completedAt`（`workflow-tracker.ts:72,86,97`），而 `Date.now()` 返回的是**毫秒**时间戳。`new Date(ms)` 本身就以毫秒为输入，再 `× 1000` 等于把毫秒值放大 1000 倍 → 时间戳跑到几万年后（显示为 58569 年）。

存储侧读回的也是毫秒（耗时差值 8110 与执行步骤里的 `8110ms` 完全吻合可证），所以数据正确，纯粹是显示层多乘了一次 1000。

### 根因 2：耗时单位标注错误

**位置**: `src/phase-05-patterns/cli.ts:204`

```typescript
// ❌ 问题代码
console.log(`耗时: ${execution.completedAt - execution.startedAt} 秒`);
```

`completedAt - startedAt` 是两个毫秒时间戳之差，结果单位是**毫秒**，却被标成"秒"。

## 修复方案

### 修复 1：去掉多余的 `× 1000`

```typescript
// ✅ 修复代码
new Date(execution.startedAt).toLocaleString()
new Date(execution.completedAt).toLocaleString()
```

### 修复 2：耗时单位改为 `ms`

```typescript
// ✅ 修复代码（与执行步骤里的 `${step.duration}ms` 单位一致）
console.log(`耗时: ${execution.completedAt - execution.startedAt}ms`);
```

## 验证方法

```bash
# 1. 跑一个 pattern 产生执行记录
npm run phase5 -- "用一句话说说你是谁" --pattern=pipeline --agents=bob,ji-tui

# 2. 读回（用上一步输出的会话 ID）
npm run phase5 -- --thread=<id> --show-workflow
```

**修复后预期输出**：

```
状态: completed
开始时间: 2026/8/8 下午2:16:40      ← 正常的本年日期
完成时间: 2026/8/8 下午2:16:48
耗时: 8110ms                         ← 毫秒，与步骤耗时一致
执行步骤:
  ✓ Step 1: bob (2318ms)
  ✓ Step 2: ji-tui (5792ms)
```

## 经验总结

### 设计层面

1. **时间戳单位契约**: Unix 时间戳有「秒」和「毫秒」两种约定，极易混淆。JS 侧 `Date.now()` / `new Date()` 是**毫秒**，而 SQL 侧 `strftime('%s','now')` 是**秒**。两者混用时必须在边界显式转换。**教训**: 时间戳字段应在类型名或注释里标注单位（如 `startedAtMs`），并在「写入存储 / 读出存储」的边界做一次显式归一。

2. **次要隐患（本次未改）**: `workflow_executions` 表 schema 的 `started_at INTEGER DEFAULT (strftime('%s','now'))` 默认值是**秒**级，但实际 INSERT 始终用毫秒覆盖了默认值。当前所有代码路径都显式传值，故无碍；但一旦未来某条路径遗漏传值，就会混入秒级数据。**建议**: 后续将 schema DEFAULT 改为 `(strftime('%s','now') * 1000)`，或在 Storage 层统一为毫秒。

### 测试层面

1. **展示层必须端到端验证**: `tsc --noEmit` 和 `--list-*` 命令无法发现此类显示 bug；必须真实跑出数据再 `--show-workflow` 读回、用肉眼校验数值合理性。**教训**: 凡涉及「持久化读回后展示」的逻辑，验收脚本应包含「写入 → 读回 → 断言数值落在合理区间」一步——例如断言 `开始时间 ∈ [现在-1h, 现在+1h]`，能把"时间戳放大 1000 倍"这类错误立刻暴露。

## 影响范围

### 修改的文件

- `src/phase-05-patterns/cli.ts`（`showWorkflowDetails`，3 行）

### 破坏性变更

无。仅 CLI 展示层文字变更，不改数据格式、不改接口。

### 后续 Phase 影响

- **Phase 8（可观测性）**: 将重用 workflow 执行记录做 trace/回放，需沿用同一套「毫秒」单位契约，避免重蹈覆辙。

## 相关链接

- [Phase 5 文档](../learning-path/phase-05-collaboration-patterns.md)
- [ADR-003 SQLite 存储架构](./003-sqlite-schema.md)（存储 schema，涉及其中的时间戳约定）

---

**记录人**: Claude Code（Phase 5 验收测试）
**复核**: ⬜ 待人工复核
