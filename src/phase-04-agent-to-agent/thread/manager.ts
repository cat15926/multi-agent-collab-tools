/**
 * Phase 3 — Thread Manager（会话管理器）
 *
 * 职责：
 * - 管理会话生命周期（创建、获取、更新）
 * - 管理参与者（添加、查询）
 * - 提供会话历史查询接口
 */

import type { Storage } from "../storage/sqlite.js";
import type { Thread, ThreadOptions } from "./thread.js";
import type { Message } from "../storage/sqlite.js";

export class ThreadManager {
  constructor(private storage: Storage) {}

  /**
   * 获取或创建会话
   * @param threadId 会话 ID（可选，未提供则创建新会话）
   * @returns Thread 对象
   */
  async getOrCreate(threadId?: string): Promise<Thread> {
    if (threadId) {
      const thread = await this.get(threadId);
      if (thread) {
        return thread;
      }
    }

    // 创建新会话
    return this.create(threadId ? { id: threadId } : undefined);
  }

  /**
   * 创建新会话
   * @param options 会话选项
   * @returns 新创建的 Thread
   */
  async create(options?: ThreadOptions): Promise<Thread> {
    const id = options?.id ?? this.generateId();
    const now = Math.floor(Date.now() / 1000);

    // 在数据库中创建会话
    this.storage.createConversation(id);

    return {
      id,
      title: options?.title,
      participants: options?.participants ?? [],
      status: options?.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 获取会话
   * @param threadId 会话 ID
   * @returns Thread 对象，不存在则返回 null
   */
  async get(threadId: string): Promise<Thread | null> {
    const conv = this.storage.getConversation(threadId);
    if (!conv) {
      return null;
    }

    const participants = this.storage.getParticipantIds(threadId);

    return {
      id: conv.id,
      title: conv.title,
      participants,
      status: "active",
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    };
  }

  /**
   * 添加参与者到会话
   * @param threadId 会话 ID
   * @param agentId Agent ID
   */
  async addParticipant(threadId: string, agentId: string): Promise<void> {
    // 检查是否已经是参与者
    if (this.storage.isParticipant(threadId, agentId)) {
      return;
    }

    this.storage.addParticipant(threadId, agentId);
  }

  /**
   * 获取会话的所有参与者
   * @param threadId 会话 ID
   * @returns参与者 ID 列表
   */
  getParticipants(threadId: string): string[] {
    return this.storage.getParticipantIds(threadId);
  }

  /**
   * 获取会话的完整历史
   * @param threadId 会话 ID
   * @returns 消息列表（按时间正序）
   */
  getHistory(threadId: string): Message[] {
    return this.storage.getMessages(threadId);
  }

  /**
   * 列出所有会话
   * @returns 所有会话列表（按更新时间倒序）
   */
  async listAll(): Promise<Thread[]> {
    const conversations = this.storage.listConversations();
    const threads: Thread[] = [];

    for (const conv of conversations) {
      const participants = this.storage.getParticipantIds(conv.id);
      threads.push({
        id: conv.id,
        title: conv.title,
        participants,
        status: "active",
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      });
    }

    return threads;
  }

  /**
   * 获取 Agent 参与的所有会话
   * @param agentId Agent ID
   * @returns 会话列表
   */
  async listForAgent(agentId: string): Promise<Thread[]> {
    const conversations = this.storage.getAgentConversations(agentId);
    const threads: Thread[] = [];

    for (const conv of conversations) {
      const participants = this.storage.getParticipantIds(conv.id);
      threads.push({
        id: conv.id,
        title: conv.title,
        participants,
        status: "active",
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      });
    }

    return threads;
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `thread-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}
