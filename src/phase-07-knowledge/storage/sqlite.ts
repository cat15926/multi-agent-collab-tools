/**
 * Phase 6 — SQLite 存储层（Tool Use 扩展版）
 *
 * 相比 Phase 5 的变化：
 * - 新增 tool_calls 表操作（记录每次工具调用）
 * - tool_calls 统一毫秒时间戳（吸取 ADR-007 教训）
 *
 * 职责：
 * - 数据库初始化和 schema 管理
 * - Agent/Conversation/Participant/Message 的 CRUD 操作
 * - A2A 协作链的追踪和查询
 * - Workflow 执行记录的追踪和查询
 * - 工具调用记录的追踪和查询（Phase 6）
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

// 数据库文件路径：用户主目录下的 .multi-agent-collab-tools/memory.db
const DB_PATH = join(process.env.HOME || process.env.USERPROFILE || ".", ".multi-agent-collab-tools/memory.db");

/** 消息角色类型 */
export type MessageRole = "user" | "assistant";

/** 消息结构（Phase 5 复用 Phase 4） */
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  agentId?: string;
  content: string;
  mentions?: string[];
  createdAt: number;
  a2aSource?: string;
}

/** 会话结构 */
export interface Conversation {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

/** 会话参与者结构 */
export interface Participant {
  conversationId: string;
  agentId: string;
  joinedAt: number;
}

/** Agent 配置结构 */
export interface AgentConfig {
  id: string;
  name: string;
  emoji: string;
  model: string;
  persona: string;
  traits?: Record<string, unknown>;
}

/** A2A 协作链结构 */
export interface A2AChain {
  id: string;
  threadId: string;
  sourceAgentId: string;
  targetAgentId: string;
  triggerMessageId: string;
  createdAt: number;
}

/** 添加消息的选项 */
export interface AddMessageOptions {
  conversationId: string;
  role: MessageRole;
  content: string;
  agentId?: string;
  mentions?: string[];
  a2aSource?: string;
}

/** Workflow 执行状态（新增） */
export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** Workflow 执行记录（新增） */
export interface WorkflowExecution {
  id: string;
  threadId: string;
  patternName: string;
  task: string;
  agents: string[];
  status: WorkflowStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

/** 添加 Workflow 执行记录的选项（新增） */
export interface AddWorkflowExecutionOptions {
  id: string;
  threadId: string;
  patternName: string;
  task: string;
  agents: string; // JSON string
  status: WorkflowStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

/** Workflow 步骤记录（新增） */
export interface WorkflowStep {
  id: string;
  executionId: string;
  stepNumber: number;
  agentId: string;
  inputText: string;
  outputText: string;
  timestamp: number;
  duration: number;
  success: boolean;
  error?: string;
}

/** 添加 Workflow 步骤的选项（新增） */
export interface AddWorkflowStepOptions {
  executionId: string;
  stepNumber: number;
  agentId: string;
  inputText: string;
  outputText: string;
  timestamp: number;
  duration: number;
  success: number; // 0 or 1 for SQLite
  error?: string | null;
}

/** 工具调用状态（Phase 6 新增） */
export type ToolCallStatus = "ok" | "error" | "blocked";

/** 工具调用记录（Phase 6 新增） */
export interface ToolCall {
  id: string;
  threadId: string;
  agentId: string;
  toolName: string;
  toolUseId?: string;
  input?: string;
  output?: string;
  status: ToolCallStatus;
  durationMs: number;
  createdAt: number; // 毫秒
}

/** 添加工具调用记录的选项（Phase 6 新增） */
export interface AddToolCallOptions {
  threadId: string;
  agentId: string;
  toolName: string;
  toolUseId?: string;
  input?: string;
  output?: string;
  status: ToolCallStatus;
  durationMs: number;
  createdAt?: number; // 默认 Date.now()（毫秒）
}

// ─── 知识库类型（Phase 7 新增；结构见 knowledge/types.ts）──────────

/** 知识条目类型 */
export type EvidenceType = "decision" | "lesson" | "observation" | "outcome";

/** 知识条目（长期共享记忆的最小单元） */
export interface Evidence {
  id: string;
  type: EvidenceType;
  title: string;
  content: string;
  keywords: string[];
  sourceThread?: string;
  sourceAgent?: string;
  timestamp: number; // 毫秒
  verified?: boolean;
}

/** 添加知识条目的选项（Phase 7 新增） */
export interface AddKbEntryOptions {
  type: EvidenceType;
  title: string;
  content: string;
  keywords?: string[];
  sourceThread?: string;
  sourceAgent?: string;
  verified?: boolean;
  createdAt?: number; // 默认 Date.now()（毫秒）
}

/** 列出知识条目的过滤条件 */
export interface ListKbEntriesOptions {
  type?: EvidenceType;
  sourceThread?: string;
  limit?: number;
}

/** 记忆注入审计记录（Phase 7 新增） */
export interface KbRead {
  id: string;
  threadId: string;
  consumer: string; // 'router:<agentId>' / 'pattern:<patternName>'
  query: string;
  entryIds: string[];
  createdAt: number; // 毫秒
}

/** 提炼运行记录（Phase 7 新增） */
export type DistillStatus =
  | "ok"
  | "parse_failed"
  | "skipped_empty"
  | "error"
  | "duplicate_skipped";

export interface KbDistillRun {
  id: string;
  threadId: string;
  scopeId: string;
  status: DistillStatus;
  entriesAdded: number;
  rawOutput?: string;
  createdAt: number; // 毫秒
}

/** 添加注入审计的选项 */
export interface AddKbReadOptions {
  threadId: string;
  consumer: string;
  query: string;
  entryIds: string[];
}

/** 添加提炼运行的选项 */
export interface AddDistillRunOptions {
  threadId: string;
  scopeId: string;
  status: DistillStatus;
  entriesAdded?: number;
  rawOutput?: string;
}

export class Storage {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  /** 初始化数据库表结构 */
  private initSchema(): void {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    this.db.exec(schema);
  }

