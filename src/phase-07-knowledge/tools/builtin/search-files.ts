/**
 * Phase 6 — 内置工具：search_files
 *
 * 在工作目录递归搜索文件内容（子串匹配），返回 文件:行号: 内容。
 * 自动跳过 node_modules / .git / dist 等大目录，不跟随符号链接。
 */

import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { ok, err, type Tool, type ToolResult, type ToolInputSchema } from "../tool.js";
import type { Sandbox } from "../sandbox.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const MAX_RESULTS = 50;

export class SearchFilesTool implements Tool {
  name = "search_files";
  description =
    "在工作目录递归搜索文件内容（按文本子串匹配），返回匹配的 文件:行号:内容。自动跳过 node_modules/.git 等大目录。适合查找函数定义、用法、关键字。";
  inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索的文本（子串匹配）" },
      path: { type: "string", description: "搜索起始目录（默认工作目录）" },
      maxResults: { type: "number", description: `最大返回匹配数（默认 ${MAX_RESULTS}）` },
    },
    required: ["pattern"],
  };

  constructor(private sandbox: Sandbox) {}

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(input.pattern ?? "");
    const path = String(input.path ?? ".");
    const maxResults = Number(input.maxResults ?? MAX_RESULTS);
    if (!pattern) return err("缺少 pattern 参数");
    try {
      const safePath = this.sandbox.validatePath(path);
      const results: string[] = [];

      const walk = (dir: string) => {
        if (results.length >= maxResults) return;
        let items;
        try {
          items = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const item of items) {
          if (results.length >= maxResults) return;
          if (item.isDirectory()) {
            if (SKIP_DIRS.has(item.name) || item.isSymbolicLink()) continue;
            walk(join(dir, item.name));
          } else if (item.isFile()) {
            try {
              const content = readFileSync(join(dir, item.name), "utf8");
              const lines = content.split("\n");
              const rel = relative(this.sandbox.realWorkDir, join(dir, item.name));
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(pattern)) {
                  results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
                  if (results.length >= maxResults) break;
                }
              }
            } catch {
              /* 跳过二进制 / 无权限文件 */
            }
          }
        }
      };

      walk(safePath);

      if (results.length === 0) return ok(`未找到匹配 "${pattern}" 的内容`);
      return ok(results.join("\n"));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}
