/**
 * Phase 8 — Tracer/Logger 冒烟脚本（开发自检，非 CLI 入口）
 *
 * 运行：npm run smoke8
 * 验证点：
 *   1. 嵌套：child.parentId === parent.id
 *   2. 并行扇出：两个分支 span 的 parentId 都是共同父（不是彼此）——ALS 不可变上下文的核心正确性
 *   3. 错误路径：span 抛错 → status=error 落盘 + 重抛；trace 收口 error
 *   4. 防御：无 trace 上下文时 runSpan 透传不记录
 *   5. Logger：JSONL 落盘可 parse，stderr 阈值生效，stdout 零污染
 *
 * 用真实 DB（结束清理自己造的数据）。
 */

import { Storage } from "../storage/sqlite.js";
import { Tracer } from "./tracer.js";
import { createLogger, ensureLogDir, setStderrLevel } from "./logger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const storage = new Storage();
const tracer = new Tracer(storage);
let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${ok || !detail ? "" : ` —— ${detail}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  // ── 1+2+3: 一个 trace 里验证嵌套 / 并行 / 错误 ──
  const trace = tracer.startTrace("chat", { entry: "smoke", title: "tracer smoke" });
  const traceId = trace.id;

  await tracer.run(trace, async () => {
    // 嵌套：outer → inner
    await tracer.runSpan("outer", "agent", async () => {
      await tracer.runSpan("inner", "llm", async (span) => {
        span.setAttribute("input_tokens", 10);
        span.setAttribute("model", "smoke-model");
      });
    });

    // 并行扇出：fanout 父下两分支同时开 span
    await tracer.runSpan("fanout", "step", async () => {
      await Promise.all([
        tracer.runSpan("branch-a", "agent", async (s) => {
          await new Promise((r) => setTimeout(r, 30)); // 交错执行，制造串扰机会
          s.setAttribute("branch", "a");
        }),
        tracer.runSpan("branch-b", "agent", async (s) => {
          await new Promise((r) => setTimeout(r, 10));
          s.setAttribute("branch", "b");
        }),
      ]);
    });

    // 错误路径：抛错的 span 要落盘 error 并重抛（这里接住）
    try {
      await tracer.runSpan("boom", "tool", async () => {
        throw new Error("smoke error");
      });
      check("错误 span 重抛", false);
    } catch (e) {
      check("错误 span 重抛", e instanceof Error && e.message === "smoke error");
    }
  });

  const spans = storage.getSpansByTrace(traceId);
  const byName = new Map(spans.map((s) => [s.name, s]));
  const outer = byName.get("outer");
  const inner = byName.get("inner");
  const fanout = byName.get("fanout");
  const a = byName.get("branch-a");
  const b = byName.get("branch-b");
  const boom = byName.get("boom");

  check("嵌套 parentId", !!outer && !!inner && inner.parentId === outer.id, `outer=${outer?.id} inner.parentId=${inner?.parentId}`);
  check("branch-a 挂 fanout", !!a && !!fanout && a.parentId === fanout.id, `got ${a?.parentId}, want ${fanout?.id}`);
  check("branch-b 挂 fanout（并行不串扰）", !!b && !!fanout && b.parentId === fanout.id, `got ${b?.parentId}, want ${fanout?.id}`);
  check("错误 span status=error", boom?.status === "error" && boom?.error === "smoke error", JSON.stringify(boom));
  check("错误 span 仍挂 trace 根", !!boom && !boom.parentId);
  check("span 属性落盘", inner?.attributes?.input_tokens === 10 && inner?.attributes?.model === "smoke-model");
  check("trace 收口 ok（内层错误被接住不算失败）", storage.getTrace(traceId)?.status === "ok");

  // ── 错误 trace：fn 抛错 → finishTrace(error) ──
  const badTrace = tracer.startTrace("chat", { entry: "smoke", title: "error trace" });
  try {
    await tracer.run(badTrace, async () => {
      throw new Error("trace-level failure");
    });
  } catch {
    // 预期
  }
  check("trace 级错误收口", storage.getTrace(badTrace.id)?.status === "error" && storage.getTrace(badTrace.id)?.error === "trace-level failure");

  // ── 4: 防御——无 trace 上下文透传 ──
  const before = storage.listTraces(100).length;
  const passthrough = await tracer.runSpan("orphan", "agent", async () => 42);
  check("无上下文透传返回值", passthrough === 42);
  check("无上下文零记录", storage.listTraces(100).length === before);

  // ── 5: Logger ──
  ensureLogDir();
  setStderrLevel("debug"); // 冒烟时放开，验证全部 level 都能出
  const log = createLogger("smoke");
  log.debug("debug 行", { traceId });
  log.info("info 行", { n: 1 });
  log.warn("warn 行");
  log.error("error 行");
  const date = new Date().toISOString().slice(0, 10);
  const logPath = join(process.env.HOME || ".", ".multi-agent-collab-tools/logs", `${date}.jsonl`);
  const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter((l) => l.includes('"module":"smoke"'));
  const last4 = lines.slice(-4);
  check("JSONL 每行可 parse", last4.length === 4 && last4.every((l) => typeof JSON.parse(l).level === "string"));
  check("JSONL 带字段", last4.length > 0 && JSON.parse(last4[0]).traceId === traceId);

  // ── 清理 ──
  const db = (storage as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } })["db"];
  for (const id of [traceId, badTrace.id]) {
    db.prepare("DELETE FROM spans WHERE trace_id = ?").run(id);
    db.prepare("DELETE FROM traces WHERE id = ?").run(id);
  }

  console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
  storage.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("冒烟脚本自身异常:", err);
  storage.close();
  process.exit(1);
});
