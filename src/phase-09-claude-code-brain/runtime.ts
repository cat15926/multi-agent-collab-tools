/**
 * Phase 7 — 运行时组装（REPL 用）
 *
 * one-shot CLI 在 main() 里组装一次就跑；REPL 需要常驻并支持运行时开关
 * （/memory on|off、/kbwrite on|off），所以把组装逻辑收拢到这里：
 *
 *   - kb 常驻：distill 是独立能力线，与注入开关无关（/memory off 后 /distill 仍可用）
 *   - rebuild()：Router/Orchestrator/ToolRegistry 都是无状态薄壳，开关切换时
 *     按当前状态重建（毫秒级），不做更细粒度的注入
 */

import { resolve } from "path";
import { AgentRegistry } from "./registry/agent-registry.js";
import { Router } from "./router/index.js";
import { ThreadManager } from "./thread/manager.js";
import { Storage } from "./storage/sqlite.js";
import { Orchestrator } from "./orchestrator/index.js";
import { globalPatternRegistry } from "./pattern/registry.js";
import { PipelinePattern } from "./patterns/pipeline.js";
import { ParallelPattern } from "./patterns/parallel.js";
import { DebatePattern } from "./patterns/debate.js";
import { HierarchyPattern } from "./patterns/hierarchy.js";
import { ToolRegistry, Sandbox, createBuiltinTools, createKbTools } from "./tools/index.js";
import { KnowledgeBase } from "./knowledge/knowledge-base.js";
import { Tracer } from "./observability/tracer.js";
import type { CcBrainDeps } from "./agent/claude-code-brain.js";

/** 注入开关（镜像 one-shot 的 --no-memory / --allow-kb-write） */
export interface RuntimeToggles {
  /** 记忆注入（off = 零查询零注入 + kb 工具下线，与 --no-memory 同语义） */
  memoryOn: boolean;
  /** kb_write 门控 */
  kbWriteOn: boolean;
}

/** Phase 9：CC brain 相关选项（镜像 one-shot 的 --brain= / --cc-max-turns= / --cc-budget=） */
export interface RuntimeBrainOpts {
  /** 全局覆盖（> cfg.runtime > anthropic） */
  brainOverride?: string | null;
  ccMaxTurns?: number;
  ccBudget?: number;
}

export class Runtime {
  readonly storage: Storage;
  readonly registry: AgentRegistry;
  readonly threads: ThreadManager;
  readonly sandbox: Sandbox;
  /** 常驻 KB——不受 memoryOn 影响（distill 独立） */
  readonly kb: KnowledgeBase;
  readonly toolRegistry: ToolRegistry;
  /** Phase 8：观测器（REPL 每轮包 trace；Router/Orchestrator span 落盘） */
  readonly tracer: Tracer;
  /** Phase 9：CC brain 选项（构造时定死——REPL 无切换需求） */
  readonly brainOpts: RuntimeBrainOpts;

  router!: Router;
  orchestrator!: Orchestrator;
  memoryOn: boolean;
  kbWriteOn: boolean;
  /** REPL 当前会话（懒创建；one-shot 不用）——kb add 归属标注需要 */
  currentThreadId: string | null = null;

  constructor(
    opts: { workdir?: string; allowWrite?: boolean; allowExec?: boolean } & Partial<RuntimeToggles> &
      RuntimeBrainOpts
  ) {
    this.storage = new Storage();
    this.registry = new AgentRegistry();
    this.threads = new ThreadManager(this.storage);
    this.kb = new KnowledgeBase(this.storage);
    this.tracer = new Tracer(this.storage);
    this.sandbox = new Sandbox({
      workDir: resolve(opts.workdir ?? process.cwd()),
      allowWrite: opts.allowWrite ?? false,
      allowExec: opts.allowExec ?? false,
    });
    this.toolRegistry = new ToolRegistry();

    this.memoryOn = opts.memoryOn ?? true;
    this.kbWriteOn = opts.kbWriteOn ?? false;
    this.brainOpts = {
      brainOverride: opts.brainOverride ?? null,
      ccMaxTurns: opts.ccMaxTurns,
      ccBudget: opts.ccBudget,
    };

    // Pattern 注册（幂等，重复 register 同名覆盖）
    globalPatternRegistry.register(new PipelinePattern());
    globalPatternRegistry.register(new ParallelPattern());
    globalPatternRegistry.register(new DebatePattern());
    globalPatternRegistry.register(new HierarchyPattern());

    this.rebuild();
  }

  /** 按当前开关重建 Router/Orchestrator/工具注册表（toggle 后调用） */
  rebuild(): void {
    // Router/Orchestrator 只在注入开启时拿到 kb —— off = 零查询零注入
    this.router = new Router(this.registry, this.threads, this.storage, {
      kb: this.memoryOn ? this.kb : undefined,
      tracer: this.tracer,
    });
    this.orchestrator = new Orchestrator(this.storage, {
      kb: this.memoryOn ? this.kb : undefined,
      tracer: this.tracer,
    });

    // 工具注册表：内置工具常驻；kb 工具随开关
    this.toolRegistry.clear();
    this.toolRegistry.registerAll(createBuiltinTools(this.sandbox));
    if (this.memoryOn) {
      this.toolRegistry.registerAll(createKbTools(this.kb, { allowWrite: this.kbWriteOn }));
    }
  }

  setMemory(on: boolean): void {
    this.memoryOn = on;
    this.rebuild();
  }

  setKbWrite(on: boolean): void {
    this.kbWriteOn = on;
    this.rebuild();
  }

  /**
   * Phase 9：CC brain 运行时依赖快照（REPL 每行重建 brain 工厂时调用）。
   * 取的是**当前**开关状态 → /kbwrite on、/memory off 下一行即生效
   * （与 makeAgentOptions 每行重建同一模式）。
   */
  brainDeps(): CcBrainDeps & { sandbox: Sandbox } {
    return {
      sandbox: this.sandbox,
      kb: this.kb,
      kbWriteOn: this.kbWriteOn,
      memoryOn: this.memoryOn,
    };
  }
}
