/**
 * Phase 8 — 极简结构化日志（Logger）
 *
 * 双输出：
 *   - 文件：JSONL 追加到 ~/.multi-agent-collab-tools/logs/<YYYY-MM-DD>.jsonl
 *           （全量，level >= debug 都进文件，按天分文件）
 *   - stderr：人读行。默认仅 warn/error；--verbose / --log-level 放开 info/debug
 *
 * 铁律：**绝不写 stdout**——stdout 是 CLI 的正常输出通道（Phase 7.5 的 REPL
 * 输出、@归属工具流都在上面），日志混进去会污染管道消费方（验收场景 7：
 * `2>/dev/null` 下 stdout 与无日志时同形）。
 *
 * 写失败 try/catch 吞掉（沿 storage 层惯例：日志绝不能弄崩主流程）。
 * 日志 = 排障；轨迹（traces/spans）= 审计回放。两者分工见 ADR-013。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".multi-agent-collab-tools/logs"
);

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 全局阈值（stderr 用；文件始终收全量）。--verbose / --log-level 在 CLI 入口设置 */
let stderrLevel: LogLevel = "warn";

/** 设置 stderr 输出阈值（文件不受影响，始终全量） */
export function setStderrLevel(level: LogLevel): void {
  stderrLevel = level;
}

export interface LogFields {
  [key: string]: unknown;
}

/** 单条日志落双通道 */
function write(level: LogLevel, module: string, msg: string, fields?: LogFields): void {
  const ts = Date.now();
  // 文件通道：全量 JSONL
  try {
    const date = new Date(ts).toISOString().slice(0, 10);
    const line = JSON.stringify({ ts, level, module, msg, ...fields });
    appendFileSync(join(LOG_DIR, `${date}.jsonl`), line + "\n");
  } catch {
    // 吞掉：日志失败不能影响主流程（目录无权限/磁盘满等）
  }
  // stderr 通道：人读行，按阈值过滤
  if (LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[stderrLevel]) {
    const extras = fields
      ? " " + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ")
      : "";
    process.stderr.write(`[${level}] [${module}] ${msg}${extras}\n`);
  }
}

/** 模块 logger（镜像 Clowder 的 createModuleLogger 用法） */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg, fields) => write("debug", module, msg, fields),
    info: (msg, fields) => write("info", module, msg, fields),
    warn: (msg, fields) => write("warn", module, msg, fields),
    error: (msg, fields) => write("error", module, msg, fields),
  };
}

/** 确保日志目录存在（首次写入前调用一次；失败吞掉） */
export function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // 吞掉
  }
}
