/**
 * Phase 7 — KnowledgeBase（知识库：长期共享记忆）
 *
 * 对应「核心心智模型」抽象 ④ Shared State 的长期层。
 * 短期层是 Thread（会话内共享）；本类是跨会话、跨 Agent 的决策/经验/证据库。
 *
 * 职责：
 * - 条目生命周期（add/get/remove/list/stats）
 * - 检索：keywords/title/content 加权评分（FTS5 因 CJK 分词限制弃用，见 ADR-011）
 * - buildMemoryContext：注入链唯一入口（全局检索 ∪ 本会话沉淀，按 id 去重）
 *
 * 设计：评分逻辑放 JS（可脱离 DB 单测），Storage 只做行级 CRUD。
 */

import type { Storage } from "../storage/sqlite.js";
import type { Evidence, EvidenceType, KbStats, NewEvidence, KbSearchHit } from "./types.js";
import { EVIDENCE_TYPES } from "./types.js";

/** 检索评分权重 */
const WEIGHT_KEYWORD = 10; // 结构化主路径：keywords 精确/包含命中
const WEIGHT_TITLE = 4; // 标题子串命中
const WEIGHT_CONTENT = 2; // 正文子串命中

/** query 切词上限（防长查询拖慢评分） */
const MAX_TERMS = 8;

/** 停用词（切词后过滤，减少噪声命中） */
const STOPWORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "a", "an", "the", "of", "to", "in", "is", "it", "for", "on", "with", "怎么", "什么", "如何",
]);

export class KnowledgeBase {
  constructor(private storage: Storage) {}

  /** 新增条目（id/timestamp 由库生成） */
  add(entry: NewEvidence): Evidence {
    return this.storage.addKbEntry(entry);
  }

  /** 获取单条 */
  get(id: string): Evidence | null {
    return this.storage.getKbEntry(id);
  }

  /** 删除（返回是否删到） */
  remove(id: string): boolean {
    return this.storage.deleteKbEntry(id);
  }

  /** 同线程同标题查重（Distiller 条目级幂等用） */
  findByTitle(title: string, threadId: string): Evidence | null {
    return this.storage.getKbEntryByTitle(title, threadId);
  }

  /** 列出（时间倒序，可过滤） */
  list(opts?: { type?: EvidenceType; limit?: number }): Evidence[] {
    return this.storage.listKbEntries(opts);
  }

  /**
   * 检索：加权评分，返回带 score 的命中列表（可观测检索质量）
   *
   * terms = query 切词（最多 MAX_TERMS，小写化）
   * 每条目逐 term：keywords 命中 +10 / title +4 / content +2
   * recency 微扰 tiebreak：score * (1 + 1/(1+ageDays))
   */
  search(query: string, opts?: { limit?: number; type?: EvidenceType }): KbSearchHit[] {
    const terms = this.tokenize(query);
    if (terms.length === 0) return [];

    const entries = this.storage.listKbEntries(opts?.type ? { type: opts.type } : undefined);
    const now = Date.now();

    const hits: KbSearchHit[] = [];
    for (const entry of entries) {
      const keywordsLower = entry.keywords.map((k) => k.toLowerCase());
      const titleLower = entry.title.toLowerCase();
      const contentLower = entry.content.toLowerCase();

      let score = 0;
      for (const term of terms) {
        // 双向包含：keyword ⊇ term（query 分词后）或 term ⊇ keyword
        // （连续中文无空格时整个 query 是一个 token，必须允许 keyword 是其子串）
        if (keywordsLower.some((k) => k.includes(term) || term.includes(k))) score += WEIGHT_KEYWORD;
        else if (titleLower.includes(term) || term.includes(titleLower)) score += WEIGHT_TITLE;
        else if (contentLower.includes(term)) score += WEIGHT_CONTENT;
      }
      if (score <= 0) continue;

      // recency 微扰：同分时新条目略胜（ageDays=0 → ×2，ageDays=30 → ×1.03）
      const ageDays = (now - entry.timestamp) / (24 * 60 * 60 * 1000);
      const adjusted = score * (1 + 1 / (1 + ageDays));

      hits.push({ entry, score: Math.round(adjusted * 100) / 100 });
    }

    hits.sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp);
    return opts?.limit ? hits.slice(0, opts.limit) : hits;
  }

  /** 本会话沉淀（source_thread = threadId，时间倒序） */
  getThreadContext(threadId: string, limit = 3): Evidence[] {
    return this.storage.listKbEntries({ sourceThread: threadId, limit });
  }

  /**
   * 注入链唯一入口：全局检索 ∪ 本会话沉淀，按 id 去重
   *
   * 本会话沉淀的价值：pattern 中间步产出只落 workflow_steps 不落 messages，
   * 续聊时 Thread 历史不含它们——靠这里补回。
   */
  buildMemoryContext(
    query: string,
    threadId: string,
    opts?: { limit?: number; threadLimit?: number }
  ): Evidence[] {
    const limit = opts?.limit ?? 5;
    const threadLimit = opts?.threadLimit ?? 3;

    const globalHits = this.search(query, { limit });
    const threadEntries = this.getThreadContext(threadId, threadLimit);

    const seen = new Set<string>();
    const merged: Evidence[] = [];
    for (const e of [...globalHits.map((h) => h.entry), ...threadEntries]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      merged.push(e);
    }
    return merged;
  }

  /** 统计 */
  stats(): KbStats {
    const all = this.storage.listKbEntries();
    const byType = Object.fromEntries(
      EVIDENCE_TYPES.map((t) => [t, 0])
    ) as Record<EvidenceType, number>;
    const threads = new Set<string>();
    let verified = 0;
    let lastAddedAt: number | undefined;

    for (const e of all) {
      byType[e.type]++;
      if (e.sourceThread) threads.add(e.sourceThread);
      if (e.verified) verified++;
      if (lastAddedAt === undefined || e.timestamp > lastAddedAt) lastAddedAt = e.timestamp;
    }

    return {
      total: all.length,
      byType,
      threads: threads.size,
      verified,
      lastAddedAt,
    };
  }

  /** query → terms：按空白/常见标点切分，小写化，去停用词，截 MAX_TERMS */
  private tokenize(query: string): string[] {
    return query
      .split(/[\s,，、;；。.!！?？()（）]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
      .slice(0, MAX_TERMS);
  }
}
