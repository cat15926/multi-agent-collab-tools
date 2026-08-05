# 多 Agent 协作工具 — 从 0 到 1 构建笔记

[![GitHub repo](https://img.shields.io/badge/GHub-cat15926%2Fmulti--agent--collab--tools-blue)](https://github.com/cat15926/multi-agent-collab-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/node-%3E=24.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)

个人学习项目：从零构建一个属于自己的多 Agent 协作工具，逐步迭代、边造边学。
不追求一蹴而就，功能逐步迭代，每个阶段都能跑、能验证。

> 实物参照：[Clowder AI](https://github.com/zts212653/clowder-ai)（本地已部署在 `~/lhz/clowder-ai`）——一套工业级多 Agent 协作平台，作为学习时的"参考答案"。

## 当前进度

| Phase | 主题 | 状态 |
|-------|------|------|
| 0 | 地基与心智地图 | ✅ 完成 |
| 1 | 单 Agent 能说话（MVP） | ✅ 完成 |
| 2 | Agent 身份与记忆 | ✅ 完成 |
| 3 | 多 Agent + 消息路由 | ✅ 完成 |
| 4 | Agent 间协作 A2A | ✅ 完成 |
| 5 | 协作模式 Pattern | ⬜ 待办 |
| 6 | 工具调用 | ⬜ 待办 |
| 7 | 共享记忆与知识库 | ⬜ 待办 |
| 8 | 可观测性 | ⬜ 待办 |
| 9 | Web UI 与产品化 | ⬜ 待办 |
| 10 | 进阶主题（选学） | ⬜ 待办 |

→ 完整路线与进度：[`docs/learning-path/README.md`](./docs/learning-path/README.md)

## 🚀 快速开始

```bash
# 克隆仓库
git clone https://github.com/cat15926/multi-agent-collab-tools.git
cd multi-agent-collab-tools

# 安装依赖
npm install

# 运行 Phase 1（单 Agent MVP）
npm run phase1

# 运行 Phase 2（Agent 身份与记忆）
npm run phase2
npm run phase2 -- --list              # 列出所有 Agent
npm run phase2 -- --agent ji-tui      # 选择特定 Agent
npm run phase2 -- --reset             # 重置数据库

# 构建
npm run build
```

## 📦 仓库结构

```
multi-agent-collab-tools/
├── README.md                       # 你在这里：项目说明 + 进度
├── package.json                    # 依赖与脚本
├── config/
│   └── agents/                     # Agent 配置文件
│       └── ji-tui.json              # 默认 Agent "鸡腿"
├── src/
│   ├── phase-01-single-agent/       # Phase 1：单 Agent MVP
│   │   └── cli.ts
│   ├── phase-02-agent-identity/     # Phase 2：持久化 Agent
│   │   ├── agent.ts
│   │   ├── cli.ts
│   │   ├── context.ts               # 上下文窗口管理
│   │   ├── storage/
│   │   │   ├── schema.sql           # SQLite 数据库结构
│   │   │   └── sqlite.ts            # 存储层
│   │   └── config.ts                # 配置加载
│   └── phase-03-multi-agent/        # Phase 3：多 Agent + 路由（待实现）
│       ├── agent.ts
│       ├── cli.ts
│       ├── context.ts               # 上下文窗口管理
│       ├── storage/
│       │   ├── schema.sql           # SQLite 数据库结构
│       │   └── sqlite.ts            # 存储层
│       └── config.ts                # 配置加载
└── docs/
    ├── learning-path/               # 学习路线（每个 Phase 一篇）
    ├── architecture/                # 架构参考资料
    └── decisions/                   # 设计决策记录（ADR）
```

## 技术栈选择

| 维度 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript + Node 24 | 与 Clowder 同栈，可对照源码学；类型系统适合建模 Agent 抽象 |
| LLM 接入 | 官方 SDK（Anthropic/OpenAI）直连 | 学习期自己实现 Router/Agent/Memory，**不用重框架**（它会掩盖原理） |
| 存储 | SQLite（better-sqlite3） | 简单够用，零运维 |
| 形态 | 先 CLI，后 Web UI | 内核跑通前不碰前端 |

> 核心主张：学习期不要一上来用 LangChain / LangGraph / AutoGen / CrewAI。
> 它们是"懂原理后的提效工具"，不是"学原理的教材"。

## 目录结构

```
multi-agent-collab-tools/
├── README.md                       # 你在这里：项目说明 + 进度
└── docs/
    ├── learning-path/              # 学习路线（每个 Phase 一篇）
    │   ├── README.md               # 路线总览 + 进度表
    │   └── phase-00-foundation.md  # Phase 0 阶段文档
    ├── architecture/               # 架构参考资料（跨 Phase 复用）
    │   └── core-abstractions.md    # 5 大核心抽象 + 架构图
    └── decisions/                  # 设计决策记录（ADR，按 Phase 积累）
```

**设计原则**：长期参考资料（架构/抽象）和阶段文档（每个 Phase 的目标/作业）分开。
每完成一个 Phase，只需往 `docs/learning-path/` 加一个 `phase-XX-*.md`，并往 `docs/decisions/` 写一条决策笔记。

## 从哪开始

1. 读 [`docs/architecture/core-abstractions.md`](./docs/architecture/core-abstractions.md) — 建立 5 抽象心智模型
2. 做 [`docs/learning-path/phase-00-foundation.md`](./docs/learning-path/phase-00-foundation.md) 的验收作业
3. 完成后进入 Phase 1，开始写代码

## 🔗 GitHub

本项目源代码托管在 [GitHub](https://github.com/cat15926/multi-agent-collab-tools)：
- **仓库**：https://github.com/cat15926/multi-agent-collab-tools
- **License**：MIT

---

**从零构建，边学边做，记录每个决策。**
