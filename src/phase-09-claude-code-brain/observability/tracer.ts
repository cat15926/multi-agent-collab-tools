/**
 * Phase 8 — Tracer（mini-OTel：Trace + Span 树）
 *
 * 机制：AsyncLocalStorage 携带不可变上下文 { traceId, currentSpanId }。
 * 这正是 OpenTelemetry Context Propagation 的底层做法：
 *   - 每开一个 span，就派生一份新上下文（{ ...ctx, currentSpanId: 新id }），
 *     用 als.run 为子调用树建立该上下文 —— 上下文对象从不原地修改。
 *   - 因此并行扇出（Promise.all）各分支在开 span 那一刻各自快照父 id，
 *     互不串扰：parallel 模式两个 agent span 各自正确挂在各自 step 下。
 *
 * 落盘模型：span 结束时一次性 INSERT（duration 此刻已知）；进程崩溃丢
 * in-flight span——取舍见 ADR-013。
 *
 * 防御：不在 trace 上下文里时 runSpan 直接透传 fn（零记录），
 * 埋点可以无脑调用，不需要先判断有没有开 trace。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  Storage,
  Trace,
  TraceKind,
  SpanKind,
  AddTraceOptions,
} from "../storage/sqlite.js";

/** ALS 上下文：不可变（每次开 span 派生新对象，绝不原地改） */
interface TraceContext {
  traceId: string;
  /** 当前 span id（栈顶语义靠派生实现，不维护数组） */
  currentSpanId?: string;
}

/** span 句柄：fn 内用来补记"结束时才知道"的属性（如 tokens） */
export interface SpanHandle {
  readonly id: string;
  setAttribute(key: string, value: unknown): void;
}

/** runSpan 附加项 */
export interface SpanOptions {
  agentId?: string;
}

/** 生成短 id：前缀 + 时间36进制 + 随机 4 位 */
function shortId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 哑句柄（无 tracer / 无上下文路径共用） */
const NOOP_SPAN: SpanHandle = {
  id: "",
  setAttribute: () => {},
};

/**
 * 便捷包裹：tracer 缺省（未布线的入口）时直接执行 fn，调用方不必写 if/else。
 * （Tracer.runSpan 自身还有一层防御：不在 trace 上下文 → 透传不记录）
 */
export async function withSpan<T>(
  tracer: Tracer | undefined,
  name: string,
  kind: SpanKind,
  fn: (span: SpanHandle) => Promise<T>,
  opts?: SpanOptions
): Promise<T> {
  if (!tracer) return fn(NOOP_SPAN);
  return tracer.runSpan(name, kind, fn, opts);
}

export class Tracer {
  private readonly storage: Storage;
  private readonly als = new AsyncLocalStorage<TraceContext>();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  // ─── Trace 层 ──────────────────────────────────────────────────

  /** 开一个 trace（写 traces 行，status=running）。id/startedAt 由 Tracer 生成 */
  startTrace(
    kind: TraceKind,
    opts: Omit<AddTraceOptions, "id" | "kind" | "startedAt">
  ): Trace {
    return this.storage.addTrace({
      id: shortId("trc_"),
      kind,
      startedAt: Date.now(),
      ...opts,
    });
  }

  /**
   * 包住一次完整协作：建立 trace 上下文，结束（含抛错）时收口 traces 行。
   * 用法：const trace = tracer.startTrace(...); await tracer.run(trace, async () => { ... })
   */
  async run<T>(trace: Trace, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await this.als.run({ traceId: trace.id }, fn);
      this.storage.finishTrace(trace.id, "ok");
      return result;
    } catch (err) {
      this.storage.finishTrace(trace.id, "error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ─── Span 层 ───────────────────────────────────────────────────

  /**
   * 包住一段操作形成一个 span：进入时计时+定父，fn 可经句柄补属性，
   * 结束（含抛错）时落盘。不在 trace 上下文 → 直接透传（零记录）。
   */
  async runSpan<T>(
    name: string,
    kind: SpanKind,
    fn: (span: SpanHandle) => Promise<T>,
    opts?: SpanOptions
  ): Promise<T> {
    const ctx = this.als.getStore();
    if (!ctx) {
      // 防御：无 trace 上下文（如未布线的入口）→ 不记录，只执行
      return fn(NOOP_SPAN);
    }

    const spanId = shortId("spn_");
    const startTs = Date.now();
    const attributes: Record<string, unknown> = {};

    return this.als.run({ ...ctx, currentSpanId: spanId }, async () => {
      let result: T;
      let errorMessage: string | undefined;
      try {
        result = await fn({
          id: spanId,
          setAttribute: (k, v) => {
            attributes[k] = v;
          },
        });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        this.storage.addSpan({
          id: spanId,
          traceId: ctx.traceId,
          parentId: ctx.currentSpanId,
          kind,
          name,
          agentId: opts?.agentId,
          status: "error",
          error: errorMessage,
          startTs,
          endTs: Date.now(),
          attributes,
        });
        throw err;
      }
      this.storage.addSpan({
        id: spanId,
        traceId: ctx.traceId,
        parentId: ctx.currentSpanId,
        kind,
        name,
        agentId: opts?.agentId,
        status: "ok",
        startTs,
        endTs: Date.now(),
        attributes,
      });
      return result;
    });
  }

  /**
   * 记录一个"已经结束"的 span（事件驱动埋点用）。
   * 与 runSpan 的区别：不包裹执行——事件回调（onLlmCall/onToolCall）拿到的是
   * 完成后的数据（含 duration），由此重建 span。父 = 当前上下文 span
   * （回调在包裹作用域内触发，ALS 保证取到正确父）；不在 trace 内 → 不记录。
   */
  recordSpan(
    name: string,
    kind: SpanKind,
    timing: { startTs: number; endTs: number },
    attrs?: Record<string, unknown>,
    opts?: { agentId?: string; status?: "ok" | "error"; error?: string }
  ): void {
    const ctx = this.als.getStore();
    if (!ctx) return; // 不在 trace 内 → 零记录
    this.storage.addSpan({
      id: shortId("spn_"),
      traceId: ctx.traceId,
      parentId: ctx.currentSpanId,
      kind,
      name,
      agentId: opts?.agentId,
      status: opts?.status ?? "ok",
      error: opts?.error,
      startTs: timing.startTs,
      endTs: timing.endTs,
      attributes: attrs,
    });
  }

  // ─── 查询（埋点/链接用） ───────────────────────────────────────

  /** 当前 trace id（不在 trace 内 → undefined）。埋点给领域行补 trace 链接用 */
  currentTraceId(): string | undefined {
    return this.als.getStore()?.traceId;
  }

  /** 当前 span id（挂父用；上下文派生已保证并行分支正确） */
  currentSpanId(): string | undefined {
    return this.als.getStore()?.currentSpanId;
  }
}
