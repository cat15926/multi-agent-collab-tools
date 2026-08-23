# Phase 9 — Claude Code Brain（Brain 可替换化 + 接入 Claude Agent SDK）

> 动议来源：让 bob/nim/ji-tui 附上 Claude Code 的完整能力（Read/Edit/Bash/Grep 原生工具 agentic loop）。
> 对应 roadmap 原 Phase 10「外部平台接入」主题提前；原 Phase 9「Web UI」顺延为 Phase 10。
> 三步落地：**Step 0** Brain 接口抽取（纯重构）→ **Step 2** ClaudeCodeBrain（SDK `query()`）→ **Step 3** 观测映射。

## 🎯 Phase 目标

| Phase 8 结束时 | Phase 9 目标 |
|----------------|--------------|
| Agent 的 LLM 循环焊死在 Agent 类里 | `Brain` 接口可替换（AnthropicBrain / ClaudeCodeBrain） |
| 能力边界 = 5 个自研 builtin 工具 | CC 完整 agentic loop（原生 Read/Edit/Bash/Grep + team-kb MCP） |
| Hard Rails 只管自研工具 | canUseTool → Sandbox 映射，CC 工具同样过白名单 |
| 观测面只认识自研 tool loop | 逐 turn llm span + CC 工具 span + cc_cost_usd（SDK 口径成本） |

## 🏗️ 架构设计

### Brain 接口（「Agent ≠ LLM」的终极验证）

```
Agent（persona / 记忆渲染 / 会话投影）          ← brain 无关
  └─ Brain.reply({agentId, threadId, systemPrompt, messages}, events)
       ├─ AnthropicBrain   = Phase 6/8 循环原样搬入（回退路径，零行为变化）
       └─ ClaudeCodeBrain  = Agent SDK query()（默认，runtime 字段选择）
```

- 选择器：`--brain=` > `config/agents/*.json` 的 `runtime` > 默认 anthropic；三个 Agent 已设 `claude-code`
- router/pattern/a2a 三个 `reply()` 调用点零改动

### ClaudeCodeBrain 关键机制（详见 ADR-015）

- **无状态**：项目 Thread 唯一记忆源，历史 `<conversation_history>` 标签包裹随 prompt 重发
- **双层沙箱**：CC 自带 cwd 边界 + canUseTool→Sandbox 映射；`settingSources: []` 隔离（实测修复：否则用户 `.claude/settings.local.json` 的 allow 规则会绕过沙箱自动放行）
- **kb 工具进程内注入**：`createSdkMcpServer`（zod schema）→ `mcp__team-kb__kb_search/kb_write`，归属标注（ToolContext）穿透，kb_write 自门控，`/memory off` 不挂
- **观测映射**：逐 assistant 消息 onLlmCall（turn 递增）；最后一条延迟补发挂 `ccTotalCostUsd`；工具 tool_use/tool_result 配对发 onToolCall；deny 在拒绝点即发 blocked 事件（toolUseID 防双记 + permission_denials 对账）
- **守卫**：`--cc-max-turns=15`（error_max_turns 返回部分文本不 throw）+ `--cc-budget=0.5`（读时计价累计 → abort；未配价自动降级 warn）

## 🔬 与 Clowder 对照

| 本项目（学习版） | Clowder（生产） | 差异 |
|------------------|-----------------|------|
| Agent SDK `query()` 进程内 | spawn `claude -p --output-format stream-json` 子进程 | Clowder 要统一 claude/codex/gemini/opencode 多 CLI；本项目只需 claude → SDK 内嵌更干净 |
| canUseTool → Sandbox 逐调用 | `--permission-mode` 粗粒度 | SDK 路线护栏更细 |
| createSdkMcpServer 进程内 kb | `--mcp-config` 独立 server 进程 | 同上 |
| settingSources: [] 隔离 | `--setting-sources project,local` 显式选择 | 同一个坑：默认会继承用户设置 |
| result.total_cost_usd | stream-json 事件提取（extractClaudeUsage） | 皆读时对账思想 |

## ✅ 验证记录（2026-08-23 实跑）

