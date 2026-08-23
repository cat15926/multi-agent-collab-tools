/**
 * Phase 5 — Pattern Registry（协作模式注册表）
 *
 * 管理所有可用的 Pattern
 */

import type { Pattern } from "./base.js";
import type { PatternConfig } from "./context.js";

/** Pattern 注册表 */
export class PatternRegistry {
  private patterns: Map<string, Pattern> = new Map();

  /**
   * 注册 Pattern
   */
  register(pattern: Pattern): void {
    if (this.patterns.has(pattern.name)) {
      throw new Error(`Pattern "${pattern.name}" 已存在`);
    }
    this.patterns.set(pattern.name, pattern);
  }

  /**
   * 获取 Pattern
   */
  get(name: string): Pattern | undefined {
    return this.patterns.get(name);
  }

  /**
   * 检查 Pattern 是否存在
   */
  has(name: string): boolean {
    return this.patterns.has(name);
  }

  /**
   * 列出所有 Pattern 名称
   */
  listNames(): string[] {
    return Array.from(this.patterns.keys());
  }

  /**
   * 列出所有 Pattern
   */
  listAll(): Pattern[] {
    return Array.from(this.patterns.values());
  }

  /**
   * 获取 Pattern 描述
   */
  describe(name: string): string | undefined {
    const pattern = this.patterns.get(name);
    return pattern?.description;
  }

  /**
   * 注销 Pattern
   */
  unregister(name: string): boolean {
    return this.patterns.delete(name);
  }

  /**
   * 清空所有 Pattern
   */
  clear(): void {
    this.patterns.clear();
  }
}

/** 全局 Pattern 注册表实例 */
export const globalPatternRegistry = new PatternRegistry();

// Re-export PatternConfig for convenience
export type { PatternConfig } from "./context.js";
