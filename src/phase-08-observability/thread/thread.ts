/**
 * Phase 3 — Thread（会话）数据结构
 *
 * 职责：
 * - 定义会话的数据模型
 * - 管理会话元数据和参与者
 */

/** 会话状态 */
export type ThreadStatus = "active" | "archived";

/** Thread 结构 */
export interface Thread {
  /** 会话 ID */
  id: string;
  /** 会话标题（可选，可由内容生成） */
  title?: string;
  /** 参与者 ID 列表（包括 "user" 和 Agent ID） */
  participants: string[];
  /** 会话状态 */
  status: ThreadStatus;
  /** 创建时间（Unix 秒） */
  createdAt: number;
  /** 最后更新时间（Unix 秒） */
  updatedAt: number;
}

/** Thread 创建选项 */
export interface ThreadOptions {
  id?: string;
  title?: string;
  participants?: string[];
  status?: ThreadStatus;
}
