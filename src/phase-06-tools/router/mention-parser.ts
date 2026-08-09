/**
 * Phase 3 — 提及解析器
 *
 * 职责：
 * - 从用户输入中提取 @handle
 * - 净化内容（移除 @mention）
 * - 处理边界情况（代码块、转义等）
 */

/** 解析结果 */
export interface ParsedInput {
  /** 提取到的 @mention 目标列表 */
  mentions: string[];
  /** 移除 @mention 后的纯净内容 */
  cleanContent: string;
}

export class MentionParser {
  /**
   * 正则模式：匹配行首或换行后的 @word
   * - `(?:^|\n)`: 行首或换行符
   * - `@([\w-]+)`: @ 后跟单词字符或连字符（handle）
   * - `(?=\s|$)`: 后面是空格或行尾（正向预查，不消耗字符）
   */
  private static readonly MENTION_PATTERN = /(?:^|\n)@([\w-]+)(?=\s|$)/g;

  /**
   * 解析用户输入
   * @param input 用户原始输入
   * @returns 提取到的 mentions 和净化后的内容
   */
  parse(input: string): ParsedInput {
    // 去除首尾空白
    const trimmed = input.trim();

    // 如果输入为空，返回空结果
    if (!trimmed) {
      return { mentions: [], cleanContent: "" };
    }

    // 提取 mentions
    const mentions = this.extractMentions(trimmed);

    // 移除 mentions，得到纯净内容
    const cleanContent = this.stripMentions(trimmed);

    return { mentions, cleanContent: cleanContent.trim() };
  }

  /**
   * 提取 @mention 目标列表
   * @param input 用户输入
   * @returns handle 列表，如 ["alice", "bob"]
   */
  extractMentions(input: string): string[] {
    const mentions: string[] = [];
    let match: RegExpExecArray | null;

    // 重置正则的 lastIndex
    MentionParser.MENTION_PATTERN.lastIndex = 0;

    // 执行全局匹配
    while ((match = MentionParser.MENTION_PATTERN.exec(input)) !== null) {
      const handle = match[1];
      // 去重（同一行多次 @ 同一个人只算一次）
      if (!mentions.includes(handle)) {
        mentions.push(handle);
      }
    }

    return mentions;
  }

  /**
   * 移除 @mention，返回"真正的内容"
   * @param input 用户输入
   * @returns 移除 @mention 后的内容
   */
  stripMentions(input: string): string {
    // 替换掉所有 @mention 行
    return input.replace(MentionParser.MENTION_PATTERN, "").trim();
  }

  /**
   * 检查输入是否包含 @mention
   * @param input 用户输入
   * @returns 是否包含 @mention
   */
  hasMention(input: string): boolean {
    MentionParser.MENTION_PATTERN.lastIndex = 0;
    return MentionParser.MENTION_PATTERN.test(input);
  }

  /**
   * 解析并验证 mentions（结合 AgentRegistry）
   * @param input 用户输入
   * @param availableIds 可用的 Agent ID 列表
   * @returns 解析结果，过滤掉无效的 mentions
   */
  parseWithValidation(input: string, availableIds: Set<string>): ParsedInput {
    const parsed = this.parse(input);

    // 过滤掉不存在的 Agent
    const validMentions = parsed.mentions.filter((m) => availableIds.has(m));

    return {
      mentions: validMentions,
      cleanContent: parsed.cleanContent,
    };
  }
}
