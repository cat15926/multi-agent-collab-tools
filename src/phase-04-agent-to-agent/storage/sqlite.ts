/**
 * Phase 4 — SQLite 存储层（A2A 扩展版）
 *
 * 相比 Phase 3 的变化：
 * - Message 新增 a2aSource 字段（记录触发 Agent）
 * - 新增 A2AChain 相关操作
 * - 新增协作链追踪方法
 *
 * 职责：
 * - 数据库初始化和 schema 管理
 * - Agent/Conversation/Participant/Message 的 CRUD 操作
 * - A2A 协作链的追踪和查询
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

/** 消息结构（Phase 4 扩展） */
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  agentId?: string;
  content: string;
  mentions?: string[];
  createdAt: number;
  a2aSource?: string;      // 新增：触发此消息的 Agent ID
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

/** 添加消息的选项（Phase 4 扩展） */
export interface AddMessageOptions {
  conversationId: string;
  role: MessageRole;
  content: string;
  agentId?: string;
  mentions?: string[];
  a2aSource?: string;      // 新增：A2A 触发源
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

  // ─── Message 操作（Phase 4 扩展）──────────────────────────────────

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

  // ─── A2A 协作链操作（新增）───────────────────────────────────────

  /** 添加协作链记录 */
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

  /** 获取会话的所有协作链 */
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

  /** 获取 Agent 发起的所有协作 */
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

  /** 获取 Agent 被召唤的所有协作 */
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

  // ─── 清理 ───────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
