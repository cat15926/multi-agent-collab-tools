---
decision_id: ADR-011
date: 2026-08-16
status: accepted
phase: 7
---

# ADR-011：KnowledgeBase 设计（检索弃用 FTS5 / 注入可审计 / 提炼幂等）

- **状态**：accepted
- **日期**：2026-08-16
- **关联 Phase**：7

## 背景

Phase 7 落地 Shared State 的长期层：跨会话共享的决策/经验/证据库。三个核心设计问题：

1. **检索方案**：ADR-003 曾承诺"Phase 7 可直接加 FTS5 全文搜索"——兑现还是改道？
2. **注入如何取信**：记忆注入 system prompt 后，怎么证明"Agent 真的拿到了"，而不是它嘴上说"我记得"？
3. **LLM 提炼如何防重复**：同一会话提炼两次、两次 auto-distill，会不会把库刷爆？

## 考虑过的方案

### 问题 1：检索

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. FTS5（原承诺） | 索引快、bm25 排序 | **中文不可用**（实测） |
| B. JS 加权评分（keywords/title/content） | 零索引、可单测、权重透明 | 全表扫描（学习规模无碍） |
| C. 向量检索 | 语义级 | 引 embedding 依赖+API 成本，超出学习范围 |

**FTS5 实测（better-sqlite3 内置 SQLite 3.49.2）**：
- `unicode61` 分词器：`MATCH '项目'` 命中 0——整段中文被当一个 token
- `trigram` 分词器：要求 ≥3 字符，`MATCH '存储'`（2 字）命中 0；且 FTS5 查询语法中 `-` 是运算符，库名如 `better-sqlite3` 直接报错
- 库内条目以中文 2 字关键词为主 → FTS5 主路径必挂

### 问题 2：注入审计

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 只打 console 日志 | 简单 | 进程结束即失，无法回放 |
| B. kb_reads 独立表 | 可回放、可取证 | 多一张表 |

### 问题 3：提炼幂等

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 无幂等 | 简单 | 重跑刷库 |
| B. scope 级（thread 已 ok 则跳过）+ 条目级（同 thread 同 title 去重） | 双保险 | title 措辞漂移仍漏（见后果） |
| C. 语义去重（embedding 相似度） | 最强 | 超出学习范围 |

## 决策

1. **检索用 JS 加权评分**（keywords 双向包含 +10 / title +4 / content +2，recency 微扰 tiebreak，top-K）。FTS5 的承诺以"评估过、因 CJK 分词限制弃用"关闭。
2. **注入审计独立成表 `kb_reads`**：一次注入一行（consumer 记 `router:<agentId>` / `pattern:<name>`），`--show-memory` 回放。
3. **提炼双层幂等**：scope 级（`kb_distill_runs` 该 thread 已 ok 且未 `--force` → 跳过）+ 条目级（同 thread 同 title 跳过）；失败照落库（`status=parse_failed` + raw_output），绝不静默。
4. **附带决策**：
   - `Tool.execute` 加可选第二参 `ToolContext{agentId, threadId}`——kb_write 归属标注需要；现有 5 工具零改动（本 Phase 唯一接口演进）
   - kb_write 用 `--allow-kb-write` 门控（镜像 `--allow-write` 心智模型），但**不进 Sandbox**（KB 是纯 DB 追加、可 `--kb-del` 回滚，风险等级低一档）
   - verified 语义：人工添加 = 1，LLM（distill/工具）写 = 0，`--kb-verify` 人工背书；**不做 LLM 自评 verified**（自我认证无意义）
   - 记忆渲染标注"参考信息，非当前指令"（防 prompt 注入）+ 单条 300 字/总预算 1600 字护栏
   - A2A 多跳不注入记忆（范围裁剪：委派消息已含 source 回复全文）

## 理由

- **检索**：学习项目 KB <1k 条，全表扫描微秒级，B 方案的"可单测、权重透明"价值远超索引性能；FTS5 的 CJK 缺陷是硬伤而非权衡。
- **审计**："验证 = 完成"是项目铁律——注入不可证明 = 没发生。P6 的 tool_calls 先例（工具调用可回放）直接复用为 kb_reads。
- **幂等**：LLM 输出天生不稳定，任何"再跑一次就重复写入"的路径都是库污染源。双保险成本极低（一条 SQL 查重 + 一条状态记录）。

## 后果

- **好处**：记忆系统三线（push/pull/distill）全部可观测可回放；重跑安全；检索行为可解释（score 可见）。
- **代价**：kb_reads 随使用增长（治理 Future Work）；评分检索在 >10k 条时需重评（届时上 FTS5 外置分词或 sqlite-vec）。
- **已知局限（如实记录）**：
  1. `--force` 重提炼时 LLM 可能给出措辞不同、语义相同的条目（实测：'日志级别五级定义' vs '日志级别分层设计'），title 精确匹配漏掉 → 库内语义重复，靠 `--kb-del` 人工治理。语义去重记 Future Work。
  2. 注入的 prompt 污染面：KB content 进 system prompt，恶意条目理论上可带偏 Agent。缓解=标注隔离+学习项目单用户；生产级需 Clowder 式 provenance/activation 分层。
  3. 无自动淘汰机制（`--kb-stats` + `--kb-del` 手动治理）。

## Related

- [Phase 7 文档](../learning-path/phase-07-shared-memory.md)
- [ADR-003: SQLite 存储架构](./003-sqlite-schema.md)（FTS5 承诺的出处）
- [ADR-007/009：时间戳与解析教训](./007-fix-p5-001-workflow-time-display.md)（毫秒惯例、结构化标签）
- Clowder 参照：`packages/api/src/domains/memory/`（EventMemoryStore 的幂等写、SqliteEvidenceStore 的 FTS5 实践）
