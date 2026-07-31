-- Phase 2 Schema: Agent 身份与记忆
--
-- 设计原则：
-- 1. 简单优先 - Phase 2 只支持单 Agent 单会话
-- 2. 可扩展 - 表结构为 Phase 3（多会话）预留空间
-- 3. 可审计 - 所有表都有 created_at 时间戳

-- Agent 配置存储（用于快速查找已加载的 Agent）
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  config JSON NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 会话（对话线程）
-- Phase 2: 只有一条默认会话
-- Phase 3: 支持多会话（Thread 隔离）
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- 消息存储
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- 索引：按会话和时间查询消息（最常用查询）
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);

-- 索引：按 Agent 查询会话
CREATE INDEX IF NOT EXISTS idx_conversations_agent
  ON conversations(agent_id, updated_at DESC);
