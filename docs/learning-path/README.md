# 学习路线（Phase 0 → 10）

从 0 到 1 构建一个属于自己的多 Agent 协作工具。每个 Phase 都是"小而完整"的——能跑、能验证、有成就感。**验收过了再进下一阶段。**

## 进度总览

| Phase | 主题 | 状态 | 文档 |
|-------|------|------|------|
| 0 | 地基与心智地图（5 抽象 + 架构图） | ✅ 完成 | [phase-00](./phase-00-foundation.md) |
| 1 | 单 Agent 能说话（MVP） | ✅ 完成 | [phase-01](./phase-01-single-agent.md) |
| 2 | Agent 身份与记忆 | ✅ 完成 | [phase-02](./phase-02-agent-identity-memory.md) |
| 3 | 多 Agent + 消息路由 | ✅ 完成 | [phase-03](./phase-03-multi-agent-routing.md) |
| 4 | Agent 间协作 A2A | ✅ 完成 | [phase-04](./phase-04-agent-to-agent-collaboration.md) |
| 5 | 协作模式 Pattern（系统灵魂） | ✅ 完成 | [phase-05](./phase-05-collaboration-patterns.md) |
| 6 | 工具调用（给 Agent 装手） | ✅ 完成 | [phase-06](./phase-06-tools.md) |
| 7 | 共享记忆与知识库 | ✅ 完成 | [phase-07](./phase-07-shared-memory.md) |
| 7.5 | 交互体验优化（参照 Claude Code） | 🔄 进行中 | [phase-07.5](./phase-07.5-interaction-ux.md) |
| 8 | 可观测性（Trace/Span 树/计费/回放） | ✅ 完成 | [phase-08](./phase-08-observability.md) |
| 9 | Claude Code Brain（外部运行时接入） | ✅ 完成 | [phase-09](./phase-09-claude-code-brain.md) |
| 10 | Web UI 与产品化（按需） | ⬜ 待办 | — |
| 11 | 进阶主题（选学） | ⬜ 待办 | — |

图例：🔄 进行中 ｜ ⬜ 待办 ｜ ✅ 完成

## 路线详情

### Phase 0 — 地基与心智地图（1-2 天）
吃透 5 大抽象。产出：自己画的架构图 + 术语表。
→ [详细文档](./phase-00-foundation.md) · [核心抽象参考](../architecture/core-abstractions.md)

### Phase 1 — 单 Agent 能说话（2-3 天）
跑通 `输入 → LLM → 输出` 最小回路。产出：CLI，`myagent "你好"` 流式返回带人格的回复。
技术点：Anthropic Messages API、流式输出、system prompt。

### Phase 2 — Agent 身份与记忆（3-4 天）
让 Agent 成为持久化对象。产出：`class Agent` + 人格配置 + 对话存 SQLite。
技术点：Agent 类设计、上下文窗口管理（截断/摘要）、better-sqlite3。

### Phase 3 — 多 Agent + 消息路由（4-5 天）— "多 Agent"的起点
`@alice` / `@bob` 各自回复。产出：聊天室 + Agent Registry + 会话隔离。
技术点：消息总线、@mention 解析、Thread 隔离。

### Phase 4 — Agent 间协作 A2A（4-5 天）
Agent 互相委派任务。产出：alice 写完代码 → 自动请 bob review。
技术点：Agent 作为消息发起者、任务传递协议、handoff。

### Phase 5 — 协作模式 Pattern（5-7 天）— 系统的灵魂
把"怎么协作"抽象成可切换的编排模式：顺序流水线 / 并行多视角 / 辩论审查。
技术点：Orchestrator 抽象、fan-out + 聚合、终止条件、投票收敛。

### Phase 6 — 工具调用（4-5 天）
Agent 能读文件、跑命令、搜索。技术点：function calling、工具注册表、**安全沙箱**。
→ [详细文档](./phase-06-tools.md)

### Phase 7 — 共享记忆与知识库（5-7 天）
Agent 间共享长期记忆（决策、经验、证据）。技术点：共享状态、(可选)向量检索。
→ [详细文档](./phase-07-shared-memory.md)

### Phase 8 — 可观测性（3-4 天）
结构化日志、trace、token 计费、回放。验收：一次协作产出完整"轨迹"。
→ [详细文档](./phase-08-observability.md)

### Phase 9 — Claude Code Brain（2-3 天）
Agent 的"脑+手"可替换：Brain 接口 + 接入 Claude Agent SDK（完整 agentic loop、canUseTool 沙箱映射、kb MCP 注入、cc 成本对账）。验收：bob/nim/ji-tui 默认 CC 能力、Hard Rails 守住、`--brain=anthropic` 可回退。
→ [详细文档](./phase-09-claude-code-brain.md)

### Phase 10 — Web UI 与产品化（按需，1-2 周）
浏览器聊天界面（多线程、@路由、Agent 卡片）。⚠️ 内核（P1-P9）稳了再做。

### Phase 11 — 进阶主题（选学）
自我演化、跨模型 provider、cron 调度、安全护栏、CC 子代理（agents 选项）实验。

## 使用方式

- **对照实物学**：左手指着 Clowder 源码（工业级实现），右手写自己的简化版。
- **记决策**：每个 Phase 完成后，在 `docs/decisions/` 写一条"我为什么这么设计"的笔记（学着 Clowder 的 ADR 做法）。这是最宝贵的学习资产。
- **定期回顾**：每周回看本进度表，调整节奏与重点。

## 五个一定要避开的陷阱

1. **一上来用重框架**（LangChain/LangGraph/AutoGen）→ 被抽象淹没，学不到原理。学习期手写。
2. **一上来做 UI** → 内核没稳，前端返工无尽头。
3. **一上来接 5 个模型 / 10 个工具** → 注意力分散。先 1 个模型 + 0 个工具。
4. **没有验收标准** → 永远在半成品里打转。
5. **跳过 Phase 0** → 没地图就上路，每个阶段都重新迷茫。
