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

# Type checking (recommended before commits)
npm run typecheck
```

## Tech Stack

- **TypeScript** + **Node.js >= 24** (ES2022 target, ESNext modules)
- **Direct LLM SDKs**: `@anthropic-ai/sdk` (no frameworks during learning phase)
- **Storage**: SQLite via `better-sqlite3`
- **Runtime**: `tsx` for direct TypeScript execution

### Environment & Storage

- **API key**: The Anthropic client is constructed bare (`new Anthropic()`, no args), so `ANTHROPIC_API_KEY` **must be set in the environment**. The code does not load `.env` — export it in your shell. Set `ANTHROPIC_BASE_URL` too if your `config/agents/*.json` `model` values route through a relay/proxy.
- **Database location**: All phases share `~/.multi-agent-collab-tools/memory.db` (under `$HOME`, gitignored). Phase 5 extends the same DB with `workflow_executions` + `workflow_steps` tables.

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
└── phase-05-patterns/           # Structured collaboration patterns (Pattern + Orchestrator)
    ├── pattern/                 # Pattern interface, BasePattern (template method), registry
    ├── patterns/                # pipeline / parallel / debate / hierarchy implementations
    ├── orchestrator/            # Orchestrator + WorkflowTracker (executes & persists runs)
    ├── agent/ router/ thread/ registry/ a2a/   # reuse Phase 4 components
    └── storage/                 # SQLite: adds workflow_executions + workflow_steps tables
```

## Agent Configuration

Agents are defined as JSON in `config/agents/`:
- `id`: Unique identifier
- `name`, `emoji`: Display info
- `model`: LLM model (e.g., "claude-opus-4-8")
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
│   └── phase-04-agent-to-agent-collaboration.md
├── architecture/
│   └── core-abstractions.md    # Deep dive into 5 abstractions
└── decisions/                   # ADRs + bug-fix retrospectives (one decision per file)
    ├── _template.md             # ADR template (NNNN-short-desc.md)
    ├── _template-bugfix.md      # bug-fix postmortem template (e.g. 004/005/006 = P4 fixes)
    ├── 002-agent-config-format.md
    └── 003-sqlite-schema.md
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

Phases 0-5 complete. Phase 6 (Tools / function calling) is next.

See `docs/learning-path/README.md` for the full roadmap and `docs/architecture/core-abstractions.md` for architectural theory.

## Reference Implementation

When stuck on how to implement something, refer to Clowder AI at `~/lhz/clowder-ai`:
- Clowder `packages/api/src/` → production implementations
- This project's `docs/architecture/core-abstractions.md` → theory
- This project's `docs/decisions/` → why specific design choices were made
