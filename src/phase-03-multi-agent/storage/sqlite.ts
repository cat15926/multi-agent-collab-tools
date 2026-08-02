/**
 * Phase 3 — SQLite 存储层（扩展版）
 *
 * 相比 Phase 2 的变化：
 * - Conversation 不再绑定单一 Agent
 * - 新增 conversation_participants 表的操作
 * - Message 新增 agent_id 和 mentions 字段
 * - 新增 Thread 相关查询
 *
 * 职责：
 * - 数据库初始化和 schema 管理
 * - Agent/Conversation/Participant/Message 的 CRUD 操作
 * - Thread 隔离的查询支持
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

/** 消息结构（Phase 3 扩展） */
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  agentId?: string;        // 新增：哪个 Agent 回复的
  content: string;
  mentions?: string[];    // 新增：@mention 目标列表
  createdAt: number;
}

/** 会话结构（Phase 3 简化） */
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

/** 添加消息的选项 */
export interface AddMessageOptions {
  conversationId: string;
  role: MessageRole;
  content: string;
  agentId?: string;      // assistant 消息必需
  mentions?: string[];    // user 消息的 @mention 目标
}

export class Storage {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? DB_PATH);
    this.db.pragma("journal_mode = WAL"); // WAL 模式，更好的并发性能
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

  /** 保存或更新 Agent 配置 */
  upsertAgent(config: AgentConfig): void {
    const stmt = this.db.prepare(`
      INSERT INTO agents (id, config, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config = excluded.config
    `);
    stmt.run(config.id, JSON.stringify(config), Math.floor(Date.now() / 1000));
  }

  /** 获取 Agent 配置 */
  getAgent(id: string): AgentConfig | null {
    const stmt = this.db.prepare("SELECT config FROM agents WHERE id = ?");
    const row = stmt.get(id) as { config: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.config);
  }

  /** 列出所有 Agent */
  listAgents(): AgentConfig[] {
    const stmt = this.db.prepare("SELECT config FROM agents");
    const rows = stmt.all() as { config: string }[];
    return rows.map((row) => JSON.parse(row.config));
  }

  // ─── Conversation 操作 ───────────────────────────────────────────

  /** 创建新会话 */
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

  /** 获取会话 */
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

  /** 获取或创建会话 */
  getOrCreateConversation(id: string): Conversation {
    let conv = this.getConversation(id);
    if (!conv) {
      conv = this.createConversation(id);
    }
    return conv;
  }

  /** 列出所有会话 */
  listConversations(): Conversation[] {
    const stmt = this.db.prepare(`
      SELECT id, title, created_at as createdAt, updated_at as updatedAt
      FROM conversations
      ORDER BY updated_at DESC
    `);
    return stmt.all() as Conversation[];
  }

  /** 更新会话更新时间 */
  touchConversation(conversationId: string): void {
    const stmt = this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?");
    stmt.run(Math.floor(Date.now() / 1000), conversationId);
  }

  // ─── Participant 操作（新增）───────────────────────────────────────

  /** 添加参与者到会话 */
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

  /** 获取会话的所有参与者 */
  getParticipants(conversationId: string): Participant[] {
    const stmt = this.db.prepare(`
      SELECT conversation_id as conversationId, agent_id as agentId, joined_at as joinedAt
      FROM conversation_participants
      WHERE conversation_id = ?
      ORDER BY joined_at ASC
    `);
    return stmt.all(conversationId) as Participant[];
  }

  /** 获取参与者 ID 列表（便捷方法） */
  getParticipantIds(conversationId: string): string[] {
    return this.getParticipants(conversationId).map((p) => p.agentId);
  }

  /** 检查 Agent 是否是会话参与者 */
  isParticipant(conversationId: string, agentId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM conversation_participants
      WHERE conversation_id = ? AND agent_id = ?
    `);
    return (stmt.get(conversationId, agentId) as any) !== undefined;
  }

  /** 获取 Agent 参与的所有会话 */
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

  // ─── Message 操作（扩展）──────────────────────────────────────────

  /** 添加消息（Phase 3 扩展版） */
  addMessage(opts: AddMessageOptions): Message {
    const id = this.generateId();
    const createdAt = Math.floor(Date.now() / 1000);
    const mentionsJson = opts.mentions ? JSON.stringify(opts.mentions) : null;

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, agent_id, content, mentions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      opts.conversationId,
      opts.role,
      opts.agentId ?? null,
      opts.content,
      mentionsJson,
      createdAt
    );

    // 更新会话的 updated_at
    this.touchConversation(opts.conversationId);

    return {
      id,
      conversationId: opts.conversationId,
      role: opts.role,
      agentId: opts.agentId,
      content: opts.content,
      mentions: opts.mentions,
      createdAt,
    };
  }

  /** 获取会话的所有消息（按时间正序） */
  getMessages(conversationId: string, limit?: number): Message[] {
    let sql = `
      SELECT id, conversation_id as conversationId, role, agent_id as agentId,
             content, mentions, created_at as createdAt
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
    }));
  }

  /** 获取最近的 N 条消息（用于上下文窗口） */
  getRecentMessages(conversationId: string, count: number): Message[] {
    const stmt = this.db.prepare(`
      SELECT id, conversation_id as conversationId, role, agent_id as agentId,
             content, mentions, created_at as createdAt
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    // DESC 取回来是倒序的，需要反转
    const rows = stmt.all(conversationId, count) as any[];
    return rows.reverse().map((row) => ({
      ...row,
      agentId: row.agentId ?? undefined,
      mentions: row.mentions ? JSON.parse(row.mentions) : undefined,
    }));
  }

  /** 清空会话消息（用于测试或重置） */
  clearMessages(conversationId: string): void {
    const stmt = this.db.prepare("DELETE FROM messages WHERE conversation_id = ?");
    stmt.run(conversationId);
    this.touchConversation(conversationId);
  }

  // ─── 清理 ───────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
