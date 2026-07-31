# Phase 1 — 单 Agent 能说话（MVP）

> 状态：🔄 进行中
> 前置：[Phase 0](./phase-00-foundation.md) ｜ 知识参考：[5 大核心抽象](../architecture/core-abstractions.md)

## 目标

跑通整个系统的**第一块砖**：`输入 → LLM → 输出` 最小回路。
不追求功能，只追求"它能说话、有性格、是流式的"。

## 产出

一个 CLI：
```bash
pnpm phase1 "你好"
# 流式打印一个带人格的 Agent 的回复
```

## 这一阶段引入的抽象

| 抽象 | 引入程度 | 说明 |
|------|---------|------|
| ① Agent | ✅ 正式引入 | `class Agent`：persona + model + reply() |
| ② Message | 🌱 隐式 | 用户输入 = `Message{from:user}`；Phase 3 才结构化 |

其余抽象（Router / Shared State / Pattern）这一阶段**刻意不碰**——保持最小。

## 技术点

- **Anthropic Messages API**：用 `@anthropic-ai/sdk` 直连（不用任何框架，亲手摸到 API）。
- **流式输出**：`messages.stream()` + async generator，逐 token 产出。
- **system prompt 定义人格**：改 `persona` 字段 → 改变 Agent 性格（这是验收点）。

## 代码位置

`src/phase-01-single-agent/`
- `agent.ts` — Agent 最小实现（对应抽象 ①）
- `cli.ts` — 命令行入口

## 验收标准

- [ ] `pnpm phase1 "你好"` 能流式打印回复
- [ ] 改 `persona`（system prompt）后，Agent 的回复风格明显变化
- [ ] 能讲清"一次调用从输入到输出经历了什么"（对应核心抽象里的数据流）

## 默认配置

- 模型：Opus 4.8（`claude-opus-4-8`）。学习时想省钱可换 Sonnet / Haiku，代码里一行即可改。
- 需要 `ANTHROPIC_API_KEY` 环境变量。

## 完成后

→ Phase 2：给 Agent 加**身份配置文件** + **记忆**（SQLite 持久化），让它重启后还记得你。
