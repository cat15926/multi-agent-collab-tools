/**
 * Phase 8 — 轨迹装配与渲染（回放）
 *
 * 纯函数层：从 spans 表装配 Span 树，渲染成瀑布时间线。
 * 验收标准的落点：一次协作（一个 trace）产出完整"轨迹"。
 *
 * 装配规则：spans 按 parent_id 建树；父 span 比子 span 晚落盘（父包裹子），
 * 但装配发生在全部落盘之后，按 id 引用即可——这正是"结束时一次性 INSERT"
 * 模型与查询时装配的解耦点。
 *
 * 渲染分两层：
 *   - renderTraceHeader/Footer：trace 级汇总（tokens/成本/状态）
 *   - renderSpanTree：树形瀑布（偏移时间 + 耗时 + kind 特有摘要）
 */

import type { SpanRecord, Trace } from "../storage/sqlite.js";
import { formatCost, formatTokens, costOf } from "./pricing.js";

/** 树节点 */
export interface TrajectoryNode {
  span: SpanRecord;
  children: TrajectoryNode[];
}

/** spans → 树（孤儿节点——父缺失/环——挂根，不丢数据） */
export function buildTree(spans: SpanRecord[]): TrajectoryNode[] {
  const nodes = new Map<string, TrajectoryNode>();
  for (const s of spans) nodes.set(s.id, { span: s, children: [] });
  const roots: TrajectoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentId ? nodes.get(node.span.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  // 同层按开始时间排序（含 rowid 语义的稳定序已在 SQL 层保证，此处兜底）
  const sortRec = (n: TrajectoryNode): void => {
    n.children.sort((a, b) => a.span.startTs - b.span.startTs);
    n.children.forEach(sortRec);
  };
  roots.sort((a, b) => a.span.startTs - b.span.startTs);
  roots.forEach(sortRec);
  return roots;
}

// ─── 格式化工具 ─────────────────────────────────────────────────

/** 毫秒 → 人读：980ms / 1.2s / 1m03s */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** kind 图标（一眼区分动作类型） */
const KIND_ICON: Record<string, string> = {
  route: "🧭",
  kb: "🧠",
  step: "▶",
  agent: "🤖",
  llm: "💬",
  tool: "🔧",
  a2a: "⤴",
  distill: "🫙",
};

function attr(s: SpanRecord, key: string): unknown {
  return s.attributes?.[key];
}

/** 单个 span 的 kind 特有摘要（追加在耗时之后） */
function spanSummary(s: SpanRecord, full: boolean): string {
  const clip = (v: unknown, n: number): string => {
    const str = String(v ?? "");
    return full ? str : str.length > n ? str.slice(0, n) + "…" : str;
  };
  switch (s.kind) {
    case "route": {
      const target = attr(s, "target");
      const fallback = attr(s, "fallback");
      return `→ ${target}${fallback ? "（回退）" : ""}`;
    }
    case "kb":
      return `${attr(s, "entries") ?? "?"} 条记忆 · ${attr(s, "consumer") ?? ""}`;
    case "agent": {
      const parts: string[] = [];
      const step = attr(s, "step_number");
      if (step !== undefined) parts.push(`step ${step}`);
      const role = attr(s, "role");
      if (role && role !== "collaborator") parts.push(String(role));
      const out = attr(s, "output_preview");
      if (out) parts.push(`「${clip(out, full ? 200 : 50)}」`);
      return parts.join(" · ");
    }
    case "llm": {
      const inTok = Number(attr(s, "input_tokens") ?? 0);
      const outTok = Number(attr(s, "output_tokens") ?? 0);
      const turn = attr(s, "turn");
      const stop = attr(s, "stop_reason");
      // Phase 9：CC brain 的最后一条 llm span 带 SDK 口径总成本（含子代理，权威口径）
      const ccCost = attr(s, "cc_cost_usd");
      const ccSuffix =
        ccCost !== undefined ? ` · cc $${Number(ccCost).toFixed(4)}(SDK)` : "";
      return `turn ${turn} · in ${formatTokens(inTok)} / out ${formatTokens(outTok)} tok${stop ? ` · ${stop}` : ""}${ccSuffix}`;
    }
    case "tool": {
      const status = attr(s, "status");
      const input = attr(s, "input_preview");
      const icon = status === "ok" ? "✓" : status === "blocked" ? "🚫" : "✗";
      return `${icon} ${input ? clip(input, full ? 200 : 40) : ""}`;
    }
    case "a2a":
      return `${attr(s, "from") ?? "?"} → ${attr(s, "to") ?? "?"}`;
    case "distill": {
      const chars = attr(s, "transcript_chars");
      return chars ? `${chars} 字记录` : "";
    }
    default:
      return "";
  }
}

/** 树形瀑布渲染（不含 header/footer；cli/REPL 复用） */
export function renderSpanTree(
  roots: TrajectoryNode[],
  traceStartedAt: number,
  full = false
): string[] {
  const lines: string[] = [];
  const walk = (nodes: TrajectoryNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      const branch = last ? "└─" : "├─";
      const s = node.span;
      const offset = fmtMs(s.startTs - traceStartedAt);
      const dur = s.durationMs !== undefined ? fmtMs(s.durationMs) : "?";
      const icon = KIND_ICON[s.kind] ?? "·";
      const status = s.status === "error" ? " ✗" : "";
      const summary = spanSummary(s, full);
      lines.push(
        `${prefix}${branch} +${offset} ${icon} ${s.name} · ${dur}${status}${summary ? `  ${summary}` : ""}`
      );
      if (s.error) lines.push(`${prefix}${last ? "   " : "│  "}   错误: ${clipError(s.error, full)}`);
      walk(node.children, prefix + (last ? "   " : "│  "));
    });
  };
  walk(roots, "");
  return lines;
}