| # | 场景 | 结果 |
|---|------|------|
| 0 | Step 0 纯重构：typecheck 过；chat+工具全链路；trace 树与 phase8 同构（route→kb→agent→llm×2/tool）；A2A 跳（bob→@nim 接力）正常；smoke8 全过 | ✅ |
| 1 | CC 最小闭环：`@bob 一句话介绍`（persona 经 systemPrompt.append 生效）；trace llm span 逐 turn | ✅ 12.4s（首跑冷启动） |
| 2 | CC + Read：`@bob 看 package.json 的 script` → `tool:Read` span + tool_calls 落盘 + `--show-tools` 回放 | ✅ 4.8s |
| 3 | 沙箱·写：无 `--allow-write` 创建文件 → Write/Bash(重定向)/Bash(管道)/node -e 全拦 🚫；模型穷举 4 种绕法均被拒，最终承认需授权。**修复 settingSources 前曾发现 `npx tsx -e` 经用户 settings.local.json 的 allow 规则穿透**（ADR-015 坑记录）；修复后文件未创建 ✓；带 `--allow-write` → Write+Read 正常 | ✅ |
| 4 | 沙箱·读/命令：Read `/etc/hosts` → 🚫 越界拦；`git log` 白名单放行；`rm -rf` 黑名单拦 | ✅ |
| 5 | kb MCP：未授权 kb_write → 自门控 err（⚠️ status=error）；`--allow-kb-write` → 落库 `source_agent=bob, verified=0` ✓；kb_search 检索回填 | ✅ |
| 6 | REPL：`/kbwrite on` **下一行**生效（brain 工厂每行重建）→ nim 经 MCP 落库 `source_agent=nim` | ✅ |
| 7 | Pattern：pipeline `--agents=bob,ji-tui` 全 CC → 2 agent span · llm×22 · tool×8（真实 Read/grep 调研后作答） | ✅ 21.0s |
| 8 | 守卫：`--cc-max-turns=2` 大任务 → 返回部分文本不 throw（SDK throw 路径已转换）；`--cc-budget` 逻辑审查通过（relay 环境 usage=0 无法触发，降级路径实测 warn） | ✅ |
| 9 | 观测：llm span attributes 带 `cc_cost_usd: 0.035` + `cc_num_turns`（最后一条）；trace 树显示 `cc $0.0350(SDK)` | ✅ |
| 10 | 回退：`--brain=anthropic` 全场景行为同 phase8；`src/phase-0{1..8}` 零改动；smoke8 不受影响 | ✅ |

**环境说明**：本机走 relay（实际模型 `glm-4.7`）——usage 不上报（tokens 0、成本 `?`，符合 R3「不猜」设计），但 SDK `total_cost_usd` 仍可用（cc_cost_usd）。要启用计费/预算可在 `config/pricing.json` 加该模型单价。

## 📁 文件组织

```
src/phase-09-claude-code-brain/       # = phase-08 拷贝 + 增改
├── agent/
│   ├── brain.ts                      # ★ Brain/BrainRequest/BrainEvents 接口
│   ├── anthropic-brain.ts            # ★ 原 LLM 循环原样搬入（回退路径）
│   ├── claude-code-brain.ts          # ★ query() + 流状态机 + 预算守卫 + kb MCP
│   └── cc-permissions.ts             # ★ canUseTool→Sandbox 映射 + fail-closed
├── agent/agent.ts                    # 瘦身：prompt 组装→brain.reply；brain? 注入
├── registry/agent-registry.ts        # AgentConfig + runtime 字段（缺省 anthropic）
├── cli.ts                            # --brain/--cc-* flags · makeBrainFactory · cc attrs
├── runtime.ts                        # brainDeps() getter（REPL 每行取当前开关）
├── repl.ts                           # 每行重建 brain 工厂 · Phase 9 横幅
└── observability/trajectory.ts       # llm 摘要追加 cc $x(SDK)
config/agents/{bob,nim,ji-tui}.json   # runtime: claude-code
package.json                          # +claude-agent-sdk 0.3.241 +zod 4 +mcp-sdk（peer）
```

零改动：`router/` `pattern/` `patterns/` `a2a/` `orchestrator/` `storage/`（schema 零变更）`tools/` `knowledge/` `distiller.ts` 及全部 phase≤08（git 证明）。

## 🔧 实现顺序（实际）

1. 拷目录+依赖（npm 与 pnpm node_modules 冲突 → pnpm install）→ 2. **Step 0** Brain 抽取+全链路验证 → 3. runtime 字段+--brain=+工厂（anthropic 分支）→ 4. ClaudeCodeBrain+流状态机（发现 duration 计算坑：先覆盖再作差量成传输延迟，改用消息 timestamp 差）→ 5. 沙箱映射（**发现 settingSources 默认全加载 → npx tsx 穿透 → 隔离模式修复**）+ kb MCP → 6. 守卫与成本补发（**发现 error_max_turns 是 throw 不是 result 消息** → catch 转换）→ 7. REPL 接线（**发现 flags-only→REPL 放初始化后导致 Pattern 重复注册** → 提前判断）+ trajectory + 配置切换 → 8. 文档。

## ⏱️ 时间估算

| 步骤 | 估时 | 实际 |
|------|------|------|
| 拷贝+依赖 | 1h | 0.5h（含 npm/pnpm 冲突） |
| Step 0 Brain 抽取 | 3h | 2h |
| 接线（runtime/--brain=/工厂） | 2h | 1.5h |
| ClaudeCodeBrain+流状态机 | 5h | 3.5h（含 duration 坑） |
| 沙箱映射+kb MCP | 4h | 3h（含 settingSources 穿透修复） |
| 守卫+事件+成本 | 3h | 2h（含 max-turns throw 转换） |
| REPL+trajectory+配置 | 2h | 1.5h（含 Pattern 重复注册修复） |
| 验收+文档 | 4h | 3h |
| **合计** | **≈24h** | **≈17h** |

## 🎯 下一步（Phase 10，按需）

Web UI 与产品化（浏览器聊天界面、多线程、@路由、Agent 卡片、轨迹可视化）。

## 📚 相关文档

- [ADR-015：Brain 抽象 + CC 运行时](../decisions/015-brain-abstraction-cc-runtime.md)
- [Phase 8 可观测性](./phase-08-observability.md)（观测映射的载体）
- [Agent SDK TypeScript 文档](https://docs.claude.com/en/api/agent-sdk/typescript)
