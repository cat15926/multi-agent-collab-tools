# 设计决策记录（ADR）

> ADR = Architecture Decision Record。
> 每完成一个 Phase，在这里记一条"我为什么这么设计"。
> **这是比代码更重要的学习资产**——代码会被重构，但决策的理由不会变。

## 为什么记

- **强迫自己想清楚**：写得出来，才算真懂。
- **日后可追溯**：几个月后回看，知道当时为什么这么选；错了也能找到根因。
- 学着 Clowder 的 `docs/decisions/` 做法——工业级项目都靠这个沉淀架构判断。

## 怎么记

1. 复制 [`_template.md`](./_template.md)
2. 命名 `0001-短描述.md`（编号递增）
3. 填写
4. **一个决策一篇**，别合并

## 编号与状态规则

- 从 `0001` 起递增。
- 方向变更时**开新编号**，不修改旧篇；把旧篇状态改为 `superseded by ADR-000X`。
- 状态：`proposed` → `accepted` →（可选）`deprecated` / `superseded`。

## 已有决策

| ADR | 主题 | Phase | 日期 | 状态 |
|-----|------|-------|------|------|
| [ADR-002](./002-agent-config-format.md) | Agent 配置文件格式设计 | 2 | 2025-07-31 | ✅ accepted |
| [ADR-003](./003-sqlite-schema.md) | SQLite 存储架构设计 | 2 | 2025-07-31 | ✅ accepted |

> **注**：ADR-001 未单独成文，已在 Phase 1 代码和文档中说明：为什么用官方 SDK 直连而非框架（学习期手写更好理解原理）。
