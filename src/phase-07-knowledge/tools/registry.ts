/**
 * Phase 6 — ToolRegistry（工具注册表）
 *
 * 职责：
 * - 集中注册所有可用工具
 * - 按 Agent 白名单过滤（工具与 Agent 解耦，授权由配置决定）
 * - 转换为 Anthropic API 的 tools 数组（只暴露 schema，不含 execute）
 *
 * 设计：工具全局注册，Agent 配置里声明可用工具白名单。
 * 同一个 read_file 工具，只读 Agent 不给 write_file。
 */

import type { Tool, ToolInputSchema } from "./tool.js";

/** Anthropic API 的 tools 数组项（不含 execute） */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** 注册工具（重名覆盖） */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** 批量注册 */
  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  /** 获取单个工具 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 列出全部工具 */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** 列出工具名 */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 是否注册了某工具 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 转换为 Anthropic API 的 tools 数组
   * 只暴露 name/description/input_schema（不含 execute，避免泄露实现）
   */
  toAnthropicTools(): AnthropicTool[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /**
   * 按 Agent 白名单过滤，返回新的 ToolRegistry
   * @param allowed 允许的工具名列表；undefined/null/空 = 全部允许
   */
  forAgent(allowed?: string[] | null): ToolRegistry {
    if (!allowed || allowed.length === 0) return this; // 全部允许
    const filtered = new ToolRegistry();
    for (const name of allowed) {
      const t = this.tools.get(name);
      if (t) filtered.register(t);
    }
    return filtered;
  }
}
