---
decision_id: ADR-009
date: 2026-08-15
status: accepted
phase: 5-6
type: bugfix
---

# ADR-009: P5-001 Hierarchy 任务拆解解析失败,静默触发兜底

## Issue 信息

- **Issue**: [P5-001](https://github.com/cat15926/multi-agent-collab-tools/issues/6) — Hierarchy 任务拆解解析失败,静默触发兜底(每个 worker 拿到全量任务)
- **严重度**: 🟠 High
- **状态**: ✅ Fixed
- **修复日期**: 2026-08-15

## 问题描述

hierarchy 模式下,管理者把分配清单写成 markdown 加粗格式(`**@bob**:`)时,拆解正则 `/@([\w-]+):\s*(.+)/` 全部失配 → 触发兜底 → **每个工作者收到管理者的完整拆解输出而非独立子任务**。协作不崩(兜底保命),但"并行独立分工"的核心价值丧失:workers 各自重新理解全局计划、产出重叠、token 翻倍、耗时飙升。

实测取证(Issue 原文):#2 bob 与 #3 nim 的 input **逐字相同**(均 696 字 = #1 manager 输出全文);bob 因此耗时 54 秒。

### 预期行为

每个 worker 收到独立、隔离的子任务:
```
#2 bob  input = "设计用户认证 + 风控 + 充值提现模块"
#3 nim  input = "设计核心交易引擎 + 多币种管理 + 日志审计"
```

### 实际行为(修复前)

```
#2 bob  input = manager 整段拆解输出(696 字)
#3 nim  input = 与 bob 逐字相同(696 字)
且无任何警告 —— "分工失败"被伪装成"正常完成"
```

## 根因分析

### 根因 1:正则不容错

**位置**: `src/phase-05-patterns/patterns/hierarchy.ts:167`(P6 逐字拷贝,同病)

```typescript
// ❌ 问题代码
const pattern = /@([\w-]+):\s*(.+)/;
```

`[\w-]+` 匹配到 `bob` 后下一字符是 `*`(来自 `**@bob**:`),失配。markdown 装饰(`**`/`__`/`*`/`_`)、全角冒号 `:` 均会击穿。

### 根因 2:兜底静默

**位置**: `hierarchy.ts:183-192`

解析失败时不报警、不记日志,直接把整段 output 平分给所有 worker——把"分工失败"伪装成"正常完成",不可观测。

### 根因 3:输出格式约束力弱

`buildDecompositionInput` 只"请求" `1. @workerName: 任务` 格式,LLM 经常自作主张加粗排版,无强制力。

**本质**(Issue 点题):只要把 LLM 自由文本当作控制流信号,就一定有"被 LLM 排版击穿"的脆弱点。P4 handoff、P4-004 归属、本 Issue 是同一主题的三次重现。

## 修复方案(A + B + C 组合,P5/P6 两处同步)

### 修复 A:正则容错(治标)

```typescript
// ✅ 剥离 markdown 装饰 + 兼容全角冒号
const cleaned = line.replace(/\*\*|__|\*|_/g, "");
const linePattern = /@([\w-]+)\s*[:：]\s*(.+)/;
```

### 修复 B:结构化标签(治本)

分解提示词改为**严格**要求标签格式:
```
<task agent="workerName">任务描述</task>
```

parser 优先解析标签(一级),标签缺失时落到容错正则(二级):
```typescript
const tagPattern = /<task\s+agent=["']([\w-]+)["']\s*>\s*([\s\S]*?)\s*<\/task>/g;
```

把"控制流信号从自然语言收敛到结构化标签"——与 Phase 4 的 handoff 标签化思路一致。标签属性 `agent="bob"` 抗 markdown 干扰(装饰在标签外面不影响属性匹配;标签内容里的 markdown 原样保留,不清洗)。

### 修复 C:兜底显形(可观测)

```typescript
if (tasks.length === 0) {
  console.warn(`[hierarchy] ⚠️ 任务拆解解析失败…触发兜底：所有工作者将收到完整任务`);
  result.metadata.decompositionFallback = true;  // 落库到 workflow_executions.result
  ...
}
```

`PatternMetadata` 新增可选字段 `decompositionFallback?: boolean`。`persistExecution` 本就把 `result.metadata` 整体 JSON 写入 `workflow_executions.result`(`orchestrator/index.ts:216`),标记自动持久化,无需额外改动。

### 解析优先级总结

```
一级 <task agent="x">…</task>   ← 提示词强制要求,抗排版
二级 @worker: 任务               ← 剥装饰 + 全角冒号容错(标签全失时)
兜底  全量广播 + console.warn + metadata 标记(显形,不再静默)
```

## 修复验证

1. **typecheck**: `npm run typecheck` 通过(P5/P6)
2. **单元验证**(临时脚本,已删,7 case 全过):
   - 标准标签(双引号/单引号)解析 ✓
   - **Issue 原始案例**(`**@bob**: …`)经剥装饰后正确解析 ✓
   - 全角冒号 `:` + 下划线装饰 ✓
   - 标签内容含 markdown 不被清洗(任务描述原样)✓
   - 完全无法解析 → 兜底广播 + fallback 标记 ✓
   - 未知 agent 的标签被忽略,混入有效标签时不触发兜底 ✓
3. **端到端实跑**(phase6 CLI,`--pattern=hierarchy --manager=ji-tui --workers=bob,nim`,execution `1786774435464-y7fbply-hierarchy-...-7nemgs`):
   - #1 manager 提示词已是新标签格式(`<task agent=...`)
   - manager 输出 **4 个标签**(认证/权限/Schema/安全,交叉分配 bob×2、nim×2)→ 一级解析命中,未触发兜底
   - worker input 各自隔离:`#2 bob=66字(认证模块)`、`#3 nim=46字(权限模块)`、`#4 bob=37字(Schema)`、`#5 nim=43字(安全)`——**不再逐字相同、不再是 manager 全文**
   - `workflow_executions.result` 落库的 metadata 无 `decompositionFallback`(未触发兜底),CLI 无 `⚠️` 警告

   与 Issue 原始取证对照:修复前 #2/#3 input 逐字相同(696 字 = manager 全文);修复后各自独立子任务。

## 遗留

- P6 `hierarchy.ts` 与 P5 是逐字拷贝(diff 确认),本次继续"两份同步修"的项目惯例;提取共享层作为 Phase 8/9 重构议题。
- 兜底标记目前只在 CLI console.warn + DB metadata;`--show-workflow` 回放尚未展示该标记(可作 Phase 8 可观测性小改进)。
- `parseDecomposition` 的正则二级仍可能被更刁钻的排版击穿(如 `@bob —` 破折号分隔)——标签一级是主防线,二级只是缓解。
