---
decision_id: ADR-008
date: 2026-08-15
status: accepted
phase: 3-6
type: bugfix
---

# ADR-008: P4-004 发言者归属不进入 LLM 上下文(归属感丢失)

## Issue 信息

- **Issue**: [P4-004](https://github.com/cat15926/multi-agent-collab-tools/issues/4) — `agentId`/`a2aSource` 不进入 LLM 上下文(归属感丢失)
- **严重度**: 🟡 Medium
- **状态**: ✅ Fixed
- **修复日期**: 2026-08-15

## 问题描述

数据层从 Phase 4 起就存好了每条 assistant 消息的归属(`agentId` + `a2aSource`),但 `Agent.reply()` 拼接 LLM messages 时只投影了 `role` + `content` 两个字段,把归属全丢了。

多 Agent 会话里,每个 Agent 看到的历史是"匿名"的——分不清哪条 assistant 消息是自己说的、哪条是别的 Agent 说的。A2A 越多跳,语义越混乱(Agent 会把别人的发言当成自己说的)。

附带风险:Anthropic Messages API 要求 user/assistant **严格交替**。当前每轮恰好单 Agent 发言维持交替;一旦出现连续多 Agent 发言(A2A 多跳),两条相邻 `assistant` 会被 API 直接拒绝(400)。

### 预期行为

```
[bob 的视角]
[assistant] "[bob]: TypeScript + Node 24..."    ← 自己说的(无前缀)
[assistant] "[nim]: 系啊,佢讲得啱..."            ← 别人说的(带 [id]: 前缀)
```

### 实际行为(修复前)

```
[bob 的视角]
[assistant] "TypeScript + Node 24..."           ← 到底谁说的?
[assistant] "系啊,佢讲得啱..."                    ← 到底谁说的?
```

## 根因分析

### 根因 1:消息投影只取 2 个字段

**位置**: `src/phase-04-agent-to-agent/agent/agent.ts:57-60`(P3/P5/P6 同构)

```typescript
// ❌ 问题代码
messages: [
  ...contextMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,        // ← 只投影 role + content
  })),                          // ← agentId / a2aSource 全部丢弃
```

`Message` 接口里 `agentId`/`a2aSource` 齐全(`sqlite.ts`),`getMessages` 也返回,唯独在"拼 prompt 的最后一公里"被丢弃。

### 根因 2:A2A 多跳时委派内容匿名传入

**位置**: `src/phase-04-agent-to-agent/a2a/handler.ts:160`(P5/P6 同构)

```typescript
// ❌ 问题代码
const agentReply = await nextAgent.reply(currentReply, { ... });
// currentReply 是上一跳 Agent 的回复,但没有任何"这是 @xxx 说的"标注
```

首跳由 router 构造带归属的委派消息(P4-003 已修),但第二跳起 handler 直接把上一跳回复匿名塞给下一跳 Agent——归属丢失的另一半。

### 根因 3:相邻同角色消息不满足 API 交替约束

多 Agent 连续发言(A2A 多跳后完全可能)会产生相邻 `assistant` 消息,Anthropic API 要求 user/assistant 严格交替,直接发送会被 400 拒绝。这是 Issue 指出的"定时炸弹"。

## 修复方案

三处修复,跨 Phase 同步(P3/P4/P5/P6 保持一致):

### 修复 1:发言者前缀 + 相邻合并(toLlmMessages)

```typescript
// ✅ 修复代码(四个 Phase 的 agent.ts 同构)
private toLlmMessages(messages: Message[]): { role: "user" | "assistant"; content: string }[] {
  return messages.reduce<{ role: "user" | "assistant"; content: string }[]>((acc, m) => {
    let content = m.content;
    if (m.role === "assistant" && m.agentId && m.agentId !== this.id) {
      content = `[${m.agentId}]: ${m.content}`;  // 别人说的 → 加前缀
    }
    const prev = acc[acc.length - 1];
    if (prev && prev.role === m.role) {
      prev.content += `\n\n${content}`;  // 相邻同角色 → 合并(满足 API 交替)
    } else {
      acc.push({ role: m.role, content });
    }
    return acc;
  }, []);
}
```

设计取舍:自己的话**不加** `[self]:` 前缀——靠"无前缀 = 自己"与 system prompt 声明配合,前缀最少、信息不冗余。

Phase 6 特殊处理:原来 `replyWithoutTools`/`replyWithTools` 两处重复投影,统一为 `reply` 中投影一次(`toLlmMessages` + 当前输入)后传给两条路径,tool loop 内的 messages 数组天然继承归属标注。

### 修复 2:system prompt 声明多人会话约定

```typescript
// ✅ buildSystemPrompt 中(有其他参与者时)追加
历史消息中，以 `[agentId]:` 开头的 assistant 内容是**其他 Agent** 说的；无前缀的是你自己之前说的话。
```

只加前缀不解释,LLM 可能不理解 `[bob]:` 是什么——前缀和声明必须成对出现。

### 修复 3:A2A 非首跳加委派方标注

```typescript
// ✅ handler.ts(P4/P5/P6)
const delegator = this.registry.get(currentAgentId);
const delegatorName = delegator ? delegator.name : currentAgentId;
const input = chains.length === 0
  ? currentReply // 首跳:router 已构造带归属的委派消息(P4-003)
  : `(来自 @${delegatorName} 的回复，请接着处理)\n\n${currentReply}`;
```

## 修复验证

1. **typecheck**: `npm run typecheck` 通过(P3/P4/P5/P6 全部)
2. **投影单元验证**(临时脚本,已删):构造 bob/nim/ji-tui 三方发言历史 →
   - bob/nim 的 assistant 消息带 `[bob]:`/`[nim]:` 前缀,ji-tui 自己的无前缀 ✓
   - 3 条相邻 assistant 合并为 1 条,user/assistant 严格交替 ✓
3. **端到端**(phase6 CLI,thread `1786773159069-eehawa6`):
   - R1: `@bob 用一句话介绍技术栈` → bob 回复(3 次工具调用)
   - R2: `@nim 你同意 bob 的说法吗` → nim 回复 **"算啦。Bob 讲得啱,但少讲咗核心概念…"**
   - **行为证据**:nim 主动归因"Bob 讲得啱"——它正确辨认出历史中那段话是 bob 说的;修复前它只会看到匿名 assistant 消息(视为自己说的),不可能归因给 bob。且两轮 API 调用成功,无交替违规。

## 遗留

- Phase 1/2 单 Agent 无多 Agent 场景,不改(前缀无意义,改了反而破坏单 Agent 对话格式)。
- `a2aSource` 已进 DB 但未在投影中使用——前缀用 `agentId` 已足够区分发言者;`a2aSource`(委派触发方)信息可在 Phase 8 可观测性中利用。
- 归属前缀 `[id]:` 是"协议",未来若跨 Agent 格式变化(如引入更结构化的 metadata),需同步更新 system prompt 声明。
