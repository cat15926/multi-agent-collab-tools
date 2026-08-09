/**
 * Phase 6 — 内置工具：list_files
 *
 * 列出目录内容。路径经沙箱校验。递归不跟随符号链接目录（防逃逸）。
 */

import { readdirSync } from "fs";
import { join } from "path";
import { ok, err, type Tool, type ToolResult, type ToolInputSchema } from "../tool.js";
import type { Sandbox } from "../sandbox.js";

const MAX_ENTRIES = 200;

export class ListFilesTool implements Tool {
  name = "list_files";
  description =
    "列出目录下的文件和子目录。path 必须在工作目录内。可选 recursive 递归列出（最多 3 层，不跟随符号链接）。适合了解项目结构。";
  inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径（默认工作目录 .）" },
      recursive: { type: "boolean", description: "是否递归列出（默认 false）" },
    },
    required: [],
  };

  constructor(private sandbox: Sandbox) {}

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = String(input.path ?? ".");
    const recursive = input.recursive === true;
    try {
      const safePath = this.sandbox.validatePath(path);
      const entries: string[] = [];

      const walk = (dir: string, prefix: string, depth: number) => {
        if (entries.length >= MAX_ENTRIES) return;
        let items;
        try {
          items = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const item of items) {
          if (entries.length >= MAX_ENTRIES) break;
          const rel = prefix ? `${prefix}/${item.name}` : item.name;
          const suffix = item.isDirectory() ? "/" : "";
          entries.push(`${rel}${suffix}`);
          // 递归：只进真实目录（isDirectory 对 symlink 目录返回 false），限 3 层
          if (
            recursive &&
            item.isDirectory() &&
            !item.isSymbolicLink() &&
            depth < 3
          ) {
            walk(join(dir, item.name), rel, depth + 1);
          }
        }
      };

      walk(safePath, "", 0);

      if (entries.length === 0) return ok("(空目录)");
      const shown = entries.slice(0, MAX_ENTRIES).join("\n");
      return ok(
        entries.length >= MAX_ENTRIES
          ? `${shown}\n...[已达上限 ${MAX_ENTRIES} 项]`
          : shown
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}
