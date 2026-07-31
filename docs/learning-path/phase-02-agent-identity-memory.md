# Phase 2 — Agent 身份与记忆

> 状态：✅ 完成
> 前置：[Phase 1](./phase-01-single-agent.md) ｜ 知识参考：[5 大核心抽象](../architecture/core-abstractions.md)

## 目标

让 Agent 成为**持久化对象**。重启后，Agent 还记得你是谁，还能继续上次的话题。

## 产出

1. **Agent 配置文件**：`config/agents/*.json` — 每个文件定义一个 Agent 的人格
2. **SQLite 存储**：对话历史持久化，重启不丢失
3. **CLI 升级**：`pnpm phase2 --agent=ji-tui "你好"` — 指定 Agent，延续历史

## 这一阶段引入/深化的抽象

| 抽象 | 引入程度 | 说明 |
|------|---------|------|
| ① Agent | 🔺 深化 | 从硬编码 persona → 配置文件驱动 |
| ② Message | 🌱 隐式 | 存入 SQLite，但仍是简单结构 |
| ④ Shared State | ✅ 正式引入（短期） | SQLite 作为短期共享状态 |

其余抽象（Router / Pattern / Tools）这一阶段**不碰**。

## 技术点

### 1. Agent 配置文件（人格档案）

```json
// config/agents/ji-tui.json
{
  "id": "ji-tui",
  "name": "鸡腿",
  "emoji": "🍗",
  "model": "claude-opus-4-8",
  "persona": "你是「鸡腿」，一个机灵、鬼点子多的话痨编程搭档...",
  "traits": {
    "style": "活泼",
    "language": "中文",
    "uncertainty": "可爱语气表达，不编造"
  }
}
```

**设计原则**：
- 配置即人格 — 改 JSON 就改 Agent
- 可多人格共存 — Phase 3 前手动指定 ID
- 字段可扩展 — traits 为后续留空间

### 2. SQLite 存储（短期记忆）

```sql
-- schema.sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  config JSON NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- 索引
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
```

**存储边界**：
- Phase 2 只做单 Agent 单会话（conversation 固定为默认值）
- Phase 3 才引入多会话（Thread 隔离）

### 3. 上下文窗口管理

**问题**：历史无限增长，迟早超过模型 context limit。

**Phase 2 方案**：简单截断（保 N 条最近消息）

```ts
class ContextWindow {
  private readonly MAX_MESSAGES = 50;  // 约 8k-10k tokens

  truncate(messages: Message[]): Message[] {
    if (messages.length <= this.MAX_MESSAGES) return messages;
    // 总是保留最早的 system 消息 + 最近 N 条
    const system = messages[0];
    const recent = messages.slice(-this.MAX_MESSAGES);
    return system ? [system, ...recent] : recent;
  }
}
```

**Phase 7 升级路径**：截断 → 摘要（LSM Compaction）

### 4. 目录结构

```
src/phase-02-agent-identity/
├── agent.ts              # Agent 类（升级：从配置加载）
├── config.ts             # 配置文件加载器
├── storage/
│   ├── sqlite.ts         # SQLite 封装
│   └── schema.sql        # 表结构定义
├── context.ts            # 上下文窗口管理
└── cli.ts                # CLI 入口（支持 --agent 参数）

config/agents/            # 新增目录
├── ji-tui.json           # 默认 Agent
└── template.json         # 新 Agent 模板
```

## 验收标准

- [ ] 创建 `config/agents/*.json` 文件能定义新 Agent
- [ ] `pnpm phase2 --agent=xiao-mo "你好"` 使用指定人格回复
- [ ] 重启后运行，Agent 记得上次对话内容
- [ ] 消息超 50 条时自动截断，保留最近的消息
- [ ] 能手动指定 `--conversation-id` 切换会话（Phase 3 前是高级用法）

## 默认配置

- 数据库：`~/.multi-agent-collab-tools/memory.db`（用户主目录）
- 模型：继承 Phase 1（Opus 4.8，可配置覆盖）
- 需要 `ANTHROPIC_API_KEY` 环境变量

## 从 Phase 1 迁移

**破坏性变更**：Agent 构造函数从接受 `persona: string` 改为接受 `config: AgentConfig`。

```diff
- new Agent({ id: "xiao-mo", persona: PERSONA, model: MODEL })
+ new Agent({ configPath: "config/agents/xiao-mo.json" })
```

**数据迁移**：Phase 1 的内存历史不会被迁移（本来也存不住）。Phase 2 启动后才是新生命。

## 完成后

→ Phase 3：引入多 Agent + @mention 路由（多个 Agent 可以在一个会话里协作）

## 设计决策记录（ADR）

完成 Phase 2 后，在 `docs/decisions/` 写一条 ADR：

- **002-agent-config-format.md** — 为什么选择 JSON 而非 YAML/TOML？字段为什么这么设计？
- **003-sqlite-schema.md** — 表结构为什么这样设计？索引策略是什么？

这是最宝贵的学习资产。
