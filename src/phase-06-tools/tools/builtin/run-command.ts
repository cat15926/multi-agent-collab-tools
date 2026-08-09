/**
 * Phase 6 — 内置工具：run_command（高危）
 *
 * 在工作目录执行 shell 命令。
 * 沙箱分层：危险黑名单（永远拦）→ 元字符拒绝 → 只读白名单放行 → 非白名单需 --allow-exec。
 */

import { execSync } from "child_process";
import { ok, err, type Tool, type ToolResult, type ToolInputSchema } from "../tool.js";
import type { Sandbox } from "../sandbox.js";

const MAX_OUTPUT = 8 * 1024; // 8KB
const TIMEOUT_MS = 30_000;

export class RunCommandTool implements Tool {
  name = "run_command";
  description =
    "在工作目录执行 shell 命令。只读命令（ls/cat/git log/git status 等）直接放行；其它命令需要 --allow-exec；危险命令（rm -rf、mkfs、fork bomb 等）永远被拦截。适合查看 git 历史、项目状态。";
  inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
    },
    required: ["command"],
  };

  constructor(private sandbox: Sandbox) {}

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = String(input.command ?? "");
    if (!command) return err("缺少 command 参数");
    try {
      const safeCmd = this.sandbox.validateCommand(command);
      const output = execSync(safeCmd, {
        cwd: this.sandbox.realWorkDir,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const trimmed = (output ?? "").trimEnd();
      return ok(trimmed || "(命令执行完成，无输出)");
    } catch (e) {
      // 非零退出 / 超时 / 超缓冲：返回 stderr 让 LLM 感知失败
      const anyErr = e as { stderr?: Buffer | string; message?: string };
      const stderr = anyErr.stderr ? String(anyErr.stderr) : "";
      const msg = e instanceof Error ? e.message : String(e);
      return err(`命令失败：${msg}${stderr ? `\nstderr: ${stderr}` : ""}`);
    }
  }
}
