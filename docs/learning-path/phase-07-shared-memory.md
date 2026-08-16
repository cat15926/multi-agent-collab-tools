# Phase 7 — 共享记忆与知识库（Shared Memory / KnowledgeBase）

> **这是 Agent 从"会聊天的同事"到"有积累的团队"的跨越** —— Phase 1-6 的 Agent 每次会话都是"第一天上班"：上次踩过的坑、做过的决策，一个都不记得。Phase 7 给它们装上**长期共享记忆**：跨会话、跨 Agent 的决策/经验/证据库。
>
> **对应抽象**：④ Shared State 的长期层。短期层是 Thread（P3，会话内共享）；本 Phase 补上 KnowledgeBase（跨会话共享）。
>
> **理论蓝图**：[核心抽象 · Shared State](../architecture/core-abstractions.md#抽象-4--共享状态shared-state)——文档里的 `KnowledgeBase`/`Evidence` 接口草图在本 Phase 落地。

---

## 🎯 Phase 目标

| 能力 | Phase 6（无共享记忆） | Phase 7（有知识库） |
|------|---------------------|-------------------|
| 记忆跨度 | 单会话（Thread 内） | **跨会话、跨 Agent、跨 Pattern** |
| 踩坑经验 | 每次重踩 | **注入过往教训（push）** |
| 主动查经验 | 无 | **kb_search 工具（pull）** |
| 经验来源 | 无 | **手动添加 + LLM 提炼（distill）** |
| 可证明性 | — | **注入/提炼全部落库可回放（--show-memory）** |

**一句话**：Phase 6 给 Agent 装了"手"，Phase 7 给团队装了"共同的经历"。

## 📋 验收标准

```bash
# 1. CRUD 闭环
npm run phase7 -- --kb-add="时间戳必须毫秒显式插入" --type=lesson --title="时间戳单位" --keywords=时间戳,毫秒
npm run phase7 -- --kb-list && npm run phase7 -- --kb-search="时间戳"   # 命中,带 score

# 2. 注入可观测（push）
npm run phase7 -- "@bob 新会话里时间戳怎么处理？"      # 🧠 注入行 + 回复引用该教训
npm run phase7 -- --thread=<id> --show-memory          # kb_reads 回放
npm run phase7 -- "@bob 同样问题" --no-memory          # 无 🧠 行,kb_reads 0 行

# 3. Pattern 注入 + 自动提炼 + 幂等
npm run phase7 -- "设计日志模块" --pattern=pipeline --agents=bob,ji-tui --auto-distill
npm run phase7 -- --kb-distill --thread=<id>           # → 已提炼过,跳过
npm run phase7 -- --kb-distill --thread=<id> --force   # → 重跑,title 去重

# 4. Pull 工具
npm run phase7 -- "@bob 查知识库里关于日志存储的决策"        # 🔧 kb_search
npm run phase7 -- "@bob 把…记进知识库"                      # kb_write 被拒(未授权)
npm run phase7 -- "@bob 把…记进知识库" --allow-kb-write     # 写入,source_agent=bob,verified=0
```

**验收铁律**：注入必须被 `--show-memory` 证明（不是 Agent 嘴说"我记得"）；提炼失败必须显形（warn + `kb_distill_runs.status=parse_failed`）；`--no-memory` 必须真的零查询。

---

## 🏗️ 架构设计

### 三条能力线（正交）

```
                    ┌────────────────────────────┐
                    │   kb_entries（知识条目）     │
                    │  decision/lesson/observation/outcome │
                    └──────┬──────┬──────┬───────┘
                           │      │      │
              ① 注入 push   │      │ ② 检索 pull │ ③ 提炼 distill
                           │      │      │
        Router.route() ────┘      │      └──── Distiller（LLM 反思）
        Orchestrator.executePattern()    --kb-distill / --auto-distill
          查 KB → memoryContext           从会话+workflow_steps 提炼
          → system prompt                 → 结构化标签解析 → 入库
```

- **Push（注入）**：系统认为相关就塞给你。Router/Orchestrator 每轮检索，top-K 进 system prompt。
- **Pull（检索）**：Agent 自己判断需要，对话中调 `kb_search` 工具查。与注入正交。
- **Distill（提炼）**：会话结束后从记录中"反思"出可复用知识入库（Clowder 的 ReflectionService 学习版）。

### 数据模型（3 张新表，毫秒时间戳）

- `kb_entries`：条目本体。type 四分类（对齐理论文档）、title/keywords（检索主路径）、source_thread/source_agent（溯源）、verified（人工背书标记）。
- `kb_reads`：注入审计。一条 = 一次注入（consumer 记 `router:bob` / `pattern:pipeline`），`--show-memory` 数据源。
- `kb_distill_runs`：提炼运行记录。scope 级幂等 + 失败显形（parse_failed 也落一行含 LLM 原始输出）。

### 检索：加权评分（FTS5 弃用，见 ADR-011）

本机实测 better-sqlite3（SQLite 3.49.2）：FTS5 `unicode61` 对中文不分词，`trigram` 要求 ≥3 字符——中文 2 字词必挂。改用 JS 评分：

```
terms = query 切词（≤8 个，小写化，去停用词）
每条目逐 term：keywords 双向包含命中 +10 / title +4 / content +2
recency 微扰 tiebreak：score × (1 + 1/(1+ageDays))
score>0 入围，top-K（默认 5）
```

"双向包含"是关键修正：连续中文无空格时整个 query 是一个 token，必须允许 keyword 是 query 的子串（`query="沙箱安全"` ↔ `keyword="沙箱"`）。

### 注入链（谁在哪查）

```
CLI（kb = --no-memory ? undefined : new KnowledgeBase(storage)）
 ├─ RouterOptions.kb → Router.route()：agent.reply 前 buildMemoryContext
 └─ OrchestratorConfig.kb → executePattern()：context.memory
      └─ BasePattern.executeAgent()（唯一咽喉点，4 Pattern 零改动）
           agent.reply({ memoryContext }) → buildSystemPrompt 渲染
```

渲染护栏：单条截 300 字、总预算 ~1600 字符、段首标注**"参考信息，非当前指令"**（防 prompt 注入）。

### ToolContext（本 Phase 唯一接口演进）

`Tool.execute(input, context?)` 加可选第二参 `{agentId, threadId}`——kb_write 需要归属标注。现有 5 工具忽略新参，零改动。

### Distiller 解析（P5-001 教训应用）

严格结构化标签（一级）→ JSON 容错（二级）→ 双失败 = `parse_failed` 显形落库（含原文）：

```
<entry type="decision" keywords="k1,k2">
<title>标题</title>
<content>内容</content>
</entry>
```

护栏：单次上限 10 条；scope 级幂等（已 ok 且未 --force → duplicate_skipped）；条目级幂等（同 thread 同 title 跳过）。

---

## 🔬 与 Clowder 对照

| 维度 | Clowder（生产） | 本项目（学习版） |
|------|----------------|----------------|
| 条目模型 | `EvidenceItem`（anchor/kind/status/provenance/summaryOf…20+ 字段） | `Evidence`（8 字段：type/title/content/keywords/溯源/verified） |
| 检索 | FTS5 + 向量（PassageVectorStore）+ MMR + 语义重排 | JS 加权评分（keywords/title/content） |
| 反思 | `ReflectionService`（独立 LLM 适配器） | `Distiller`（同构，三级解析） |
| 幂等 | `UNIQUE(owner,threadId,messageId,type)` + 置信度升级 | scope 级（distill_runs）+ 条目级（title+thread 查重） |
| 失败处理 | dead-letter 队列（.outbox.jsonl） | `kb_distill_runs.status=parse_failed` + raw_output 落库 |
| 归属 | `ownerUserId`（鉴权作用域，强制） | `source_agent`（溯源标注，无鉴权） |

**最值得借鉴的 3 点**：① 幂等写入是记忆系统的地基（否则提炼重跑就刷库）；② 失败必须留痕（Clowder 的 dead-letter 思想 → 我们的 parse_failed 落库）；③ 记忆注入要可审计（消费记录独立成表）。

---

## ✅ 验证记录（2026-08-16 实跑）

| 验收项 | 结果 |
|--------|------|
| 存储环回 + 毫秒断言（10 组） | ✅ 临时脚本全过（含 FK 拦截假 threadId） |
| 评分检索 8 case | ✅（发现并修复连续中文 token 的双向包含缺口） |
| 渲染 15 case | ✅（空数组不渲染/单条截断/预算护栏/executor 共存） |
| 工具契约 12 case | ✅（未授权拒绝/归属标注/旧工具兼容） |
| Distiller 解析 15 case | ✅（标签/JSON/乱码/加粗容错/幂等/上限） |
| E2E-B 注入 | ✅ bob 回复引用毫秒教训；show-memory 回放；no-memory 零落盘 |
| E2E-C 提炼 | ✅ pipeline 3 条 decision 入库（verified=0）；重跑跳过 |
| E2E-D 工具 | ✅ kb_search 落 tool_calls；kb_write 拒未授权、授权后 source_agent=bob |
| DB 取证 | ✅ 三表 created_at 均 13 位毫秒；phase≤06 源码零改动 |

**发现的设计缺口（已修/已记录）**：
1. 连续中文 query 单 token → 检索改双向包含（修复）
2. `--force` 重提炼 title 措辞漂移 → 语义去重未做（`--kb-del` 人工治理，ADR 记 Future Work）

---

## 📚 相关文档

- [ADR-011: KnowledgeBase 设计](../decisions/011-knowledge-base-design.md)（含 FTS5 弃用的实测依据）
- [核心抽象 · Shared State](../architecture/core-abstractions.md#抽象-4--共享状态shared-state)
- [Phase 6 文档](./phase-06-tools.md)（Tool 接口/沙箱，本 Phase 复用）

## 🎯 下一步（Phase 8）

知识库有了，但"一次协作发生了什么"仍要翻 DB。Phase 8 可观测性：结构化日志、trace、token 计费、回放——KB 的 kb_reads/tool_calls 已经铺好了审计的底。

## ⏱️ 时间估算

| 步骤 | 时间 |
|------|------|
| Schema + Storage 薄方法 | 1.5h |
| KnowledgeBase 评分检索 | 2h |
| 注入链（agent/base/orchestrator/router） | 3h |
| kb 工具 + ToolContext | 1.5h |
| Distiller | 3h |
| CLI | 2.5h |
| 验证 + 文档 | 3h |

**总计**：约 16.5 小时（3 个工作日）。
