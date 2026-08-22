/**
 * Phase 6 — 安全沙箱（Hard Rails）
 *
 * 工具能干活也能闯祸。沙箱是多层防御，挡住：
 * - 路径逃逸（../../etc/passwd、符号链接绕过 workDir）
 * - flag 注入（LLM 往命令塞 -rf）
 * - 危险命令（rm -rf /、fork bomb、mkfs）
 * - shell 元字符（管道 |、重定向 ><、命令分隔 ;&、变量 $、子 shell `()`）
 *
 * 学习项目：只做应用层校验，不做 OS 级隔离（Docker/chroot/seccomp）。
 * 但路径校验必须跟随符号链接——否则一个 `ln -s` 就能绕过 workDir 限制。
 * 借鉴 Clowder path-validator.ts（isPathAllowed + tryRealpathSync）与
 * shell-tools.ts（READONLY_PATTERNS + FORBIDDEN_PATTERNS + 控制字符拒绝）。
 */

import { resolve, normalize, relative, isAbsolute } from "path";
import { realpathSync, existsSync } from "fs";

/** 沙箱配置 */
export interface SandboxConfig {
  /** 工作目录根（文件工具的 path 必须落在此目录内） */
  workDir: string;
  /** 是否允许写操作（write_file 等）；默认 false */
  allowWrite: boolean;
  /** 是否允许执行非白名单命令；默认 false（只读白名单命令无需此项） */
  allowExec: boolean;
}

/** 沙箱拦截错误（工具失败时 status=blocked） */
export class SandboxError extends Error {
  constructor(message: string) {
    super(`[Sandbox] ${message}`);
    this.name = "SandboxError";
  }
}

export class Sandbox {
  readonly config: SandboxConfig;
  /** 解析后的 workDir（跟随 symlink 到真实绝对路径） */
  readonly realWorkDir: string;

  constructor(config: SandboxConfig) {
    this.config = config;
    // workDir 本身也可能是 symlink，统一解析
    this.realWorkDir = tryRealpath(config.workDir) ?? resolve(config.workDir);
  }

  /**
   * 校验路径：必须在 workDir 内，跟随符号链接防逃逸
   * @returns 规范化后的绝对路径（供工具使用）
   */
  validatePath(inputPath: string): string {
    // 1. 解析为绝对路径（相对 workDir）
    const abs = isAbsolute(inputPath)
      ? inputPath
      : resolve(this.realWorkDir, inputPath);
    const normalized = normalize(abs);

    // 2. 跟随符号链接到真实路径；若目标尚不存在（如写新文件），取最深存在祖先的真实路径
    const real = tryRealpath(normalized) ?? tryRealpathDeepest(normalized);

    // 3. 必须在 workDir 内（用 relative 判断，避免前缀字符串匹配的坑：/foo 不应算作 /foobar 的子目录）
    const rel = relative(this.realWorkDir, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new SandboxError(
        `路径越界：${inputPath} → ${real} 不在工作目录 ${this.realWorkDir} 内`
      );
    }

    return normalized;
  }

  /** 校验写权限（write_file 等高危工具调用前检查） */
  requireWrite(): void {
    if (!this.config.allowWrite) {
      throw new SandboxError("写操作未授权（需要 --allow-write）");
    }
  }

  /**
   * 校验 shell 命令：危险黑名单 + 控制字符拒绝 + 只读白名单 / allow-exec
   * @returns 通过校验的命令
   *
   * 分层：
   *   a) 危险模式黑名单 —— 永远拒绝（即使 allow-exec）
   *   b) shell 元字符    —— 永远拒绝（防注入）
   *   c) 只读白名单      —— 直接放行
   *   d) 非白名单        —— 需要 allow-exec，否则拒绝
   */
  validateCommand(command: string): string {
    const trimmed = command.trim();
    if (!trimmed) throw new SandboxError("空命令");

    // a) 危险模式黑名单（最高优先级）
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(trimmed)) {
        throw new SandboxError(`危险命令被拦截：${reason}`);
      }
    }

    // b) shell 元字符拒绝（管道/重定向/分隔/变量/子shell/反引号）
    if (SHELL_METACHAR_PATTERN.test(trimmed)) {
      throw new SandboxError(
        `命令含禁止的 shell 元字符（>|;&$\` 等，防注入）：${trimmed}`
      );
    }

    // c) 只读白名单 → 放行
    if (READONLY_COMMAND_PATTERNS.some((re) => re.test(trimmed))) {
      return trimmed;
    }

    // d) 非白名单 → 需要 allow-exec
    if (!this.config.allowExec) {
      throw new SandboxError(
        `命令不在只读白名单内：${trimmed}（--allow-exec 可解锁非白名单命令，但危险命令仍被拦）`
      );
    }
    return trimmed;
  }
}

// ─── 命令白名单 / 黑名单 ─────────────────────────────────────

/**
 * 拒绝的 shell 元字符（管道 |、重定向 ><、命令分隔 ;&、变量 $、子shell ()、反引号 `）。
 * 注意：不拦 glob *?[] —— 允许 `ls *.ts`、`find . -name "*.ts"`（glob 风险中等，常见且实用）。
 */
const SHELL_METACHAR_PATTERN = /[><|;&$`()]/;

/** 只读命令白名单（正则，匹配整条 trim 后的命令） */
const READONLY_COMMAND_PATTERNS: RegExp[] = [
  /^\s*pwd(\s.*)?$/i,
  /^\s*ls(\s.*)?$/i,
  /^\s*cat\s+\S.*$/i,
  /^\s*head(\s.*)?$/i,
  /^\s*tail(\s.*)?$/i,
  /^\s*wc(\s.*)?$/i,
  /^\s*find\s+\S.*$/i,
  /^\s*grep\s+\S.*$/i,
  /^\s*echo\s+\S.*$/i,
  /^\s*git\s+(log|status|diff|show|rev-parse|branch|remote|blame)(\s.*)?$/i,
  /^\s*npm\s+(ls|list|view|outdated)(\s.*)?$/i,
  /^\s*node\s+(-v|--version)(\s.*)?$/i,
];

/** 危险模式黑名单（优先级高于白名单，永远拒绝） */
const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+-rf?\s+\/(\s|$)/i, reason: "rm -rf / 绝对禁止" },
  { pattern: /\brm\s+-rf\b/i, reason: "rm -rf 危险递归删除" },
  { pattern: /:\s*\(\)\s*\{\s*:\|:/i, reason: "fork bomb 模式" },
  { pattern: /\bmkfs\b/i, reason: "mkfs 格式化磁盘" },
  { pattern: /\bdd\b.*\bof=\/dev\//i, reason: "dd 写入设备文件" },
  { pattern: /\b(chmod|chown|chgrp)\s+-R\b/i, reason: "递归修改权限/属主" },
  { pattern: /\bkillall\b/i, reason: "killall 批量终止进程" },
  { pattern: />(>|$)\s*\/(dev|etc|proc|sys)\//i, reason: "重定向到系统敏感目录" },
];

// ─── 路径工具 ──────────────────────────────────────────────

/** 尝试 realpath；不存在/出错返回 undefined */
function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** 取最深存在祖先的真实路径（用于尚不存在的目标，如新建文件） */
function tryRealpathDeepest(p: string): string {
  let current = normalize(p);
  while (!existsSync(current)) {
    const parent = normalize(current + "/..");
    if (parent === current) break; // 已到根
    current = parent;
  }
  return tryRealpath(current) ?? normalize(p);
}
