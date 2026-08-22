/**
 * Phase 6 — 内置工具：read_file
 *
 * 读取文本文件内容。路径经沙箱校验（必须在工作目录内），大文件截断。
 */

import { readFileSync, statSync } from "fs";
import { ok, err, type Tool, type ToolResult, type ToolInputSchema } from "../tool.js";
import type { Sandbox } from "../sandbox.js";

const MAX_READ_BYTES = 64 * 1024; // 64KB

export class ReadFileTool implements Tool {
  name = "read_file";
  description =
    "读取指定文本文件的内容。path 必须在工作目录内。超过 64KB 的文件会被截断。适合查看源码、配置、文档。";
  inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "要读取的文件路径（相对工作目录或绝对）" },
    },
    required: ["path"],
  };

  constructor(private sandbox: Sandbox) {}

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = String(input.path ?? "");
    if (!path) return err("缺少 path 参数");
    try {
      const safePath = this.sandbox.validatePath(path);
      const stat = statSync(safePath);
      if (stat.isDirectory()) return err(`${path} 是目录，不是文件`);
      const buf = readFileSync(safePath);
      let content = buf.toString("utf8");
      if (buf.length > MAX_READ_BYTES) {
        content =
          content.slice(0, MAX_READ_BYTES) +
          `\n...[已截断，文件共 ${buf.length} 字节]`;
      }
      return ok(content);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}
