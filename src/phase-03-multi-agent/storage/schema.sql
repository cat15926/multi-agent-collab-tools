-- ============================================
-- Phase 3 — 多 Agent + 消息路由
-- ============================================
-- 相比 Phase 2 的变化：
--   1. conversations 移除 agent_id（一个会话可有多 Agent）
--   2. 新增 conversation_participants 表（会话-Agent 多对多关系）
--   3. messages 表新增 agent_id 和 mentions 字段
-- ============================================

-- Agent 配置缓存表（与 Phase 2 相同）
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  config JSON NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- ============================================
-- 会话表（简化）
-- ============================================
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- ============================================
-- 会话参与者关系表（新增）
-- ============================================
-- 一个会话可以有多个 Agent，一个 Agent 可以参与多个会话
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  joined_at INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (conversation_id, agent_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- ============================================
-- 消息表（扩展）
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  agent_id TEXT,                    -- 哪个 Agent 回复的（user 消息为 NULL）
  content TEXT NOT NULL,
  mentions TEXT,                    -- JSON 数组，如 ["alice","bob"]
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- ============================================
-- 索引
-- ============================================

-- 查询会话的所有消息（按时间排序）
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);

-- 查询会话的参与者
CREATE INDEX IF NOT EXISTS idx_participants_conversation
  ON conversation_participants(conversation_id);

-- 查询 Agent 的所有会话（Phase 3+）
CREATE INDEX IF NOT EXISTS idx_participants_agent
  ON conversation_participants(agent_id);

-- 会话按更新时间排序
CREATE INDEX IF NOT EXISTS idx_conversations_updated
  ON conversations(updated_at DESC);
