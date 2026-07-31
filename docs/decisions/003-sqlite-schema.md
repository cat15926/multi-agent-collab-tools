---
decision_id: ADR-003
date: 2025-07-31
status: accepted
phase: 2
---

# ADR-003: SQLite 存储架构设计

## Context

Phase 2 需要将对话历史从内存迁移到持久化存储。需要选择存储方案并设计表结构。

## Decision

### 存储选择：SQLite

**选择**：使用 SQLite（通过 `better-sqlite3`）作为存储引擎。

**原因**：
1. **零运维**：单文件数据库，无需独立服务器进程
2. **跨平台**：Windows/macOS/Linux 原生支持
3. **事务支持**：ACID 保证，数据安全
4. **高性能**：WAL 模式下读并发性能优秀
5. **FTS5**：内置全文搜索，Phase 7 可直接用于语义检索
6. **调试友好**：可用 `sqlite3` 命令行工具直接查看

**未选方案**：
- **Redis**：需要独立进程，对于单用户学习项目过度工程
- **PostgreSQL/MySQL**：需要数据库服务器，增加运维复杂度
- **文件系统（JSON/文本）**：无事务支持，并发写入不安全

### 数据库位置

```
~/.multi-agent-collab-tools/memory.db
```

**设计考虑**：
- 用户主目录下，便于跨项目共享
- 隐藏目录（`.` 开头），避免误删
- 单文件，便于备份和迁移

### 表结构设计

```sql
-- Agent 配置缓存表
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  config JSON NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 会话（对话线程）表
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- 消息表
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
```

#### 设计原则

1. **时间戳用 Unix 秒**（而非 ISO 字符串）
   - 节省存储空间
   - 便于排序和计算
   - 查询时可用 `date()` 函数格式化

2. **JSON 存储整配置**
   - `agents.config` 存储完整 JSON，避免字段拆分
   - 灵活应对未来字段增减
   - Phase 2 只读，Phase 7 可能引入配置更新

3. **外键约束**
   - 确保 `messages.conversation_id` 引用有效会话
   - 确保 `conversations.agent_id` 引用有效 Agent
   - 级联删除暂不启用（Phase 2 单会话，不需要）

### 索引策略

```sql
-- 最常用查询：按会话获取消息（按时间排序）
CREATE INDEX idx_messages_conversation
  ON messages(conversation_id, created_at);

-- Agent 的会话列表（按更新时间倒序）
CREATE INDEX idx_conversations_agent
  ON conversations(agent_id, updated_at DESC);
```

**索引设计原则**：
1. **覆盖常用查询**：`ORDER BY created_at ASC` 是最频繁的查询模式
2. **复合索引**：`conversation_id + created_at` 支持会话内消息查询
3. **Phase 2 简化**：暂不创建 `role` 或 `title` 索引（Phase 3 再评估）

#### 查询模式分析

| 查询 | 频率 | 索引使用 |
|------|------|---------|
| 获取会话的所有消息 | 每次对话 | ✅ `idx_messages_conversation` |
| 获取最近的 N 条消息 | 每次对话（上下文窗口） | ✅ `idx_messages_conversation` |
| Agent 的会话列表 | Phase 3+ | ✅ `idx_conversations_agent` |
| 按 ID 查询单条消息 | 调试/回放 | 主键足够 |
| 全文搜索消息内容 | Phase 7 | 未来加 FTS5 |

### WAL 模式

```typescript
db.pragma("journal_mode = WAL");
```

**原因**：
- **读并发**：读取不阻塞写入，支持同时查询和写入
- **崩溃恢复**：WAL 文件提供更好的崩溃恢复能力
- **性能**：大多数场景下性能优于 DELETE journal

### 真相源策略

Phase 2 的真相源层次：
1. **JSON 配置文件** → Agent 身份的真相源
2. **SQLite 数据库** → 对话历史的真相源

启动时的同步流程：
```
1. 读取 config/agents/*.json
2. 检查数据库中是否存在对应 Agent
3. 不存在 → 插入；存在 → 跳过（JSON 是主）
```

## Consequences

### 正面
- **持久化即插即用**：重启后对话无缝延续
- **调试友好**：`sqlite3 memory.db "SELECT * FROM messages LIMIT 10"`
- **扩展路径清晰**：Phase 7 可直接加 FTS5 全文搜索

### 负面
- **单写者限制**：WAL 模式下单写者，高并发场景需要排队
  - **影响**：Phase 2 单用户无影响；Phase 3 多 Agent 需要注意
- **单点故障**：文件损坏风险（ mitigated by WAL + 定期备份）

### 风险
- **数据库锁**：长时间运行的事务可能阻塞其他操作
  - **缓解**：所有写操作使用自动事务，快速提交
- **磁盘空间**：对话历史持续增长
  - **缓解**：Phase 7 引入摘要和归档机制

## Future Work

| Phase | 潜在改进 |
|-------|---------|
| Phase 3 | 多会话支持（会话隔离） |
| Phase 7 | FTS5 全文搜索 + 向量检索 |
| Phase 7 | 消息摘要和归档（LSM Compaction） |
| Phase 8 | Token 计费统计表 |

## Related

- [Phase 2 文档](../learning-path/phase-02-agent-identity-memory.md)
- [ADR-002: Agent Config Format](./002-agent-config-format.md)
