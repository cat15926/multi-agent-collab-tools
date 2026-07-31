/**
 * Phase 2 — SQLite 存储层
 *
 * 职责：
 * - 数据库初始化和 schema 管理
 * - Agent/Conversation/Message 的 CRUD 操作
 * - 会话管理（Phase 2 只支持单会话，但预留扩展空间）
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

/** 消息结构 */
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
}

/** 会话结构 */
export interface Conversation {
  id: string;
  agentId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
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

export class Storage {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
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

  /** 获取或创建默认会话 */
  getOrCreateDefaultConversation(agentId: string): Conversation {
    // Phase 2: 只使用一个固定的默认会话 ID
    const defaultId = "default";

    const stmt = this.db.prepare(`
      SELECT id, agent_id, title, created_at, updated_at
      FROM conversations WHERE id = ?
    `);

    let row = stmt.get(defaultId) as any;

    if (!row) {
      const insertStmt = this.db.prepare(`
        INSERT INTO conversations (id, agent_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      const now = Math.floor(Date.now() / 1000);
      insertStmt.run(defaultId, agentId, now, now);

      row = { id: defaultId, agent_id: agentId, title: null, created_at: now, updated_at: now };
    }

    return {
      id: row.id,
      agentId: row.agent_id,
      title: row.title ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 更新会话更新时间 */
  touchConversation(conversationId: string): void {
    const stmt = this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?");
    stmt.run(Math.floor(Date.now() / 1000), conversationId);
  }

  // ─── Message 操作 ───────────────────────────────────────────────

  /** 添加消息 */
  addMessage(conversationId: string, role: MessageRole, content: string): Message {
    const id = this.generateId();
    const createdAt = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, conversationId, role, content, createdAt);

    // 更新会话的 updated_at
    this.touchConversation(conversationId);

    return { id, conversationId, role, content, createdAt };
  }

  /** 获取会话的所有消息（按时间正序） */
  getMessages(conversationId: string, limit?: number): Message[] {
    let sql = `
      SELECT id, conversation_id as conversationId, role, content, created_at as createdAt
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `;

    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(conversationId) as Message[];
  }

  /** 获取最近的 N 条消息（用于上下文窗口） */
  getRecentMessages(conversationId: string, count: number): Message[] {
    const stmt = this.db.prepare(`
      SELECT id, conversation_id as conversationId, role, content, created_at as createdAt
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    // DESC 取回来是倒序的，需要反转
    return stmt.all(conversationId, count).reverse() as Message[];
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
