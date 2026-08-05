-- ============================================
-- Phase 4 — Agent 间协作 A2A
-- ============================================
-- 相比 Phase 3 的变化：
--   1. messages 表新增 a2a_source 字段（记录触发 Agent）
--   2. 新增 a2a_chains 表（追踪协作链）
--   3. 添加协作链相关索引
-- ============================================

-- Agent 配置缓存表（与 Phase 3 相同）
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  config JSON NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 会话表（与 Phase 3 相同）
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 会话参与者关系表（与 Phase 3 相同）
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
  agent_id TEXT,
  content TEXT NOT NULL,
  mentions TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  a2a_source TEXT,                    -- 新增：触发此消息的 Agent ID（A2A 场景）
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- ============================================
-- A2A 协作链表（新增）
-- ============================================
CREATE TABLE IF NOT EXISTS a2a_chains (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,      -- 发起协作的 Agent
  target_agent_id TEXT NOT NULL,      -- 被召唤的 Agent
  trigger_message_id TEXT NOT NULL,   -- 触发协作的消息 ID
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (thread_id) REFERENCES conversations(id),
  FOREIGN KEY (source_agent_id) REFERENCES agents(id),
  FOREIGN KEY (target_agent_id) REFERENCES agents(id),
  FOREIGN KEY (trigger_message_id) REFERENCES messages(id)
);

-- ============================================
-- 索引
-- ============================================

-- 消息查询
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);

-- 参与者查询
CREATE INDEX IF NOT EXISTS idx_participants_conversation
  ON conversation_participants(conversation_id);

CREATE INDEX IF NOT EXISTS idx_participants_agent
  ON conversation_participants(agent_id);

-- 会话更新时间
CREATE INDEX IF NOT EXISTS idx_conversations_updated
  ON conversations(updated_at DESC);

-- A2A 协作链查询
CREATE INDEX IF NOT EXISTS idx_a2a_chains_thread
  ON a2a_chains(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_a2a_chains_source
  ON a2a_chains(source_agent_id);

CREATE INDEX IF NOT EXISTS idx_a2a_chains_target
  ON a2a_chains(target_agent_id);
