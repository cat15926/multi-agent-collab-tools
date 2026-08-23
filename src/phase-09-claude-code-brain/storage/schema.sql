-- ============================================
-- Phase 6 — 工具调用（Tool Use）
-- ============================================
-- 相比 Phase 5 的变化：
--   1. 新增 tool_calls 表（工具调用记录）
--   2. tool_calls 统一使用毫秒时间戳（吸取 ADR-007 教训）
-- 保留 Phase 5 全部表（agents/conversations/messages/a2a_chains/workflow_*）
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

-- ============================================
-- tool_calls 表（Phase 6 新增）
-- ============================================
-- 记录每次工具调用，用于可观测、回放、审计
-- ⚠️ 时间戳统一毫秒（created_at 显式插入 Date.now()，不依赖 DEFAULT strftime）
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,                 -- Anthropic tool_use.id（配对用）
  input TEXT,                       -- 工具输入 JSON
  output TEXT,                      -- 工具输出（截断后）
  status TEXT NOT NULL CHECK(status IN ('ok', 'error', 'blocked')),
  duration_ms INTEGER NOT NULL,     -- 毫秒
  created_at INTEGER NOT NULL,      -- 毫秒（显式插入，禁用 DEFAULT strftime）
  FOREIGN KEY (thread_id) REFERENCES conversations(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_thread
  ON tool_calls(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent
  ON tool_calls(agent_id, created_at);

-- ============================================
-- kb_entries 表（Phase 7 新增）
-- ============================================
-- 知识库条目：跨会话共享的决策/经验/证据（长期 Shared State）
-- ⚠️ created_at 毫秒，显式插入 Date.now()（沿 tool_calls 惯例，吸取 ADR-007 教训）
CREATE TABLE IF NOT EXISTS kb_entries (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('decision', 'lesson', 'observation', 'outcome')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT,                     -- JSON string[]（检索主路径：精确命中）
  source_thread TEXT,                -- 来源会话（手动添加为 NULL）
  source_agent TEXT,                 -- 产出者：agent id / 'user' / 'distiller'
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,       -- 毫秒（显式插入，禁用 DEFAULT strftime）
  FOREIGN KEY (source_thread) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_kb_entries_type
  ON kb_entries(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_entries_thread
  ON kb_entries(source_thread, created_at DESC);

-- ============================================
-- kb_reads 表（Phase 7 新增）
-- ============================================
-- 记忆注入审计（--show-memory 回放数据源；一条 = 一次注入，非每 Agent 一条）
CREATE TABLE IF NOT EXISTS kb_reads (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  consumer TEXT NOT NULL,            -- 'router:<agentId>' 或 'pattern:<patternName>'
  query TEXT NOT NULL,               -- 当次检索用的 query
  entry_ids TEXT NOT NULL,           -- JSON string[]：实际注入的条目 id
  created_at INTEGER NOT NULL,       -- 毫秒（显式插入）
  FOREIGN KEY (thread_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_kb_reads_thread
  ON kb_reads(thread_id, created_at);

-- ============================================
-- kb_distill_runs 表（Phase 7 新增）
-- ============================================
-- 提炼运行记录：幂等（scope 级）+ 失败显形（parse_failed 也落一行含原始输出）
CREATE TABLE IF NOT EXISTS kb_distill_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,            -- 会话 id 或 execution id
  status TEXT NOT NULL CHECK(status IN ('ok', 'parse_failed', 'skipped_empty', 'error', 'duplicate_skipped')),
  entries_added INTEGER NOT NULL DEFAULT 0,
  raw_output TEXT,                   -- LLM 原始输出（取证用，parse_failed 时必看）
  created_at INTEGER NOT NULL,       -- 毫秒（显式插入）
  FOREIGN KEY (thread_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_kb_distill_scope
  ON kb_distill_runs(scope_id);

-- ============================================
-- traces 表（Phase 8 新增）
-- ============================================
-- 一次协作的根记录（chat 单轮 / pattern 编排 / distill 提炼）
-- 观测平面：只记时序/汇总/preview；完整 input/output 留在领域平面（tool_calls 等）
-- ⚠️ 时间戳毫秒，显式插入 Date.now()（沿 Phase 6+ 惯例）
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('chat', 'pattern', 'distill')),
  entry TEXT NOT NULL,                -- 'cli' | 'repl'（入口归属）
  thread_id TEXT,
  title TEXT,                         -- 任务/用户输入 preview（截断）
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'ok', 'error')),
  error TEXT,
  started_at INTEGER NOT NULL,        -- 毫秒（显式插入）
  ended_at INTEGER,
  FOREIGN KEY (thread_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_traces_started
  ON traces(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_thread
  ON traces(thread_id, started_at DESC);

-- ============================================
-- spans 表（Phase 8 新增）
-- ============================================
-- Span 树：parent_id 自引用成层级（mini-OTel）
-- kind: route|kb|step|agent|llm|tool|a2a|distill
-- attributes JSON 存指标（tokens/model/stop_reason/turn）与 preview、领域行链接 id
-- span 在结束时一次性 INSERT（崩溃丢 in-flight span——ADR-013 取舍）
-- ⚠️ parent_id 不设外键：父 span 在子 span 之后才落盘（父包裹子），
--    立即检查的外键必然失败；树完整性由 Tracer 生成/引用 id 保证
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_id TEXT,                     -- NULL = 挂 trace 根
  kind TEXT NOT NULL CHECK(kind IN ('route', 'kb', 'step', 'agent', 'llm', 'tool', 'a2a', 'distill')),
  name TEXT NOT NULL,                 -- 人读名，如 'agent:bob' / 'llm:claude-opus' / 'tool:read_file'
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'error')),
  error TEXT,
  start_ts INTEGER NOT NULL,          -- 毫秒
  end_ts INTEGER,
  duration_ms INTEGER,
  attributes TEXT,                    -- JSON
  FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_spans_trace
  ON spans(trace_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_spans_kind
  ON spans(kind, start_ts);

