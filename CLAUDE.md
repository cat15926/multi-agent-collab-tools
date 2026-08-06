# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **learning project** to build a multi-agent collaboration tool from scratch, phase by phase. The goal is to understand the core abstractions by implementing them directly—**not by using frameworks** like LangChain, LangGraph, AutoGen, or CrewAI during the learning phase.

Reference implementation: [Clowder AI](https://github.com/zts212653/clowder-ai) (locally at `~/lhz/clowder-ai`)

## Development Commands

```bash
# Run each phase's CLI
npm run phase1    # Phase 1: Single Agent MVP
npm run phase2    # Phase 2: Agent Identity & Memory
npm run phase3    # Phase 3: Multi-Agent + Message Routing
npm run phase4    # Phase 4: Agent-to-Agent Collaboration

# Type checking (recommended before commits)
npm run typecheck

# Build
npm run build
```

## Tech Stack

- **TypeScript** + **Node.js >= 24** (ES2022 target, ESNext modules)
- **Direct LLM SDKs**: `@anthropic-ai/sdk` (no frameworks during learning phase)
- **Storage**: SQLite via `better-sqlite3`
- **Runtime**: `tsx` for direct TypeScript execution

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

**Hard Rails + Soft Power**: Safety rails are non-negotiable floors; above that, agents self-coordinate.

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
└── phase-04-agent-to-agent/     # A2A collaboration
    ├── a2a/                     # A2A parser, decider, handler
    └── router/                  # Enhanced routing with A2A
```

## Agent Configuration

Agents are defined as JSON in `config/agents/`:
- `id`: Unique identifier
- `name`, `emoji`: Display info
- `model`: LLM model (e.g., "claude-opus-4-8")
- `persona`: System prompt defining personality
- `traits`: Additional metadata

Example: `ji-tui.json` (the default agent "🍗 鸡腿")

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

Phases 0-4 complete. Phase 5 (Collaboration Patterns) is next.

See `docs/learning-path/README.md` for full roadmap, `docs/architecture/core-abstractions.md` for deep architectural theory.