  /** 生成唯一 ID */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  // ─── Agent 操作 ───────────────────────────────────────────────

  upsertAgent(config: AgentConfig): void {
    const stmt = this.db.prepare(`
      INSERT INTO agents (id, config, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config = excluded.config
    `);
    stmt.run(config.id, JSON.stringify(config), Math.floor(Date.now() / 1000));
  }

  getAgent(id: string): AgentConfig | null {
    const stmt = this.db.prepare("SELECT config FROM agents WHERE id = ?");
    const row = stmt.get(id) as { config: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.config);
  }

  listAgents(): AgentConfig[] {
    const stmt = this.db.prepare("SELECT config FROM agents");
    const rows = stmt.all() as { config: string }[];
    return rows.map((row) => JSON.parse(row.config));
  }

  // ─── Conversation 操作 ───────────────────────────────────────────

  createConversation(id?: string): Conversation {
    const convId = id ?? this.generateId();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO conversations (id, created_at, updated_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(convId, now, now);

    return { id: convId, createdAt: now, updatedAt: now };
  }

  getConversation(id: string): Conversation | null {
    const stmt = this.db.prepare(`
      SELECT id, title, created_at as createdAt, updated_at as updatedAt
      FROM conversations WHERE id = ?
    `);
    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      title: row.title ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  getOrCreateConversation(id: string): Conversation {
    let conv = this.getConversation(id);
    if (!conv) {
      conv = this.createConversation(id);
    }
    return conv;
  }

  listConversations(): Conversation[] {
    const stmt = this.db.prepare(`
      SELECT id, title, created_at as createdAt, updated_at as updatedAt
      FROM conversations
      ORDER BY updated_at DESC
    `);
    return stmt.all() as Conversation[];
  }

  touchConversation(conversationId: string): void {
    const stmt = this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?");
    stmt.run(Math.floor(Date.now() / 1000), conversationId);
  }

  // ─── Participant 操作 ────────────────────────────────────────────

  addParticipant(conversationId: string, agentId: string): Participant {
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO conversation_participants (conversation_id, agent_id, joined_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id, agent_id) DO NOTHING
    `);
    stmt.run(conversationId, agentId, now);

    return { conversationId, agentId, joinedAt: now };
  }

  getParticipants(conversationId: string): Participant[] {
    const stmt = this.db.prepare(`
      SELECT conversation_id as conversationId, agent_id as agentId, joined_at as joinedAt
      FROM conversation_participants
      WHERE conversation_id = ?
      ORDER BY joined_at ASC
    `);
    return stmt.all(conversationId) as Participant[];
  }

  getParticipantIds(conversationId: string): string[] {
    return this.getParticipants(conversationId).map((p) => p.agentId);
  }

  isParticipant(conversationId: string, agentId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM conversation_participants
      WHERE conversation_id = ? AND agent_id = ?
    `);
    return (stmt.get(conversationId, agentId) as any) !== undefined;
  }

  getAgentConversations(agentId: string): Conversation[] {
    const stmt = this.db.prepare(`
      SELECT c.id, c.title, c.created_at as createdAt, c.updated_at as updatedAt
      FROM conversations c
      JOIN conversation_participants p ON c.id = p.conversation_id
      WHERE p.agent_id = ?
      ORDER BY c.updated_at DESC
    `);
    return stmt.all(agentId) as Conversation[];
  }

  // ─── Message 操作 ───────────────────────────────────────────────

  addMessage(opts: AddMessageOptions): Message {
    const id = this.generateId();
    const createdAt = Math.floor(Date.now() / 1000);
    const mentionsJson = opts.mentions ? JSON.stringify(opts.mentions) : null;

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, agent_id, content, mentions, a2a_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      opts.conversationId,
      opts.role,
      opts.agentId ?? null,
      opts.content,
      mentionsJson,
      opts.a2aSource ?? null,
      createdAt
    );

    this.touchConversation(opts.conversationId);

    return {
      id,
      conversationId: opts.conversationId,
      role: opts.role,
      agentId: opts.agentId,
      content: opts.content,
      mentions: opts.mentions,
      a2aSource: opts.a2aSource,
      createdAt,
    };
  }

