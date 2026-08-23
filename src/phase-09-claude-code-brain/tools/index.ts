/**
 * Phase 7 — Tools 模块导出（Phase 6 基础上 + 知识库工具）
 */

export type { Tool, ToolResult, ToolInputSchema, ToolContext } from "./tool.js";
export { ok, err } from "./tool.js";
export { ToolRegistry, type AnthropicTool } from "./registry.js";
export { Sandbox, SandboxError, type SandboxConfig } from "./sandbox.js";

// 内置工具
export { ReadFileTool } from "./builtin/read-file.js";
export { WriteFileTool } from "./builtin/write-file.js";
export { ListFilesTool } from "./builtin/list-files.js";
export { SearchFilesTool } from "./builtin/search-files.js";
export { RunCommandTool } from "./builtin/run-command.js";

// 知识库工具（Phase 7）
export { KbSearchTool } from "./builtin/kb-search.js";
export { KbWriteTool } from "./builtin/kb-write.js";

import { ReadFileTool } from "./builtin/read-file.js";
import { WriteFileTool } from "./builtin/write-file.js";
import { ListFilesTool } from "./builtin/list-files.js";
import { SearchFilesTool } from "./builtin/search-files.js";
import { RunCommandTool } from "./builtin/run-command.js";
import { KbSearchTool } from "./builtin/kb-search.js";
import { KbWriteTool } from "./builtin/kb-write.js";
import type { Tool } from "./tool.js";
import type { Sandbox } from "./sandbox.js";
import type { KnowledgeBase } from "../knowledge/knowledge-base.js";

/** 创建全部内置工具（每个工具持有同一个 sandbox 引用，统一受其约束） */
export function createBuiltinTools(sandbox: Sandbox): Tool[] {
  return [
    new ReadFileTool(sandbox),
    new WriteFileTool(sandbox),
    new ListFilesTool(sandbox),
    new SearchFilesTool(sandbox),
    new RunCommandTool(sandbox),
  ];
}

/**
 * 创建知识库工具（Phase 7）
 * 独立工厂：KB 工具不依赖 Sandbox（纯 DB 操作，可 --kb-del 回滚），
 * kb_write 由 allowWrite 门控（--allow-kb-write）。
 */
export function createKbTools(kb: KnowledgeBase, opts: { allowWrite: boolean }): Tool[] {
  return [
    new KbSearchTool(kb),
    new KbWriteTool(kb, opts),
  ];
}
