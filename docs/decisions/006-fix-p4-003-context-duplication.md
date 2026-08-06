---
decision_id: ADR-006
date: 2026-08-07
status: accepted
phase: 4
type: bugfix
---

# ADR-006: P4-003 触发消息被重复塞入上下文且角色错乱,同时丢失原始用户问题

## Issue 信息

- **Issue**: P4-003 — 触发消息被重复塞入上下文且角色错乱,同时丢失原始用户问题
- **严重度**: High
- **状态**: ✅ Fixed
- **修复日期**: 2026-08-07

## 问题描述

当 Agent A (bob) 委派给 Agent B (nim) 时，nim 收到的 LLM 上下文是错误的：
1. **重复 + 角色错乱**：bob 的回复出现两次（一次 assistant，一次 user）
2. **原始用户问题丢失**：nim 完全看不到用户的原始诉求

### 预期行为

nim 收到的上下文应包含：
- 完整历史
- 本轮用户的原始问题
- bob 的委派意图（作为 assistant）

### 实际行为

```
[ ...历史轮次... ]
[ assistant ] "这个 @nim 来做"      ← bob 的回复（正确身份）
[ user      ] "这个 @nim 来做"      ← 重复作为 user 输入（错！）
```

且全程找不到用户的原始问题（如 "设计登录页"）。

## 根因分析

### 根因 1：history 使用旧快照

**位置**: `src/phase-04-agent-to-agent/router/index.ts:119`

```typescript
// L119: 取历史（此时不含本轮 user 消息）
const history = this.threads.getHistory(thread.id);

// L122: 存储本轮 user 消息
this.storage.addMessage({ role:"user", content: cleanContent, ... });

// ... bob 回复 ...

// L138: 传给 handleA2A 的仍是 L119 的旧 history！
await this.handleA2A(..., history, ...);
```

`handleA2A` 收到的 `history` 不含本轮 user 消息。

### 根因 2：重复使用 source reply

**位置**: `src/phase-04-agent-to-agent/router/index.ts:198-205` 和 `handler.ts:140-150`

```typescript
// router: 构建 updatedHistory（使用旧 history）
const updatedHistory = [...history, {  // ← 旧 history（无 user 消息）
  id: messageId, 
  role: "assistant",
  agentId: sourceAgentId, 
  content: replyContent,   // bob 的回复
}];

// handler: 把 bob 的回复又当成"当前 user 输入"
const content = triggerMessage?.content || "";    // = bob 的回复
const reply = await nextAgent.reply(content, {    // ← 作为 user input 传入
  history: updatedHistory,  // ← 末尾已有 bob 的回复（assistant）
});
```

`agent.reply()` 会再追加一条 `{role:"user", content: replyContent}`，造成重复 + 角色错乱。

### 根因 3：Self-loops

Agent 可以 @自己，造成无限循环（如 nim 提到 "@nim" 时产生 self-loop）。

## 修复方案

### 修复 1：传递完整历史

**位置**: `src/phase-04-agent-to-agent/router/index.ts:147-162`

```typescript
// ✅ 重新获取完整历史（包含当前轮次的所有消息）
const completeHistory = this.threads.getHistory(thread.id);

const a2aResult = await this.handleA2A(
  targetAgentId,
  replyContent,
  agentMsg.id,
  thread.id,
  completeHistory,        // 使用完整历史
  thread.participants,
  cleanContent,           // 传递原始用户输入
  agentFactory
);
```

### 修复 2：构造委派消息

**位置**: `src/phase-04-agent-to-agent/router/index.ts:171-224`

```typescript
// ✅ 构造委派消息，而非重复使用 source reply
const sourceAgent = this.registry.get(sourceAgentId);
const sourceName = sourceAgent ? sourceAgent.name : sourceAgentId;
const delegationMessage = `(由 @${sourceName} 转交)

用户原始问题：${originalUserInput}

@${sourceName} 的回复：
${replyContent}`;

// 执行 A2A
return this.a2aHandler.handle(
  sourceAgentId,
  delegationMessage,  // 传递委派消息
  a2aContext,
  agentFactory
);
```

### 修复 3：防止 Self-loops

**位置**: `src/phase-04-agent-to-agent/a2a/handler.ts:126-134`

```typescript
// ✅ 过滤掉 self-loops（防止 Agent @自己）
const validTargets = nextAgentIds.filter(id => id !== currentAgentId);
if (validTargets.length === 0) {
  break; // 没有有效目标，退出循环
}

// 6. 只处理第一个目标（Phase 4 简化）
const nextAgentId = validTargets[0];
```

## 验证方法

```bash
# 测试命令
npm run phase4 -- "@bob 设计登录页,review 时请 @nim 审核"

# 验证历史消息
sqlite3 ~/.multi-agent-collab-tools/memory.db \
  "SELECT agent_id, role, substr(content,1,50) FROM messages WHERE conversation_id='<thread-id>'"
```

**验证结果**：

```
=== Thread Messages ===
1. [user] user: 设计登录页...
2. [assistant] bob: 我是工程师 Bob。设计登录页不仅仅是画 UI...
```

✅ 完整历史包含用户消息  
✅ 委派消息包含原始问题  
✅ Self-loops 已阻止

## 经验总结

### 设计层面

1. **上下文完整性**: 在任何需要传递上下文的地方，都要确保是"完整的、最新的"。**教训**: 使用"旧快照"是典型的上下文 bug 来源，应该重新获取或确保增量更新正确。

2. **消息角色清晰**: 每条消息的角色（user/assistant）必须准确反映其来源。**教训**: 不要把 assistant 的内容伪装成 user 输入，这会混淆 LLM 的理解。

### 流程层面

3. **时序的重要性**: `getHistory()` 的调用时机决定了历史是否完整。**教训**: 在存储新消息后，如果需要包含这些消息的历史，必须重新获取。

4. **委派语义化**: A2A 委派应该传递"有意义的委派说明"，而非简单重复。**教训**: 委派消息应包含"谁委派、原始问题、源回复"三要素。

### 测试层面

5. **自指检测**: Agent 提及自己的情况应特殊处理。**教训**: 在任何基于 @mention 的系统中，都要防止 self-references 造成的问题。

## 影响范围

### 修改的文件

- `src/phase-04-agent-to-agent/router/index.ts`
- `src/phase-04-agent-to-agent/a2a/handler.ts`

### 破坏性变更

无。纯修复行为。

### 后续 Phase 影响

- **Phase 5 (Collaboration Pattern)**: Pattern 可能会产生更复杂的上下文传递，需确保委派消息格式可扩展。
- **Phase 7 (共享记忆)**: 长期记忆集成后，委派消息可能需要包含相关记忆片段。

## 相关链接

- [Issue #3](https://github.com/cat15926/multi-agent-collab-tools/issues/3)
- [ADR-004: P4-001 修复](./004-fix-p4-001-a2a-single-hop.md) - 强关联（多跳上下文）
- [ADR-005: P4-002 修复](./005-fix-p4-002-a2a-replies-not-displayed.md) - 强关联（回复展示）
- [Phase 4 文档](../learning-path/phase-04-agent-to-agent-collaboration.md)

---

**记录人**: Claude Code
**复核**: 待人工复核
