/**
 * Phase 9 — CC 权限映射（canUseTool → Sandbox，Hard Rails 不丢）
 *
 * 双层沙箱模型：
 *   第一层 = Claude Code 自带的 cwd 边界（additionalDirectories 保持 []，
 *            cwd 设为 sandbox 工作目录）——cwd 内的读操作 CC 通常直接放行
 *   第二层 = 本文件：未被自动批准的工具调用全部进来，映射到项目 Sandbox
 *            （validatePath / requireWrite / validateCommand）
 *
 * 拒绝语义：
 *   - deny 时立即发 status='blocked' 的 ToolCallEvent（实时输出 + tool span +
 *     tool_calls 留痕），并把 toolUseID 记入 deniedToolUseIds——流里后续同名
 *     tool_result 到达时跳过，防双记
 *   - allow 时直接放行（updatedInput 按需透传，本层不改写输入）
 *
 * 残余风险（ADR-015 记录取舍）：cwd 内的 Read 不经 validatePath（symlink 解析
 * 语义由 CC 自己保证）；本层 fail-closed——未识别的工具一律 deny。
 */

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Sandbox } from "../tools/index.js";
import { SandboxError } from "../tools/index.js";

/** canUseTool 拒绝时向上抛的事件（ClaudeCodeBrain 转成 onToolCall） */
export interface CcBlockedEvent {
  toolName: string;
  input: unknown;
  toolUseId: string;
  message: string;
}

export interface CcPermissionSink {
  onBlocked(e: CcBlockedEvent): void;
  /** 已 deny 的 toolUseID 集合（流解析侧据此跳过配对，防双记） */
  deniedToolUseIds: Set<string>;
  /** 已放行计数（对账用） */
  allowedCount: number;
}

export interface CcPermissionOpts {
  sandbox: Sandbox;
  /** per-Agent 工具白名单（cfg.tools / CLI --tools；空/undefined = 不限制） */
  allowedTools?: string[];
}

/**
 * 项目工具名 → CC 原生工具名映射（白名单语义翻译用）。
 * kb 工具经 MCP 注入，名字形如 mcp__team-kb__kb_search。
 */
const PROJECT_TO_CC: Record<string, string[]> = {
  read_file: ["Read"],
  write_file: ["Write", "Edit"],
  list_files: ["Glob", "LS"],
  search_files: ["Grep"],
  run_command: ["Bash"],
  kb_search: ["mcp__team-kb__kb_search"],
  kb_write: ["mcp__team-kb__kb_write"],
};

/** 判断 CC 工具名是否命中白名单（含项目名→CC 名翻译） */
function whitelistMatches(whitelist: string[], toolName: string): boolean {
  for (const name of whitelist) {
    if (toolName === name) return true;
    for (const cc of PROJECT_TO_CC[name] ?? []) {
      if (toolName === cc) return true;
    }
    // MCP 工具前缀形态（防御未来命名变化）
    if (toolName.startsWith(`mcp__team-kb__${name}`)) return true;
  }
  return false;
}

/** 从工具输入里尽量取出路径字段（Read/Glob/Grep/Edit/Write 字段名不一） */
function extractPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "notebook_path", "edits_file_path"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** 无害的计划/只读类 CC 内部工具（默认放行；沙箱边界内） */
const ALWAYS_ALLOW = new Set(["TodoWrite", "TodoRead", "Glob", "Grep"]);

export function makeCcCanUseTool(opts: CcPermissionOpts, sink: CcPermissionSink): CanUseTool {
  const { sandbox } = opts;
  return async (toolName, input, poptions) => {
    const deny = (message: string) => {
      sink.deniedToolUseIds.add(poptions.toolUseID);
      sink.onBlocked({
        toolName,
        input,
        toolUseId: poptions.toolUseID,
        message,
      });
      return { behavior: "deny" as const, message };
    };

    // 1) per-Agent 工具白名单（cfg.tools / --tools；空 = 不限制）
    if (opts.allowedTools && opts.allowedTools.length > 0 && !whitelistMatches(opts.allowedTools, toolName)) {
      return deny(`工具 ${toolName} 不在本 Agent 的工具白名单内`);
    }

    try {
      // 2) kb MCP 工具：kb_write 自带门控（未授权时工具内部返回 err，status=error 而非 blocked）
      if (toolName.startsWith("mcp__team-kb__")) {
        sink.allowedCount++;
        return { behavior: "allow" as const };
      }

      // 3) 读类：CC 对 cwd 内读取通常自动放行；走到这里多半是出 cwd 的读 → validatePath 二次裁决
      if (toolName === "Read") {
        const p = extractPath(input);
        if (p) sandbox.validatePath(p);
        sink.allowedCount++;
        return { behavior: "allow" as const };
      }

      // 4) 无害内部工具
      if (ALWAYS_ALLOW.has(toolName)) {
        sink.allowedCount++;
        return { behavior: "allow" as const };
      }

      // 5) 写类：--allow-write 门控 + 路径边界
      if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
        sandbox.requireWrite();
        const p = extractPath(input);
        if (p) sandbox.validatePath(p);
        sink.allowedCount++;
        return { behavior: "allow" as const };
      }

      // 6) Bash：危险模式黑名单 + 元字符 + 只读白名单 + --allow-exec
      if (toolName === "Bash") {
        const command = typeof input.command === "string" ? input.command : "";
        sandbox.validateCommand(command);
        sink.allowedCount++;
        return { behavior: "allow" as const };
      }

      // 7) 未识别工具：fail-closed（WebFetch/WebSearch/Task 等已在 disallowedTools 摘除，
      //    能走到这里的未知工具一律拒绝——Hard Rails 精神）
      return deny(`工具 ${toolName} 未被 CC 沙箱映射识别（fail-closed 拒绝）`);
    } catch (e) {
      if (e instanceof SandboxError) {
        return deny(e.message);
      }
      return deny(e instanceof Error ? e.message : String(e));
    }
  };
}