  getMessages(conversationId: string, limit?: number): Message[] {
    let sql = `
      SELECT id, conversation_id as conversationId, role, agent_id as agentId,
             content, mentions, a2a_source as a2aSource, created_at as createdAt
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `;

    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(conversationId) as any[];

    return rows.map((row) => ({
      ...row,
      agentId: row.agentId ?? undefined,
      mentions: row.mentions ? JSON.parse(row.mentions) : undefined,
      a2aSource: row.a2aSource ?? undefined,
    }));
  }

  getRecentMessages(conversationId: string, count: number): Message[] {
    const stmt = this.db.prepare(`
      SELECT id, conversation_id as conversationId, role, agent_id as agentId,
             content, mentions, a2a_source as a2aSource, created_at as createdAt
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(conversationId, count) as any[];
    return rows.reverse().map((row) => ({
      ...row,
      agentId: row.agentId ?? undefined,
      mentions: row.mentions ? JSON.parse(row.mentions) : undefined,
      a2aSource: row.a2aSource ?? undefined,
    }));
  }

  clearMessages(conversationId: string): void {
    const stmt = this.db.prepare("DELETE FROM messages WHERE conversation_id = ?");
    stmt.run(conversationId);
    this.touchConversation(conversationId);
  }

  // ─── A2A 协作链操作 ────────────────────────────────────────────

  addA2AChain(chain: Omit<A2AChain, "id" | "createdAt">): A2AChain {
    const id = this.generateId();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO a2a_chains (id, thread_id, source_agent_id, target_agent_id, trigger_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, chain.threadId, chain.sourceAgentId, chain.targetAgentId, chain.triggerMessageId, now);

    return { ...chain, id, createdAt: now };
  }

  getA2AChains(threadId: string): A2AChain[] {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, source_agent_id as sourceAgentId,
             target_agent_id as targetAgentId, trigger_message_id as triggerMessageId,
             created_at as createdAt
      FROM a2a_chains
      WHERE thread_id = ?
      ORDER BY created_at ASC
    `);
    return stmt.all(threadId) as A2AChain[];
  }

