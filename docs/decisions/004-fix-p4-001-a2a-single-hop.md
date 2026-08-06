---
decision_id: ADR-004
date: 2026-08-07
status: accepted
phase: 4
type: bugfix
---

# ADR-004: P4-001 A2A 协作只能单跳问题修复

## Issue 信息

- **Issue**: P4-001 — A2A 协作只能单跳, maxDepth 形同虚设
- **严重度**: Critical
- **状态**: ✅ Fixed
- **修复日期**: 2026-08-07

## 问题描述

A2A（Agent-to-Agent）协作的核心价值是多 Agent 链式协作（`a → b → c`），但当前实现只能完成单跳（`a → b`）就停止。`maxDepth` 配置（默认 5）形同虚设，路线图描述的 "alice 写完代码 → 自动请 bob review → bob 找 ji-tui 确认" 无法实现。

### 预期行为

```
用户 → @bob → @nim → @ji-tui（最多 maxDepth 跳）
```

### 实际行为

```
用户 → @bob → @nim（永远只有一跳）
```

## 根因分析

### 根因 1：参数类型错误（Critical）

**位置**: `src/phase-04-agent-to-agent/router/index.ts:205-207`

```typescript
// ❌ 错误：传入 parseResult (对象) 而非 replyContent (字符串)
return this.a2aHandler.handle(
  sourceAgentId,
  parseResult,           // ← Bug: 应该是 replyContent
  a2aContext,
  agentFactory
);
```

`A2AHandler.handle()` 签名期望 `sourceReply: string`，但收到的是 `parseResult: A2AParseResult`（对象）。当 Handler 内部调用 `this.a2aParser.parse(currentReply, this.availableIds)` 时，解析一个对象会失败或产生错误结果。

### 根因 2：RouteResult 接口不完整

**位置**: `src/phase-04-agent-to-agent/router/index.ts:27-43`

`RouteResult` 接口缺少 `a2aReplies` 字段，但代码中使用该字段（line 164），导致类型错误。

### 根因 3：depth 硬编码

**位置**: `src/phase-04-agent-to-agent/router/index.ts:197`

```typescript
const a2aContext = {
  threadId,
  sourceAgentId,
  triggerMessageId: messageId,
  depth: 1,  // ← 硬编码，不符合可配置原则
  history: updatedHistory,
  participants,
};
```

### 根因 4：缺少枚举导入

**位置**: `src/phase-04-agent-to-agent/a2a/handler.ts:16`

缺少 `A2ADecision` 枚举的导入，导致 TypeScript 编译错误。

## 修复方案

### 修复 1：参数类型修正

```typescript
// src/phase-04-agent-to-agent/router/index.ts:203-208
return this.a2aHandler.handle(
  sourceAgentId,
  replyContent,              // ✅ 修复：传入字符串
  a2aContext,
  agentFactory
);
```

### 修复 2：补全 RouteResult 接口

```typescript
export interface RouteResult {
  content: string;
  agentId: string;
  threadId: string;
  hasMention: boolean;
  a2aTriggered?: boolean;
  a2aChains?: {
    sourceAgentId: string;
    targetAgentId: string;
  }[];
  a2aReplies?: {             // ✅ 新增
    agentId: string;
    content: string;
  }[];
}
```

### 修复 3：depth 可配置化

```typescript
// RouterOptions 新增字段
export interface RouterOptions {
  a2a?: A2AConfig;
  initialDepth?: number;      // ✅ 新增
}

// 构造函数中初始化
constructor(...) {
  this.initialDepth = options.initialDepth ?? 1;
  // ...
}

// 使用可配置 depth
const a2aContext = {
  // ...
  depth: this.initialDepth,  // ✅ 使用配置
  // ...
};
```

### 修复 4：添加枚举导入

```typescript
// src/phase-04-agent-to-agent/a2a/handler.ts:16
import { A2ADecider, A2ADecision } from "./decider.js";
```

### 修复 5：返回类型统一

```typescript
// handleA2A 提前返回时也返回完整类型
if (!parseResult.shouldTrigger || parseResult.mentions.length === 0) {
  return {
    continued: false,
    hopsCompleted: 0,
    chains: [],
    replies: [],
    finalDecision: {
      decision: A2ADecision.STOP,
      reason: "没有检测到有效的 A2A 触发条件",
    },
  };
}
```

## 验证方法

```bash
# 测试多跳 A2A 协作
npm run phase4 -- "@bob 设计登录页,review 时请 @nim 审核,nim 审核后 @ji-tui 确认"

# 检查协作链
npm run phase4 -- --chain --thread=<thread-id>

# 检查数据库（应有 4 条消息：user + bob + nim + ji-tui）
sqlite3 ~/.multi-agent-collab-tools/memory.db \
  "SELECT agent_id, a2a_source FROM messages WHERE conversation_id='<thread-id>'"
```

**验证结果**：

```
协作链 (thread-1786034629721-jyi4d2q):
  • 👨‍💻 工程师 Bob → 🐟 阿 Nim
  • 🐟 阿 Nim → 🍗 鸡腿

| agent_id | a2a_source | content_preview |
|----------|------------|-----------------|
| (user)   | -          | 设计登录页...   |
| bob      | -          | 收到。作为登录页... |
| nim      | bob        | 哼，睇完啦... |
| ji-tui   | nim        | 哇哦，这就把锅甩给我啦？🍗... |
```

## 经验总结

### 设计层面

1. **类型安全的重要性**: 参数类型错误在编译时应被捕获，这里因为 JavaScript 运行时特性掩盖了问题。**教训**: 使用 TypeScript 时要充分利用类型系统，避免 `any`。

2. **接口完整性**: 定义接口时要考虑所有使用场景。`RouteResult` 缺少字段导致类型检查失败。**教训**: 接口定义和使用要同步更新。

3. **可配置性原则**: 硬编码的 magic number（`depth: 1`）违反了可配置原则。**教训**: 所有可能需要调整的参数都应可配置。

### 流程层面

4. **Issue 复现的关键性**: 通过复现步骤快速定位问题，避免盲目修复。**教训**: 修复前必须能稳定复现。

5. **数据库作为真相源**: 通过查询数据库验证实际行为，比仅看输出更可靠。**教训**: 多层次验证（输出 + 数据库 + 日志）。

### 测试层面

6. **多跳场景测试不足**: Phase 4 缺少针对多跳 A2A 的测试用例，导致问题未在开发阶段发现。**教训**: 核心功能需要覆盖边界情况（多跳、循环、中断）。

7. **LLM 行为的不确定性**: Agent 是否 @mention 取决于 LLM 的自主行为，不是固定流程。**教训**: A2A 基于 @mention，不保证固定流程；如需固定流程应使用 Phase 5 的 Pattern。

## 影响范围

### 修改的文件

- `src/phase-04-agent-to-agent/router/index.ts`
- `src/phase-04-agent-to-agent/a2a/handler.ts`

### 破坏性变更

无。修复向后兼容。

### 后续 Phase 影响

- **Phase 5 (Collaboration Pattern)**: 本次修复为多跳协作奠定基础，Pattern 可以基于此构建更复杂的协作模式。
- **Phase 6 (Tools)**: Agent 调用工具后可能触发 A2A，需要确保多跳场景下工具调用顺序正确。

## 相关链接

- [Issue #1](https://github.com/cat15926/multi-agent-collab-tools/issues/1)
- [Phase 4 文档](../learning-path/phase-04-agent-to-agent-collaboration.md)
- [核心抽象文档](../architecture/core-abstractions.md)

---

**记录人**: Claude Code
**复核**: 待人工复核
