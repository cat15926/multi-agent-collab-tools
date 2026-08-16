---
decision_id: ADR-010
date: 2026-08-16
status: accepted
phase: 5-6
type: bugfix
---

# ADR-010: P5-002 Hierarchy worker 踢皮球 — system prompt 角色感知

## Issue 信息

- **Issue**: [P5-002](https://github.com/cat15926/multi-agent-collab-tools/issues/7) — Hierarchy worker 踢皮球:拿到子任务后仍向外分工,不亲自产出
- **严重度**: 🟡 Medium
- **状态**: ✅ Fixed
- **修复日期**: 2026-08-16

## 问题描述

P5-001 修复后 worker 已拿到独立、不重叠的子任务,但 worker(bob/nim)仍倾向把活儿再 @分给他人,而非亲自产出设计——"并行独立分工"在最后一公里失效,最终靠 manager 在汇总步兜底补齐。

与 P5-001 性质不同:P5-001 是"结构坏了"(代码确定性 bug),P5-002 是"结构对了但 LLM 不配合"(prompt 工程)。

### 预期行为

worker 输出 = 所负责模块的技术设计(架构/数据模型/关键流程)。

### 实际行为(修复前)

```
[bob 输出]: "…我将对剩余模块进行任务分工与拆解：
  #### @ji-tui：负责 核心交易引擎 …
  #### @nim：负责 风控系统 …
  #### 我 (Bob)：负责 多币种底层管理 …"
```

两个 worker 都在"再分工",没人在做设计。

## 根因分析

### 根因 1:system prompt 一刀切鼓励委派(主因)

**位置**: `src/phase-05-patterns/agent/agent.ts`(P6 同构)

```typescript
// ❌ 问题代码:只要有多参与者就无条件追加
if (participantsInfo) {
  return `${basePrompt}
**当前会话参与者**: 你, ${participantsInfo}
…
你可以主动 @其他参与者寻求帮助或委派任务。`;   // ← worker 也吃到这句
}
```

worker 被 `executeAgent` 调用时 `participants` 含全部 Agent——bob 的 system prompt 字面写着"你可以主动 @ji-tui、@nim 委派任务"。**系统层在命令它踢皮球。**

### 根因 2:worker 输入无执行框定(次因)

`hierarchy.ts` 直接传光秃秃的任务条目,LLM 见"清单"就想"分配"。

### 根因 3(分析时补充,Issue 未点破):Pattern 路径下 @mention 本来无效,但 LLM 不知道

`a2aEnabled` 只在 `pattern/context.ts:47` 定义,**没有任何 Pattern 读它**;CLI pattern 分支调完 `executePattern` 即结束,不跑 A2A handler。worker 输出的 `@ji-tui 你负责…` 是**死信**——没人接收执行,也没有机制告知 worker 这一点。**双重讽刺:系统教唆委派,而委派在 Pattern 上下文里根本无效。** 因此修复必须显式告知"@无效",而不只是"不要"。

### 本质

Phase 5 引入 Pattern 角色(manager/worker/辩手),但 Agent 的 system prompt 角色无关一刀切。角色语义没有下沉到提示层。

## 修复方案(A + B,三 Pattern 覆盖,P5/P6 同步)

### 修复 A:system prompt 角色感知

`AgentReplyOptions` 新增 `role?: "executor" | "collaborator" | "manager"`(省略 = 现有行为,router/a2a/debate 调用方零改动)。`buildSystemPrompt(participants, role)` 分支:

- `executor`:参与者信息与归属声明(P4-004 成果)**保留**,委派鼓励句**替换**为:
  > **你是执行者(executor)**:任务已分配给你,请**直接产出**完整结果,**不要转交、不要重新分工、不要 @其他参与者**——你正处于结构化编排中,@mention 不会触发任何委派,你的回复就是本步骤的唯一产出。
- 其他/省略:保留"你可以主动 @其他参与者…"(A2A / debate / manager 汇总用)。

### 修复 B:输入执行框定 + executeAgent 透传

- `BasePattern.executeAgent` 新增第 5 参 `opts?: { role? }`,转发给 `agent.reply`(前 4 参数签名不变,debate 等 6 个既有调用点零改动)。
- **hierarchy worker**:`以下是你(@bob)负责的任务,请直接产出该任务的技术方案(架构/数据模型/关键流程等设计要素),不要转交他人、不要重新分工:` + 子任务描述,并传 `role: "executor"`。
- **parallel worker**(本次扩大覆盖,Issue 只点名 hierarchy):同型框定 + executor。parallel worker 拿全量 task,同病。
- **pipeline 各棒**(本次扩大覆盖):`请直接基于它完成你这一环的工作并产出结果,不要转交他人、不要重新分工:` + 上游输出,executor。串行接力中任一棒 @人即断链。
- manager 拆解/汇总步保持默认角色(需要知道参与者、可调度语义)。

### 附带:MAX_TOKENS 4096 → 8192(P5/P6)

修复 P5-002 后 worker 会认真产出长设计,#8(P6-001)的 4096 截断将更易触发、干扰验收。两 Issue 耦合,一并提额(claude-opus-4 系上限内)。P6-001 的完整修复(截断显形/标记)仍在 #8 跟踪。

## 修复验证

1. **typecheck**: 通过(P5/P6)
2. **单元验证**(临时脚本,已删,9 case 全过):
   - executor:含执行者指令、含"@不会触发任何委派"告知、**不再含**委派鼓励句
   - executor:保留参与者信息 + `[agentId]:` 归属声明(P4-004 成果不回退)
   - collaborator:保留委派鼓励、无执行者指令
   - role 省略 = collaborator 行为(向后兼容,router/a2a 零影响)
   - 单人会话:不加参与者段(与现有一致)
3. **端到端实跑**(phase6 CLI,`--pattern=hierarchy --manager=ji-tui --workers=bob,nim`,任务取自 Issue 原文"Token 中转站",280s/4 步):

   | | Issue 实测(修复前) | 本次实跑(修复后) |
   |---|---|---|
   | bob worker | "任务分工与拆解:@ji-tui 负责…@nim 负责…" | **30,362 字完整技术方案**(架构图/数据模型/SQL),输出中 @mention 数 = **0** |
   | nim worker | "@ji-tui 你负责…@bob 交俾你…" | **8,707 字三大系统设计**(交易/多币种/日志),@mention 数 = **0** |
   | manager | 需"主动补位"代打核心设计 | 纯汇总,无需代打 |

   - worker input 均带执行框定前缀("以下是你(@bob)负责的任务,请直接产出…不要转交他人、不要重新分工")
   - nim 开场白"既然分到我……冇得拖,直接开工"直接体现 executor 指令生效
   - 对照 Issue 验收标准:worker 输出不再以"分工/@xx 负责/交给你"为主体,直接产出模块技术设计 ✓
   - MAX_TOKENS=8192 下 bob 30K 字(≈8K token 级)未被腰斩;但 #2 尾部仍贴近上限(SQL 代码收尾处),#8 截断显形修复仍必要

## 遗留

- parallel 的 aggregator、debate 双方、hierarchy manager 保持默认角色——若后续发现 debate 出现"不驳论只分工"等同型问题,可用同机制加角色。
- 方案 C(输出校验"光分工不干活"启发式)按 Issue 判断不做;若 executor 框定后仍有漏网,可在 Phase 8 可观测性里加统计(如 executor 步输出中 @mention 密度)。
- P3/P4 的 router 路径(对话式)不传 role,行为不变——那正是需要委派语义的场景。