  getA2AChainsBySource(sourceAgentId: string): A2AChain[] {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, source_agent_id as sourceAgentId,
             target_agent_id as targetAgentId, trigger_message_id as triggerMessageId,
             created_at as createdAt
      FROM a2a_chains
      WHERE source_agent_id = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(sourceAgentId) as A2AChain[];
  }

  getA2AChainsByTarget(targetAgentId: string): A2AChain[] {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, source_agent_id as sourceAgentId,
             target_agent_id as targetAgentId, trigger_message_id as triggerMessageId,
             created_at as createdAt
      FROM a2a_chains
      WHERE target_agent_id = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(targetAgentId) as A2AChain[];
  }

  // ─── Workflow 执行记录操作（新增）──────────────────────────────────

  addWorkflowExecution(opts: AddWorkflowExecutionOptions): WorkflowExecution {
    const stmt = this.db.prepare(`
      INSERT INTO workflow_executions (id, thread_id, pattern_name, task, agents, status, started_at, completed_at, result, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      opts.id,
      opts.threadId,
      opts.patternName,
      opts.task,
      opts.agents,
      opts.status,
      opts.startedAt,
      opts.completedAt ?? null,
      opts.result ?? null,
      opts.error ?? null
    );

    return {
      id: opts.id,
      threadId: opts.threadId,
      patternName: opts.patternName,
      task: opts.task,
      agents: JSON.parse(opts.agents),
      status: opts.status,
      startedAt: opts.startedAt,
      completedAt: opts.completedAt,
      result: opts.result,
      error: opts.error,
    };
  }

  updateWorkflowExecution(id: string, updates: Partial<WorkflowExecution>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt);
    }
    if (updates.result !== undefined) {
      fields.push("result = ?");
      values.push(updates.result);
    }
    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error);
    }

    if (fields.length === 0) return;

    values.push(id);
    const sql = `UPDATE workflow_executions SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }

  getWorkflowExecution(id: string): WorkflowExecution | null {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, pattern_name as patternName, task, agents, status,
             started_at as startedAt, completed_at as completedAt, result, error
      FROM workflow_executions
      WHERE id = ?
    `);
    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      ...row,
      agents: JSON.parse(row.agents),
    };
  }

  getWorkflowExecutionsByThread(threadId: string): WorkflowExecution[] {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, pattern_name as patternName, task, agents, status,
             started_at as startedAt, completed_at as completedAt, result, error
      FROM workflow_executions
      WHERE thread_id = ?
      ORDER BY started_at DESC
    `);
    const rows = stmt.all(threadId) as any[];
    return rows.map((row) => ({
      ...row,
      agents: JSON.parse(row.agents),
    }));
  }

  getRunningWorkflowExecutions(): WorkflowExecution[] {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, pattern_name as patternName, task, agents, status,
             started_at as startedAt, completed_at as completedAt, result, error
      FROM workflow_executions
      WHERE status = 'running'
      ORDER BY started_at DESC
    `);
    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      ...row,
      agents: JSON.parse(row.agents),
    }));
  }

  // ─── Workflow 步骤记录操作（新增）──────────────────────────────────

  addWorkflowStep(opts: AddWorkflowStepOptions): WorkflowStep {
    const id = this.generateId();

    const stmt = this.db.prepare(`
      INSERT INTO workflow_steps (id, execution_id, step_number, agent_id, input_text, output_text, timestamp, duration, success, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      opts.executionId,
      opts.stepNumber,
      opts.agentId,
      opts.inputText,
      opts.outputText,
      opts.timestamp,
      opts.duration,
      opts.success,
      opts.error ?? null
    );

    return {
      id,
      executionId: opts.executionId,
      stepNumber: opts.stepNumber,
      agentId: opts.agentId,
      inputText: opts.inputText,
      outputText: opts.outputText,
      timestamp: opts.timestamp,
      duration: opts.duration,
      success: opts.success === 1,
      error: opts.error ?? undefined,
    };
  }

