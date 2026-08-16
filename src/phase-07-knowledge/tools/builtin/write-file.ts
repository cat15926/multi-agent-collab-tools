/**
 * Phase 6 — 内置工具：write_file（高危）
 *
 * 写入文件（覆盖）。需沙箱授权（--allow-write），路径必须在工作目录内。
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { ok, err, type Tool, type ToolResult, type ToolInputSchema } from "../tool.js";
import type { Sandbox } from "../sandbox.js";

export class WriteFileTool implements Tool {
  name = "write_file";
  description =
    "将内容写入文件（覆盖已有内容）。path 必须在工作目录内。属于高危操作，需要 --allow-write 授权。会自动创建不存在的父目录。";
  inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
  };

  constructor(private sandbox: Sandbox) {}

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = String(input.path ?? "");
    const content = String(input.content ?? "");
    if (!path) return err("缺少 path 参数");
    try {
      this.sandbox.requireWrite(); // 高危：需授权
      const safePath = this.sandbox.validatePath(path);
      mkdirSync(dirname(safePath), { recursive: true });
      writeFileSync(safePath, content, "utf8");
      return ok(`已写入 ${path}（${content.length} 字符）`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}
