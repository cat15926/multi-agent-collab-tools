-- ============================================
-- Phase 5 — 协作模式 Pattern
-- ============================================
-- 相比 Phase 4 的变化：
--   1. 新增 workflow_executions 表（Pattern 执行记录）
--   2. 新增 workflow_steps 表（执行步骤记录）
--   3. 添加相关索引
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

-- ============================================
-- workflow_executions 表（新增）
-- ============================================
CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  pattern_name TEXT NOT NULL,
  task TEXT NOT NULL,
  agents TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  started_at INTEGER DEFAULT (strftime('%s', 'now')),
  completed_at INTEGER,
  result TEXT,
  error TEXT,
  FOREIGN KEY (thread_id) REFERENCES conversations(id)
);

-- ============================================
-- workflow_steps 表（新增）
-- ============================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  input_text TEXT NOT NULL,
  output_text TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  duration INTEGER NOT NULL,
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  error TEXT,
  FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- ============================================
-- Workflow 索引（新增）
-- ============================================

CREATE INDEX IF NOT EXISTS idx_workflow_executions_thread
  ON workflow_executions(thread_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_status
  ON workflow_executions(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_execution
  ON workflow_steps(execution_id, step_number);