  getWorkflowSteps(executionId: string): WorkflowStep[] {
    const stmt = this.db.prepare(`
      SELECT id, execution_id as executionId, step_number as stepNumber, agent_id as agentId,
             input_text as inputText, output_text as outputText, timestamp, duration, success, error
      FROM workflow_steps
      WHERE execution_id = ?
      ORDER BY step_number ASC
    `);
    return stmt.all(executionId) as any[];
  }

  // ─── 工具调用记录操作（Phase 6 新增）──────────────────────────

  addToolCall(opts: AddToolCallOptions): ToolCall {
    const id = this.generateId();
    const createdAt = opts.createdAt ?? Date.now(); // 毫秒，显式插入

    const stmt = this.db.prepare(`
      INSERT INTO tool_calls (id, thread_id, agent_id, tool_name, tool_use_id, input, output, status, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      opts.threadId,
      opts.agentId,
      opts.toolName,
      opts.toolUseId ?? null,
      opts.input ?? null,
      opts.output ?? null,
      opts.status,
      opts.durationMs,
      createdAt
    );

    return {
      id,
      threadId: opts.threadId,
      agentId: opts.agentId,
      toolName: opts.toolName,
      toolUseId: opts.toolUseId,
      input: opts.input,
      output: opts.output,
      status: opts.status,
      durationMs: opts.durationMs,
      createdAt,
    };
  }

  getToolCallsByThread(threadId: string): ToolCall[] {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, agent_id as agentId, tool_name as toolName,
             tool_use_id as toolUseId, input, output, status, duration_ms as durationMs,
             created_at as createdAt
      FROM tool_calls
      WHERE thread_id = ?
      ORDER BY created_at ASC
    `);
    return stmt.all(threadId) as ToolCall[];
  }

  // ─── 知识库操作（Phase 7 新增）──────────────────────────────────

  /** 新增知识条目（毫秒时间戳显式插入） */
  addKbEntry(opts: AddKbEntryOptions): Evidence {
    const id = this.generateId();
    const createdAt = opts.createdAt ?? Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO kb_entries (id, type, title, content, keywords, source_thread, source_agent, verified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      opts.type,
      opts.title,
      opts.content,
      opts.keywords ? JSON.stringify(opts.keywords) : null,
      opts.sourceThread ?? null,
      opts.sourceAgent ?? null,
      opts.verified ? 1 : 0,
      createdAt
    );

    return {
      id,
      type: opts.type,
      title: opts.title,
      content: opts.content,
      keywords: opts.keywords ?? [],
      sourceThread: opts.sourceThread,
      sourceAgent: opts.sourceAgent,
      timestamp: createdAt,
      verified: !!opts.verified,
    };
  }

  /** 获取单条知识条目 */
  getKbEntry(id: string): Evidence | null {
    const stmt = this.db.prepare(`
      SELECT id, type, title, content, keywords, source_thread as sourceThread,
             source_agent as sourceAgent, verified, created_at as timestamp
      FROM kb_entries WHERE id = ?
    `);
    const row = stmt.get(id) as any;
    return row ? this.rowToKbEntry(row) : null;
  }

