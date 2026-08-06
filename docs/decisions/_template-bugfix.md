---
decision_id: ADR-XXX
date: YYYY-MM-DD
status: accepted
phase: X
type: bugfix
---

# ADR-XXX: [Issue ID] [简短标题]

## Issue 信息

- **Issue**: [Issue-ID] — [Issue 标题]
- **严重度**: Critical / High / Medium / Low
- **状态**: ✅ Fixed / 🔄 In Progress / ⬜ Pending
- **修复日期**: YYYY-MM-DD

## 问题描述

[描述问题的现象和影响]

### 预期行为

```
[预期行为的描述或示例]
```

### 实际行为

```
[实际行为的描述或示例]
```

## 根因分析

### 根因 1：[根因标题]

**位置**: `[文件路径]:[行号]`

```typescript
// ❌ 问题代码
[问题代码片段]
```

[解释为什么这是问题]

### 根因 2：[根因标题]

...

## 修复方案

### 修复 1：[修复标题]

```typescript
// ✅ 修复代码
[修复后的代码片段]
```

### 修复 2：[修复标题]

...

## 验证方法

```bash
# 测试命令
[测试命令]

# 验证结果
[预期输出]
```

## 经验总结

### 设计层面

1. **[经验标题]**: [经验描述]。**教训**: [可操作的建议]

### 流程层面

...

### 测试层面

...

## 影响范围

### 修改的文件

- `[文件路径]`
- ...

### 破坏性变更

[描述是否有破坏性变更]

### 后续 Phase 影响

- **Phase X**: [描述影响]

## 相关链接

- [Issue #X](https://github.com/cat15926/multi-agent-collab-tools/issues/X)
- [Phase X 文档](../learning-path/phase-XX-*.md)
- [相关 ADR](./XXX-*.md)

---

**记录人**: [记录人]
**复核**: [复核状态]
