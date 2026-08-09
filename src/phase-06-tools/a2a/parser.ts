/**
 * Phase 4 — A2A Parser（Agent 间提及解析器）
 *
 * 职责：
 * - 从 Agent 回复中提取 @mention
 * - 过滤代码块和举例中的 @
 * - 判断是否应该触发 A2A 协作
 *
 * 与 MentionParser 的区别：
 * - MentionParser: 解析用户输入，只识别行首的 @
 * - A2AParser: 解析 Agent 回复，识别文中所有的 @（但过滤代码块）
 */

/** 解析结果 */
export interface A2AParseResult {
  /** 提取到的 @mention 目标列表 */
  mentions: string[];
  /** 是否应该触发 A2A 协作 */
  shouldTrigger: boolean;
  /** 触发原因（用于调试） */
  reason?: string;
}

export class A2AParser {
  /**
   * 正则模式：匹配文中所有的 @word（不限行首）
   * - `@([\w-]+)`: @ 后跟单词字符或连字符
   * - `(?=\s|$|[.，。！？,!?])`: 后面是空格/行尾/标点
   */
  private static readonly MENTION_PATTERN = /@([\w-]+)(?=\s|$|[.，。！？,!?])/g;

  /**
   * 代码块检测正则
   */
  private static readonly CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

  /**
   * 从 Agent 回复中提取 @mention
   * @param reply Agent 回复内容
   * @param availableIds 可用的 Agent ID 集合
   */
  parseFromAgentReply(reply: string, availableIds: Set<string>): string[] {
    // 先移除代码块中的内容（避免误识别）
    let cleaned = this.removeCodeBlocks(reply);

    // 移除 markdown 格式（** bold**, __ italic__, etc.）
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1"); // **bold**
    cleaned = cleaned.replace(/__([^_]+)__/g, "$1");   // __italic__
    cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");    // *italic*
    cleaned = cleaned.replace(/_([^_]+)_/g, "$1");      // _italic_

    const mentions: string[] = [];
    let match: RegExpExecArray | null;

    // 重置正则
    A2AParser.MENTION_PATTERN.lastIndex = 0;

    while ((match = A2AParser.MENTION_PATTERN.exec(cleaned)) !== null) {
      const handle = match[1];
      // 只添加可用的 Agent
      if (availableIds.has(handle) && !mentions.includes(handle)) {
        mentions.push(handle);
      }
    }

    return mentions;
  }

  /**
   * 判断 Agent 回复是否应该触发 A2A
   * @param reply Agent 回复内容
   * @param mentions 提取到的 @mention 列表
   */
  shouldTriggerA2A(reply: string, mentions: string[]): boolean {
    // 没有 @mention，不触发
    if (mentions.length === 0) {
      return false;
    }

    // 检查是否在举例（常见模式）
    if (this.isExampleCase(reply)) {
      return false;
    }

    // 检查是否在解释代码
    if (this.isCodeExplanation(reply)) {
      return false;
    }

    // 有有效的 @mention，触发
    return true;
  }

  /**
   * 完整解析：提取 mentions 并判断是否触发
   */
  parse(reply: string, availableIds: Set<string>): A2AParseResult {
    const mentions = this.parseFromAgentReply(reply, availableIds);
    const shouldTrigger = this.shouldTriggerA2A(reply, mentions);

    let reason: string | undefined;
    if (shouldTrigger) {
      reason = `检测到 ${mentions.length} 个有效的 @mention`;
    } else if (mentions.length > 0) {
      if (this.isExampleCase(reply)) {
        reason = "在举例中，不触发";
      } else if (this.isCodeExplanation(reply)) {
        reason = "在解释代码，不触发";
      } else {
        reason = "其他原因，不触发";
      }
    }

    return { mentions, shouldTrigger, reason };
  }

  /**
   * 移除代码块
   */
  private removeCodeBlocks(text: string): string {
    return text.replace(A2AParser.CODE_BLOCK_PATTERN, "```");
  }

  /**
   * 检查是否在举例
   * 常见举例模式：
   * - "像 @alice 这样"
   * - "例如 @bob"
   * - "比如 @carol"
   */
  private isExampleCase(reply: string): boolean {
    const examplePatterns = [
      /像\s+@[\w-]+\s+这样/,
      /例如\s+@[\w-]+/,
      /比如\s+@[\w-]+/,
      /如\s+@[\w-]+\s+所示/,
    ];

    return examplePatterns.some((pattern) => pattern.test(reply));
  }

  /**
   * 检查是否在解释代码
   * 常见模式：
   * - "这行代码调用了 @xxx 函数"
   * - "在代码中 @xxx 表示..."
   */
  private isCodeExplanation(reply: string): boolean {
    const codeExplanationPatterns = [
      /这行|这段|这个.*@[\w-]+/,
      /在代码中.*@[\w-]+/,
      /函数\s+@[\w-]+/,
      /方法\s+@[\w-]+/,
    ];

    return codeExplanationPatterns.some((pattern) => pattern.test(reply));
  }

  /**
   * 从回复中提取所有 @mention（包括无效的，用于调试）
   */
  extractAllMentions(reply: string): string[] {
    const withoutCodeBlocks = this.removeCodeBlocks(reply);
    const mentions: string[] = [];
    let match: RegExpExecArray | null;

    A2AParser.MENTION_PATTERN.lastIndex = 0;
    while ((match = A2AParser.MENTION_PATTERN.exec(withoutCodeBlocks)) !== null) {
      const handle = match[1];
      if (!mentions.includes(handle)) {
        mentions.push(handle);
      }
    }

    return mentions;
  }
}