function clipError(err: string, full: boolean): string {
  return full ? err : err.length > 80 ? err.slice(0, 80) + "…" : err;
}

// ─── trace 级渲染 ───────────────────────────────────────────────

/** trace 头部（id/kind/入口/耗时/tokens/成本/状态 + 标题） */
export function renderTraceHeader(
  trace: Trace,
  usage: { calls: number; inputTokens: number; outputTokens: number; byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }> }
): string[] {
  const dur = trace.endedAt ? trace.endedAt - trace.startedAt : Date.now() - trace.startedAt;
  const statusIcon = trace.status === "ok" ? "✅" : trace.status === "error" ? "❌" : "⏳";
  let cost = 0;
  let unknown = false;
  for (const [model, u] of Object.entries(usage.byModel)) {
    const c = costOf(model, u.inputTokens, u.outputTokens);
    if (c === null) unknown = true;
    else cost += c;
  }
  const costStr = unknown && usage.calls > 0 ? "$?" : formatCost(cost);
  const lines = [
    `trace ${trace.id} · ${trace.kind}/${trace.entry}` +
      (trace.threadId ? ` · 会话 ${trace.threadId}` : "") +
      ` · ${statusIcon} ${fmtMs(dur)} · in ${formatTokens(usage.inputTokens)} / out ${formatTokens(usage.outputTokens)} tok · ${costStr}`,
  ];
  if (trace.title) lines.push(`任务: ${trace.title}`);
  if (trace.error) lines.push(`错误: ${trace.error}`);
  return lines;
}

/** 汇总脚注（按 kind 计数 + tokens/成本） */
export function renderTraceFooter(
  spans: SpanRecord[],
  usage: { calls: number; inputTokens: number; outputTokens: number; byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }> }
): string[] {
  const counts = new Map<string, number>();
  for (const s of spans) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  let cost = 0;
  let unknown = false;
  for (const [model, u] of Object.entries(usage.byModel)) {
    const c = costOf(model, u.inputTokens, u.outputTokens);
    if (c === null) unknown = true;
    else cost += c;
  }
  const parts = [...counts.entries()].map(([k, n]) => `${k}×${n}`);
  parts.push(`in ${formatTokens(usage.inputTokens)} / out ${formatTokens(usage.outputTokens)} tok`);
  if (!unknown || usage.calls === 0) parts.push(formatCost(cost));
  return [`汇总: ${parts.join(" · ")}`];
}

/** 完整轨迹渲染（header + 树 + footer） */
export function renderTrajectory(
  trace: Trace,
  spans: SpanRecord[],
  usage: Parameters<typeof renderTraceHeader>[1],
  full = false
): string[] {
  const roots = buildTree(spans);
  return [
    ...renderTraceHeader(trace, usage),
    ...renderSpanTree(roots, trace.startedAt, full),
    ...renderTraceFooter(spans, usage),
  ];
}