  /** 列出知识条目（时间倒序，可过滤 type/来源线程） */
  listKbEntries(opts?: ListKbEntriesOptions): Evidence[] {
    const clauses: string[] = [];
    const params: any[] = [];

    if (opts?.type) {
      clauses.push("type = ?");
      params.push(opts.type);
    }
    if (opts?.sourceThread) {
      clauses.push("source_thread = ?");
      params.push(opts.sourceThread);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts?.limit ?? -1; // SQLite: LIMIT -1 = unbounded

    const stmt = this.db.prepare(`
      SELECT id, type, title, content, keywords, source_thread as sourceThread,
             source_agent as sourceAgent, verified, created_at as timestamp
      FROM kb_entries ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as any[];
    return rows.map((r) => this.rowToKbEntry(r));
  }

  /** 删除知识条目（返回是否删到） */
  deleteKbEntry(id: string): boolean {
    const info = this.db.prepare("DELETE FROM kb_entries WHERE id = ?").run(id);
    return info.changes === 1;
  }

  /** 设置知识条目 verified（人工背书） */
  setKbEntryVerified(id: string, verified: boolean): boolean {
    const info = this.db
      .prepare("UPDATE kb_entries SET verified = ? WHERE id = ?")
      .run(verified ? 1 : 0, id);
    return info.changes === 1;
  }

  /** 同线程内按 title 查重（Distiller 条目级幂等） */
  getKbEntryByTitle(title: string, sourceThread: string): Evidence | null {
    const stmt = this.db.prepare(`
      SELECT id, type, title, content, keywords, source_thread as sourceThread,
             source_agent as sourceAgent, verified, created_at as timestamp
      FROM kb_entries WHERE title = ? AND source_thread = ? LIMIT 1
    `);
    const row = stmt.get(title, sourceThread) as any;
    return row ? this.rowToKbEntry(row) : null;
  }

  /** 记录一次记忆注入（审计，--show-memory 数据源） */
  addKbRead(opts: AddKbReadOptions): void {
    const id = this.generateId();
    this.db
      .prepare(`
        INSERT INTO kb_reads (id, thread_id, consumer, query, entry_ids, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        opts.threadId,
        opts.consumer,
        opts.query,
        JSON.stringify(opts.entryIds),
        Date.now()
      );
  }

  /** 获取会话的记忆注入记录 */
  getKbReadsByThread(threadId: string): KbRead[] {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, consumer, query, entry_ids as entryIds,
             created_at as createdAt
      FROM kb_reads
      WHERE thread_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(threadId) as any[];
    return rows.map((r) => ({
      ...r,
      entryIds: JSON.parse(r.entryIds),
    }));
  }

  /** 记录一次提炼运行（幂等 + 失败显形） */
  addDistillRun(opts: AddDistillRunOptions): void {
    const id = this.generateId();
    this.db
      .prepare(`
        INSERT INTO kb_distill_runs (id, thread_id, scope_id, status, entries_added, raw_output, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        opts.threadId,
        opts.scopeId,
        opts.status,
        opts.entriesAdded ?? 0,
        opts.rawOutput ?? null,
        Date.now()
      );
  }

  /** 获取某 scope 最近一次提炼运行（幂等判断用；rowid tiebreak 保证同毫秒写入排序确定） */
  getLatestDistillRun(scopeId: string): KbDistillRun | null {
    const stmt = this.db.prepare(`
      SELECT id, thread_id as threadId, scope_id as scopeId, status,
             entries_added as entriesAdded, raw_output as rawOutput,
             created_at as createdAt
      FROM kb_distill_runs
      WHERE scope_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `);
    const row = stmt.get(scopeId) as any;
    return row
      ? {
          ...row,
          rawOutput: row.rawOutput ?? undefined,
        }
      : null;
  }

  /** kb_entries 行 → Evidence */
  private rowToKbEntry(row: any): Evidence {
    return {
      id: row.id,
      type: row.type as EvidenceType,
      title: row.title,
      content: row.content,
      keywords: row.keywords ? JSON.parse(row.keywords) : [],
      sourceThread: row.sourceThread ?? undefined,
      sourceAgent: row.sourceAgent ?? undefined,
      timestamp: row.timestamp,
      verified: !!row.verified,
    };
  }

  // ─── 清理 ───────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
