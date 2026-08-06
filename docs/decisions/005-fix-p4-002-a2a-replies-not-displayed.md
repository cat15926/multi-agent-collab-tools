---
decision_id: ADR-005
date: 2026-08-07
status: accepted
phase: 4
type: bugfix
---

# ADR-005: P4-002 被委派 Agent 的回复不返回/不打印给用户

## Issue 信息

- **Issue**: P4-002 — 被委派 Agent 的回复不返回/不打印给用户
- **严重度**: High
- **状态**: ✅ Fixed
- **修复日期**: 2026-08-07

## 问题描述

用户触发 A2A 协作后，最想知道的是"被委派者（如 nim）到底回答了什么"，但 CLI 只显示发起者（如 bob）的回复，被委派者的回复被静默吞掉。

### 预期行为

```
👨‍💻 工程师 Bob:
[Bob 的回复...]

🔄 A2A 协作:
  • 工程师 Bob → 阿 Nim

  ↪️ 🐟 阿 Nim:
  [Nim 的完整回复...]
(A2A 模式: auto)
```

### 实际行为

```
👨‍💻 工程师 Bob:
[Bob 的回复...]

🔄 A2A 协作:
  • 工程师 Bob → 阿 Nim
(A2A 模式: auto)
```

用户看不到 Nim 的实际回复内容，只能事后查询数据库。

## 根因分析

### 根因 1：CLI 未打印 a2aReplies

**位置**: `src/phase-04-agent-to-agent/cli.ts:174-183`

CLI 只打印了协作链关系（`a2aChains`），但没有打印 `a2aReplies` 字段。

```typescript
// ❌ 问题代码：只打印关系，不打印内容
if (result.a2aTriggered && result.a2aChains && result.a2aChains.length > 0) {
  console.log("\n🔄 A2A 协作:");
  for (const chain of result.a2aChains) {
    console.log(`  • ${sourceName} → ${targetName}`);
  }
}
// ← 缺少：没有打印 result.a2aReplies
```

### 根因 2：数据流已通但未展示

P4-001 修复时已经完成了数据收集：
- ✅ `A2AResult.replies` 字段已添加
- ✅ `RouteResult.a2aReplies` 字段已添加
- ✅ Handler 已收集每跳回复

但缺少最后一步：CLI 展示。

## 修复方案

### 修复：CLI 打印每跳回复

**位置**: `src/phase-04-agent-to-agent/cli.ts:174-183`

```typescript
// ✅ 修复代码：打印关系 + 打印内容
if (result.a2aTriggered && result.a2aChains && result.a2aChains.length > 0) {
  console.log("\n🔄 A2A 协作:");
  for (const chain of result.a2aChains) {
    const source = registry.get(chain.sourceAgentId);
    const target = registry.get(chain.targetAgentId);
    const sourceName = source ? source.name : chain.sourceAgentId;
    const targetName = target ? target.name : chain.targetAgentId;
    console.log(`  • ${sourceName} → ${targetName}`);
  }

  // 打印每跳 Agent 的回复（P4-002 修复）
  if (result.a2aReplies && result.a2aReplies.length > 0) {
    for (const reply of result.a2aReplies) {
      const agentConfig = registry.get(reply.agentId);
      const emoji = agentConfig?.emoji ?? "🤖";
      const name = agentConfig?.name ?? reply.agentId;
      console.log(`\n  ↪️ ${emoji} ${name}:`);
      // 缩进打印回复内容
      const indentedContent = reply.content.split('\n').map(line => `  ${line}`).join('\n');
      console.log(indentedContent);
    }
  }
}
```

### 设计决策

1. **缩进显示**: 使用 ↪️ 箭头 + 2 空格缩进，清晰展示委派关系
2. **完整内容**: 打印每跳的完整回复，不截断
3. **格式保持**: 保留原始换行，便于阅读代码或长回复

## 验证方法

```bash
# 测试命令
npm run phase4 -- "@bob 设计登录页,review 时请 @nim 审核"

# 验证数据库（应有 3 条消息）
sqlite3 ~/.multi-agent-collab-tools/memory.db \
  "SELECT agent_id, length(content) FROM messages WHERE conversation_id='<thread-id>'"
```

**验证结果**：

```
| agent_id | content_length |
|----------|----------------|
| (user)   | 23             |
| bob      | 5836           |
| nim      | 3308           |
```

CLI 输出正确显示 Nim 的完整回复（3308 字符）。

## 经验总结

### 设计层面

1. **完整的数据流**: 修复 P4-001 时已经考虑了数据收集（`a2aReplies`），这体现了"面向终态"的设计思维。**教训**: 修复一个问题时要考虑相关的用户场景，避免遗漏。

2. **展示层与数据层分离**: 数据已存在于数据库，但 CLI 未展示。**教训**: 数据存储 ≠ 用户可见，要确保展示层与数据层同步。

### 流程层面

3. **关联问题的同步修复**: P4-002 与 P4-001 强相关（多跳必然需要展示每跳回复）。**教训**: 修复时要检查是否有相关联的问题，避免分多次提交。

4. **用户体验的完整性**: 用户最关心的是"结果"，而不只是"过程"。**教训**: 协作链是过程，回复内容是结果，两者都要展示。

### 测试层面

5. **端到端测试的必要性**: 单元测试可能覆盖数据收集，但无法发现 CLI 展示问题。**教训**: 关键用户场景需要端到端验证。

## 影响范围

### 修改的文件

- `src/phase-04-agent-to-agent/cli.ts`

### 破坏性变更

无。纯新增功能。

### 后续 Phase 影响

- **Phase 5 (Collaboration Pattern)**: Pattern 可能会产生更复杂的协作结构，CLI 展示需要考虑如何清晰呈现。
- **Phase 6 (Tools)**: Agent 调用工具的输出也可能需要在 A2A 回复中展示。

## 相关链接

- [Issue #2](https://github.com/cat15926/multi-agent-collab-tools/issues/2)
- [ADR-004: P4-001 修复](./004-fix-p4-001-a2a-single-hop.md) - 强关联
- [Phase 4 文档](../learning-path/phase-04-agent-to-agent-collaboration.md)

---

**记录人**: Claude Code
**复核**: 待人工复核
