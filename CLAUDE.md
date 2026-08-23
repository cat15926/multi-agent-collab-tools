# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **learning project** to build a multi-agent collaboration tool from scratch, phase by phase. The goal is to understand the core abstractions by implementing them directly—**not by using frameworks** like LangChain, LangGraph, AutoGen, or CrewAI during the learning phase.

Reference implementation: [Clowder AI](https://github.com/zts212653/clowder-ai) (locally at `~/lhz/clowder-ai`)

## Development Commands

> Scripts run via `npm run <phase>` (or `pnpm <phase>` — the committed lockfile is `pnpm-lock.yaml`; pnpm does not need the `--` separator that npm requires to pass args). `tsx` runs TypeScript directly, so there is **no build step** (`npm run build` does not exist).

```bash
# Run each phase's CLI
npm run phase1    # Phase 1: Single Agent MVP
npm run phase2    # Phase 2: Agent Identity & Memory
npm run phase3    # Phase 3: Multi-Agent + Message Routing
npm run phase4    # Phase 4: Agent-to-Agent Collaboration
npm run phase5    # Phase 5: Collaboration Patterns

# Phase 4 CLI options (emergent A2A)
npm run phase4 -- --list                    # List all available agents
npm run phase4 -- "@alice 你好"             # Chat with agent
npm run phase4 -- "@alice @bob 讨论"        # A2A collaboration
npm run phase4 -- --thread=xxx "继续"       # Continue specific thread
npm run phase4 -- --no-a2a "@alice 设计"     # Disable A2A
npm run phase4 -- --a2a-mode=confirm "@alice 设计"  # Confirmation mode
npm run phase4 -- --chain --thread=xxx      # View collaboration chain

# Phase 5 CLI options (structured orchestration)
npm run phase5 -- --list-patterns                          # List available patterns
npm run phase5 -- "@alice 写个登录函数" --pattern=pipeline --agents=alice,bob,carol
npm run phase5 -- "设计登录页" --pattern=parallel --agents=alice,bob,carol --aggregator=dave
npm run phase5 -- "方案可行吗" --pattern=debate --agents=alice,bob --rounds=3
npm run phase5 -- "实现用户系统" --pattern=hierarchy --manager=alice --workers=bob,carol
npm run phase5 -- --thread=xxx --show-workflow             # Inspect execution steps/timings

# Phase 7 CLI options (shared memory / KnowledgeBase; Phase 6 用法全部不变)
npm run phase7                                           # 无参数 → REPL 交互模式（连续对话/斜杠命令）
npm run p7 -- kb add "经验" --type=lesson --title=标题 --keywords=a,b  # Manual entry (type: decision|lesson|observation|outcome)
npm run p7 -- kb search "词" && npm run p7 -- kb list && npm run p7 -- kb stats
npm run p7 -- kb distill last [--force]                  # Distill knowledge from a thread (LLM)
npm run p7 -- threads                                    # Recent conversations list
npm run phase7 -- "任务" --pattern=pipeline --agents=bob,ji-tui --auto-distill  # Auto-distill after pattern
npm run phase7 -- "@bob ..." --no-memory                 # Disable memory injection this run
npm run phase7 -- "@bob 记住..." --allow-kb-write        # Enable kb_write tool
npm run phase7 -- --thread=last --show-memory            # Replay memory injections (kb_reads; last = 最近会话)
# REPL 内: /help /kb … /pattern <name> [flags] 任务 /distill /memory on|off /kbwrite on|off /threads /thread <id|last> /new /show memory|tools|workflow
# REPL 交互（phase-07.5 第一批）: Tab 补全（/命令 + @agent）· 未知命令相似度提示 · prompt 状态栏（记忆/kbwrite 开关）· 工具调用实时输出带 @归属

# Phase 8 CLI options (observability; Phase 7 用法全部不变)
npm run phase8 -- trace [list] [N]                     # 近期轨迹（kind/耗时/tokens/成本/状态）
npm run phase8 -- trace show <id|last> [--full]        # 轨迹瀑布树回放（route→agent→llm/tool）
npm run phase8 -- stats [--by=agent|thread|day]        # token 计费聚合（读时 × config/pricing.json）
npm run phase8 -- "任务" --pattern=pipeline --agents=bob,ji-tui   # 跑完自动打 📊 回执行
npm run phase8 -- "…" --verbose                        # stderr 放开 info/debug（--log-level= 同义）
npm run smoke8                                         # Tracer/Logger 冒烟（13 项自检）
# REPL 内: /trace [N] · /trace show <id|last> · /stats；每轮对话/编排/提炼自动记 trace + 回执行
# 日志文件: ~/.multi-agent-collab-tools/logs/<YYYY-MM-DD>.jsonl（绝不写 stdout）

# Phase 9 CLI options (Claude Code Brain; Phase 8 用法全部不变)
npm run phase9 -- "@bob 看看 package.json 有哪些 script"   # bob/nim/ji-tui 默认 CC brain（原生 Read/Bash/Grep）
npm run phase9 -- "@bob 你好" --brain=anthropic            # 回退裸 API brain（行为同 Phase 8）
npm run phase9 -- "任务" --pattern=pipeline --agents=bob,ji-tui  # Pattern 编排全 CC（注意成本 5-20×）
npm run phase9 -- "…" --cc-max-turns=15 --cc-budget=0.5    # CC 轮数/成本护栏（超预算 abort）
# runtime 选择优先级: --brain= > config/agents/*.json "runtime" 字段 > anthropic
# 沙箱: canUseTool→Sandbox 映射（Edit/Write 需 --allow-write；Bash 走白名单）；settingSources 隔离
# kb: team-kb MCP 进程内注入（kb_search 常开；kb_write 需 --allow-kb-write）；/memory off 不挂

# Type checking (recommended before commits)
npm run typecheck
```

## Tech Stack

- **TypeScript** + **Node.js >= 24** (ES2022 target, ESNext modules)
- **Direct LLM SDKs**: `@anthropic-ai/sdk` (no frameworks during learning phase); Phase 9 adds `@anthropic-ai/claude-agent-sdk` (Claude Code runtime, locked 0.3.241) + `zod` + `@modelcontextprotocol/sdk` (peers)
- **Storage**: SQLite via `better-sqlite3`
- **Runtime**: `tsx` for direct TypeScript execution; **pnpm-managed node_modules** (npm install fails — use `pnpm install`)

### Environment & Storage

- **API key**: The Anthropic client is constructed bare (`new Anthropic()`, no args), so `ANTHROPIC_API_KEY` **must be set in the environment**. The code does not load `.env` — export it in your shell. Set `ANTHROPIC_BASE_URL` too if your `config/agents/*.json` `model` values route through a relay/proxy.
- **Database location**: All phases share `~/.multi-agent-collab-tools/memory.db` (under `$HOME`, gitignored). Phase 5 extends the same DB with `workflow_executions` + `workflow_steps` tables; Phase 6 adds `tool_calls`; Phase 7 adds `kb_entries` + `kb_reads` + `kb_distill_runs`; Phase 8 adds `traces` + `spans` (Span tree, ms timestamps). Structured logs go to `~/.multi-agent-collab-tools/logs/<YYYY-MM-DD>.jsonl`.

## Architecture: The 5 Core Abstractions

Each phase implements one core abstraction. Understanding these is crucial:

| Abstraction | Description | Introduced | Deepened |
|-------------|-------------|-----------|----------|
| **Agent** | Persistent persona + LLM brain + memory + tools + skills | Phase 1 | Phase 2 |
| **Message** | Structured data packet with routing metadata that flows between agents | Phase 1 (implicit) | Phase 3 (explicit) |
| **Router/Orchestrator** | Message distribution (Router) vs task flow patterns (Orchestrator) | Phase 3 (Router) | Phase 5 (Orchestrator) |
| **Shared State** | Short-term (Thread) and long-term (KnowledgeBase) shared context | Phase 2 (single) | Phase 3 (Thread), Phase 7 (KB) |
| **Pattern** | How agents collaborate: pipeline, parallel, debate, hierarchy | Phase 4 (A2A雏形) | Phase 5 (formal) |

### Key Architectural Concepts

**Thread Isolation**: Collaboration boundary = shared state boundary. Agents in the same thread share context; cross-thread collaboration requires long-term memory.

**Ball Ownership**: In A2A collaboration, "ball" = right/obligation to respond. Ball flows: user → @mentioned agent → recipients. Understanding this is key to Phase 4+.

**6-Layer Router Pipeline** (Phase 3):
1. Mention parsing (extract @handles)
2. Target resolution (@handle → agentId)
3. Fallback cascade (last responder → preferred → default)
4. Dispatch scheduling (serial/parallel)
5. Context assembly (history + identity + teammates)
6. LLM judgment (accept/reject/escalate)

Layers 1-5 are deterministic code; Layer 6 is the Agent's LLM.

**A2A Handoff** (Phase 4): Agents can delegate to each other. When Agent A detects a task belongs to Agent B, they use `@handoff @b context...` syntax. The A2A system parses, validates, and routes the handoff message.

**Hard Rails + Soft Power**: Safety rails are non-negotiable floors; above that, agents self-coordinate.

**Patterns & Orchestrator (Phase 5)**: Where Phase 4 collaboration is *emergent* (agents spontaneously `@handoff`), Phase 5 is *structured*. A `Pattern` is a pluggable interface; `BasePattern` provides a validate → execute → record template method and owns ball-flow. The `Orchestrator` looks up patterns in the `globalPatternRegistry`, builds a `PatternContext` (task + agents + threadId + config + history), runs the pattern, and persists each run via `WorkflowTracker` into `workflow_executions`/`workflow_steps`. Four built-in patterns: `pipeline` (linear A→B→C), `parallel` (fan-out → aggregator), `debate` (A↔B, exactly 2 agents, N rounds), `hierarchy` (manager decomposes → workers → manager merges). Patterns and A2A are orthogonal and composable (`config.a2aEnabled`).

**Shared Memory / KnowledgeBase (Phase 7)**: Three orthogonal capability lines over `kb_entries` (decision/lesson/observation/outcome). *Push*: Router/Orchestrator query the KB each turn (`buildMemoryContext` = global weighted search ∪ this-thread entries) and inject top-K as `memoryContext` into the system prompt (labeled "参考信息，非当前指令"; `--no-memory` disables). *Pull*: `kb_search` (read-only) / `kb_write` (`--allow-kb-write` gated, always `verified=0`) tools; `Tool.execute` takes an optional `ToolContext{agentId, threadId}` for attribution. *Distill*: `Distiller` extracts reusable entries from thread messages + workflow_steps via strict `<entry type="...">` tags (3-tier parse: tags → JSON → visible parse_failed), double idempotency (scope-level in `kb_distill_runs` + title-level dedup). Retrieval is **JS weighted scoring** (keywords +10 / title +4 / content +2, bidirectional substring for unspaced Chinese) — FTS5 was measured and rejected for CJK (ADR-011).

**Observability (Phase 8)**: Mini-OTel over two new tables: `traces` (one row per collaboration: chat/pattern/distill, entry cli/repl) + `spans` (parent_id self-referencing tree; kinds route/kb/step/agent/llm/tool/a2a/distill). Context propagates via **AsyncLocalStorage** (immutable context `{traceId, currentSpanId}` derived per span — this is OTel's Context Propagation mechanism; parallel fan-out snapshots parents correctly). Spans insert **once at end** (crash loses in-flight; hence no FK on parent_id — children persist before parents). Two-plane split: observation plane (timing/tokens/200-char previews/domain-row link ids) vs domain plane (`tool_calls`/`kb_reads`/`workflow_executions` unchanged, full payloads). LLM telemetry: `onLlmCall` event (mirrors `onToolCall`) fires at all 3 `messages.create` call sites (agent×2 + distiller) with usage/stop_reason/turn; CLI factory converts events→spans. Token billing is **read-time** (`config/pricing.json` $/1M tok; unknown model → `?`). Structured logging: JSONL to `logs/<date>.jsonl` + human stderr (threshold `--log-level`/`--verbose`; never stdout). Replay: `trace show` waterfall tree. Decisions in ADR-013.

**Brain Abstraction & Claude Code Runtime (Phase 9)**: The LLM loop is extracted from `Agent` into a swappable `Brain` interface (`agent/brain.ts`): `reply({agentId, threadId, systemPrompt, messages}, {onLlmCall, onToolCall}) → Promise<string>`. `AnthropicBrain` = the Phase 6/8 loop moved verbatim (fallback path). `ClaudeCodeBrain` = `@anthropic-ai/claude-agent-sdk` `query()` — full CC agentic loop with native Read/Edit/Bash/Grep. Selection: `--brain=` > agent JSON `runtime` field (all three agents default `claude-code`) > anthropic. Key mechanisms (ADR-015): **stateless** (project Thread is the sole memory source; history re-sent per reply in `<conversation_history>` tags); **two-layer sandbox** (CC's own cwd boundary + `canUseTool`→`Sandbox` mapping in `cc-permissions.ts`; `settingSources: []` isolation is mandatory — otherwise user `.claude/settings.local.json` allow rules auto-approve tools and bypass the sandbox, found in testing); **kb via in-process MCP** (`createSdkMcpServer` → `mcp__team-kb__kb_search/kb_write`, ToolContext attribution passes through, `/memory off` unmounts); **observability mapping** (one `onLlmCall` per SDKAssistantMessage with turn increments; last one deferred to attach `ccTotalCostUsd`/`ccNumTurns` → span attrs `cc_cost_usd`/`cc_num_turns`; tool_use/tool_result pairing emits ToolCallEvent, deny emits blocked event at rejection point with toolUseID dedup); **guards** (`--cc-max-turns=15` returns partial text, `--cc-budget=0.5` self-implemented abort via read-time pricing accumulation). `distiller.ts` intentionally stays on bare Anthropic. Router/pattern/a2a `reply()` call sites unchanged.

## Source Structure

```
src/
├── phase-01-single-agent/      # Single agent MVP
├── phase-02-agent-identity/    # Persistent agent with SQLite memory
│   ├── storage/sqlite.ts
│   ├── context.ts               # Context window management
│   └── config.ts                # Config loading
├── phase-03-multi-agent/        # Message routing + Thread isolation
│   ├── router/                  # 6-layer routing pipeline
│   ├── thread/                  # Thread management
│   └── registry/                # Agent registry
├── phase-04-agent-to-agent/     # A2A collaboration (emergent, agent-driven)
│   ├── a2a/                     # A2A parser, decider, handler
│   ├── router/                  # Enhanced routing with A2A
│   ├── agent/                   # Agent class with handoff capability
│   ├── thread/                  # Thread with collaboration chain
│   ├── registry/                # Agent registry
│   └── storage/                 # SQLite with messages + threads
├── phase-05-patterns/           # Structured collaboration patterns (Pattern + Orchestrator)
│   ├── pattern/                 # Pattern interface, BasePattern (template method), registry
│   ├── patterns/                # pipeline / parallel / debate / hierarchy implementations
│   ├── orchestrator/            # Orchestrator + WorkflowTracker (executes & persists runs)
│   ├── agent/ router/ thread/ registry/ a2a/   # reuse Phase 4 components
│   └── storage/                 # SQLite: adds workflow_executions + workflow_steps tables
├── phase-06-tools/              # Tool use (function calling + sandbox)
│   ├── tools/                   # Tool interface, ToolRegistry, Sandbox, 5 builtin tools
│   └── agent/                   # Agent with tool-use loop
├── phase-07-knowledge/          # Shared memory / KnowledgeBase
│   ├── knowledge/               # types, KnowledgeBase (scoring search), Distiller (LLM reflection)
│   ├── tools/builtin/           # kb_search (read-only) + kb_write (gated)
│   ├── agent/ router/ orchestrator/ pattern/   # memory injection chain
│   ├── repl.ts / runtime.ts     # REPL 交互模式（无参启动）+ 运行时开关（/memory /kbwrite → rebuild）
│   └── storage/                 # SQLite: adds kb_entries + kb_reads + kb_distill_runs
├── phase-08-observability/      # Observability (traces + spans, mini-OTel)
│   ├── observability/           # Tracer (ALS), Logger (JSONL), pricing, trajectory (tree render)
│   ├── agent/ router/ orchestrator/ pattern/ a2a/   # span instrumentation
│   ├── cli.ts / repl.ts / runtime.ts  # trace wiring + trace/stats subcommands + receipts
│   └── storage/                 # SQLite: adds traces + spans (Span tree, ms)
└── phase-09-claude-code-brain/  # Brain abstraction + Claude Code runtime (= phase-08 copy + additions)
    ├── agent/brain.ts           # ★ Brain interface (reply(req, events))
    ├── agent/anthropic-brain.ts # ★ Phase 6/8 LLM loop moved verbatim (fallback)
    ├── agent/claude-code-brain.ts # ★ Agent SDK query() + stream state machine + budget guard + kb MCP
    ├── agent/cc-permissions.ts  # ★ canUseTool→Sandbox mapping (fail-closed)
    ├── registry/                # AgentConfig + runtime field
    ├── cli.ts / repl.ts / runtime.ts  # --brain/--cc-* flags · makeBrainFactory · brainDeps()
    └── observability/trajectory.ts    # llm summary + cc $x(SDK) display
```

## Agent Configuration

Agents are defined as JSON in `config/agents/`:
- `id`: Unique identifier
- `name`, `emoji`: Display info
- `model`: LLM model (e.g., "claude-opus-4-8")
- `runtime` (Phase 9): `anthropic` (bare API + tool loop) or `claude-code` (CC agentic loop); omitted = anthropic
- `persona`: System prompt defining personality
- `traits`: Additional metadata

Example: `ji-tui.json` (the default agent "🍗 鸡腿")

## Documentation Structure

```
docs/
├── learning-path/
│   ├── README.md               # Phase overview + progress
│   ├── phase-00-foundation.md  # Foundation + 5 abstractions
│   ├── phase-01-single-agent.md
│   ├── phase-02-agent-identity-memory.md
│   ├── phase-03-multi-agent-routing.md
│   ├── phase-04-agent-to-agent-collaboration.md
│   └── …（每个 phase 一篇；phase-08-observability.md 为最新）
├── architecture/
│   └── core-abstractions.md    # Deep dive into 5 abstractions
└── decisions/                   # ADRs + bug-fix retrospectives (one decision per file)
    ├── _template.md             # ADR template (NNNN-short-desc.md)
    ├── _template-bugfix.md      # bug-fix postmortem template
    ├── 013-trace-span-tree-als.md       # P8: Span tree + ALS design
    ├── 014-fix-p7-001-pattern-agents-flag-ignored.md  # P7 regression found via traces
    └── 015-brain-abstraction-cc-runtime.md            # P9: Brain abstraction + Claude Code runtime
```

Truth sources:
- **Phase behavior/spec** → `docs/learning-path/phase-XX-*.md`
- **Architecture theory** → `docs/architecture/core-abstractions.md`
- **Design decisions** → `docs/decisions/`

## Key Design Principles

1. **面向终态 (End-state oriented)**: Each phase builds foundation, not scaffolding
2. **Agent ≠ LLM**: Same LLM can power different agents—distinction is persona + memory
3. **Message ≠ Text**: User input is just `Message{from:"user"}`; all communication is Messages
4. **No Frameworks During Learning**: Implement Router/Agent/Memory directly to understand principles
5. **Verification = Done**: Evidence speaks, not confidence

## Important Distinctions

- **Router** (Phase 3): Per-message dispatch → "who handles this"
- **Orchestrator** (Phase 5): Task-level flow → "how agents collaborate"
- **Thread**: Short-term shared state (session-scoped)
- **KnowledgeBase**: Long-term shared memory (cross-session, Phase 7)

## Current Progress

Phases 0-9 complete. Phase 10 (Web UI & Productization, optional) is next.

Phase 9 added the **Brain abstraction + Claude Code runtime**: the LLM loop is extracted from `Agent` into a swappable `Brain` interface; `ClaudeCodeBrain` embeds `@anthropic-ai/claude-agent-sdk` `query()` so bob/nim/ji-tui (all default `runtime: "claude-code"`) get the full CC agentic loop (native Read/Edit/Bash/Grep). Hard Rails preserved via `canUseTool`→`Sandbox` mapping with `settingSources: []` isolation (user allow-rules must not leak in — bypass found and fixed in testing); kb tools mounted in-process as the `team-kb` MCP server (attribution passes through, gates honored). Observability maps cleanly: per-turn llm spans, CC tool spans via tool_use/tool_result pairing, `cc_cost_usd` (SDK-authoritative cost) on the final span; guards `--cc-max-turns=15` / `--cc-budget=0.5`. Fallback: `--brain=anthropic` behaves exactly like Phase 8. Design and pitfalls in ADR-015.

Phase 8 added **observability**: a `traces`+`spans` Span tree (mini-OTel; parent_id self-referencing; kinds route/kb/agent/llm/tool/a2a/distill) with AsyncLocalStorage context propagation (immutable derived context — parallel fan-out safe), written via `runSpan` (wrap) / `recordSpan` (event-driven). LLM token usage captured at all 3 call sites via `onLlmCall` events → llm spans; billing is read-time × `config/pricing.json` (`stats` subcommand, `--by=agent|thread|day`). Replay: `trace [list]` / `trace show <id|last> [--full]` waterfall tree; every chat/pattern/distill run prints a 📊 receipt. Structured logs: `logs/<date>.jsonl` + stderr threshold (`--verbose`), never stdout. Design in ADR-013; the trace view exposed and fixed a Phase 7 regression (`--agents=` silently ignored in pipeline/parallel — ADR-014, fixed in phase-08 only). Smoke: `npm run smoke8`.

Phase 7 added **shared memory / KnowledgeBase**: three orthogonal lines over `kb_entries` — *push* (Router/Orchestrator inject top-K retrieved memories into the system prompt each turn; auditable via `kb_reads` + `--show-memory`), *pull* (`kb_search`/`kb_write` tools, write gated by `--allow-kb-write`, always `verified=0`), and *distill* (`Distiller` extracts decision/lesson/observation/outcome entries from threads via strict `<entry>` tags with 3-tier parsing and double idempotency). Retrieval = JS weighted scoring (FTS5 rejected for CJK — ADR-011). New tables `kb_entries`/`kb_reads`/`kb_distill_runs` (ms). CLI: `npm run phase7 -- --kb-add/--kb-search/--kb-distill/--show-memory`.

Phase 6 added **tool use** (Anthropic function calling): `Agent.reply` runs a multi-turn `tool_use → execute → tool_result` loop; a `ToolRegistry` + per-Agent `tools` whitelist gate 5 builtin tools (`read_file`/`write_file`/`list_files`/`search_files`/`run_command`); a multi-layer `Sandbox` (path-escape incl. symlink following, command whitelist, forbidden patterns, metachar rejection, `--allow-write`/`--allow-exec` authorization) is the Hard-Rails floor. Tools are orthogonal to Patterns (the loop lives inside `reply`). New table `tool_calls` (ms timestamps). CLI: `npm run phase6 -- --list-tools`, `@agent 读 package.json`, `--show-tools` replay.

See `docs/learning-path/README.md` for the full roadmap and `docs/architecture/core-abstractions.md` for architectural theory.

## Reference Implementation

When stuck on how to implement something, refer to Clowder AI at `~/lhz/clowder-ai`:
- Clowder `packages/api/src/` → production implementations
- This project's `docs/architecture/core-abstractions.md` → theory
- This project's `docs/decisions/` → why specific design choices were made
