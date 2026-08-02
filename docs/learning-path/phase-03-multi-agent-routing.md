# Phase 3 — 多 Agent + 消息路由

> **这是"多 Agent"的起点** —— 从单 Agent 对话演进到多 Agent 协作的基础设施。
>
> **核心目标**：用户可以用 `@alice` / `@bob` 与不同 Agent 对话，每个会话独立隔离。
>
> **对应抽象**：② Message（结构化）、③ Router（6 层流水线）、④ Shared State（Thread 隔离）

---

## 🎯 Phase 目标

| 功能 | Phase 2 状态 | Phase 3 目标 |
|------|-------------|-------------|
| Agent 数量 | 单 Agent（通过 `--agent=` 切换） | 多 Agent 同时存在，Registry 管理 |
| 消息结构 | `{role, content}` | `{role, content, mentions, agentId, threadId}` |
| 路由方式 | 命令行参数显式指定 | `@mention` 解析 + 6 层流水线 |
| 会话隔离 | 单个 `default` 会话 | 每个 Thread 独立历史 |

---

## 📋 验收标准

完成本 Phase 后，以下场景应该都能跑通：

```bash
# 1. 列出所有可用 Agent
pnpm phase3 --list

# 2. 用 @mention 指定 Agent
pnpm phase3 "@alice 你好"
pnpm phase3 "@bob 自我介绍一下"

# 3. 多 Agent 在同一会话（Phase 4 才完整支持）
pnpm phase3 "@alice @bob 一起讨论这个方案"

# 4. 会话隔离：与 alice 的对话不影响 bob
pnpm phase3 --thread=thread-1 "@alice 我们聊到哪了？"
pnpm phase3 --thread=thread-2 "@bob 我们之前聊什么？"

# 5. 无 @mention 时的回退行为
pnpm phase3 "你好"              # 使用默认 Agent 或上次回复者
```

---

## 🏗️ 架构设计

### 整体流程图

```
┌─────────────────────────────────────────────────────────┐
│                         CLI                              │
│   $ pnpm phase3 "@alice 帮我设计登录页"                   │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                    Router (6 层流水线)                     │
│                                                          │
│  ① MentionParser:    提取 @alice                        │
│  ② TargetResolver:   验证 alice ∈ Registry               │
│  ③ FallbackResolver: 无 @ → 用默认/上次                  │
│  ④ Dispatcher:       唤醒 alice                         │
│  ⑤ ContextBuilder:   组装上下文                         │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                   Thread Manager                         │
│   • getOrCreate(threadId)                                │
│   • 管理 participants (user + agents)                    │
│   • 隔离对话历史                                          │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                     Agent Instance                        │
│   • 读取 Thread 历史                                       │
│   • 应用上下文窗口截断                                     │
│   • 生成回复（第 6 层：LLM 判断）                          │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                     Storage Layer                         │
│   • 存储 Thread / Participant / Message                   │
│   • 索引优化查询                                            │
└─────────────────────────────────────────────────────────┘
```

### 核心组件

#### 1. MentionParser（提及解析器）

**职责**：从用户输入中提取 `@handle`，并净化内容。

```ts
class MentionParser {
  /**
   * 解析用户输入中的 @mention
   * 规则：
   *   - 只识别行首的 @word
   *   - 忽略代码块中的 @（```code```）
   *   - 忽略转义的 \@（虽然 Markdown 不会转义到这一层）
   */
  parse(input: string): { mentions: string[]; cleanContent: string };

  /**
   * 提取 @mention 目标列表
   */
  extractMentions(input: string): string[];

  /**
   * 移除 @mention，返回"真正的内容"
   */
  stripMentions(input: string): string;
}
```

**实现要点**：
- 正则：`/(?:^|\n)@(\w+)(?=\s|$)/g`
- 需要跳过代码块：状态机或分段处理

#### 2. AgentRegistry（Agent 注册表）

**职责**：集中管理所有可用 Agent 的配置。

```ts
class AgentRegistry {
  private agents: Map<string, AgentConfig>;

  /** 注册或更新 Agent */
  register(config: AgentConfig): void;

  /** 获取单个 Agent 配置 */
  get(id: string): AgentConfig | undefined;

  /** 列出所有 Agent */
  listAll(): AgentConfig[];

  /** 检查 Agent 是否可用 */
  isAvailable(id: string): boolean;

  /** 解析 @handle → agentId */
  resolveHandle(handle: string): string | null;

  /** 获取默认 Agent（用于回退） */
  getDefaultAgent(): AgentConfig;
}
```

**来源**：启动时扫描 `config/agents/*.json`，排除 `template.json`。

#### 3. ThreadManager（会话管理器）

**职责**：管理会话生命周期和参与者。

```ts
class ThreadManager {
  /** 获取或创建会话 */
  getOrCreate(threadId?: string): Thread;

  /** 添加参与者 */
  addParticipant(threadId: string, agentId: string): void;

  /** 获取会话的所有参与者 */
  getParticipants(threadId: string): string[];

  /** 获取会话的完整历史 */
  getHistory(threadId: string): Message[];
}
```

**Thread 结构**：
```ts
interface Thread {
  id: string;
  title?: string;
  participants: string[];      // ["user", "alice", "bob"]
  createdAt: number;
  updatedAt: number;
}
```

#### 4. Router（路由器）

**职责**：6 层流水线的编排。

```ts
class Router {
  constructor(
    private registry: AgentRegistry,
    private threads: ThreadManager,
    private storage: Storage
  ) {}

  /**
   * 路由主流程
   * @param input 用户原始输入
   * @param threadId 可选的会话 ID（未指定则创建新会话）
   */
  async route(input: string, threadId?: string): Promise<Message>;
}
```

**6 层流水线实现**：

```ts
async route(input: string, threadId?: string): Promise<Message> {
  // === 第 1 层：提及解析 ===
  const { mentions, cleanContent } = this.mentionParser.parse(input);

  // === 第 2 层：目标解析 ===
  const targets = mentions.length > 0
    ? this.resolveTargets(mentions)  // @alice → agentId
    : [];                            // 空，触发回退

  // === 第 3 层：回退梯级 ===
  const finalTargets = targets.length > 0
    ? targets
    : [this.getFallbackTarget(threadId)];  // 默认 Agent 或上次回复者

  // === 第 4 层：分发调度 ===
  // Phase 3 简化：只取第一个目标
  const targetAgentId = finalTargets[0];

  // === 第 5 层：上下文组装 ===
  const thread = await this.threads.getOrCreate(threadId);
  await this.threads.addParticipant(thread.id, targetAgentId);

  const history = await this.storage.getMessages(thread.id);
  const contextMessages = this.contextWindow.truncate(history);

  // 存储用户消息
  await this.storage.addMessage({
    conversationId: thread.id,
    role: 'user',
    content: cleanContent,
    mentions: finalTargets,
  });

  // === 第 6 层：LLM 判断层（由 Agent 执行） ===
  const agent = this.createAgent(targetAgentId);
  const reply = await agent.reply(cleanContent, {
    threadId: thread.id,
    participants: thread.participants,
  });

  // 存储 Agent 回复
  await this.storage.addMessage({
    conversationId: thread.id,
    agentId: targetAgentId,
    role: 'assistant',
    content: reply,
  });

  return { ...reply, threadId: thread.id };
}
```

---

## 🗄️ 数据库设计

### Phase 2 → Phase 3 的迁移

**Phase 2 问题**：`conversations.agent_id` 假设一个会话只有一个 Agent。

**Phase 3 解决**：引入 `conversation_participants` 关系表。

### 新表结构

```sql
-- ============================================
-- 1. 会话表（简化，不再有 agent_id）
-- ============================================
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- ============================================
-- 2. 会话参与者关系表（新增）
-- ============================================
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  joined_at INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (conversation_id, agent_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- ============================================
-- 3. 消息表（扩展字段）
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  agent_id TEXT,                    -- 新增：哪个 Agent 回复的
  content TEXT NOT NULL,
  mentions TEXT,                    -- 新增：JSON 数组 ["alice","bob"]
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

### 索引优化

```sql
-- 查询会话的所有消息（按时间）
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);

-- 查询 Agent 的所有会话（通过参与者）
CREATE INDEX IF NOT EXISTS idx_participants_agent
  ON conversation_participants(agent_id);

-- 查询会话的参与者（快速判断）
CREATE INDEX IF NOT EXISTS idx_participants_conversation
  ON conversation_participants(conversation_id);
```

### 查询模式

| 查询 | 频率 | SQL 示例 |
|------|------|---------|
| 获取会话历史 | 每次对话 | `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC` |
| 获取会话参与者 | 每次对话 | `SELECT agent_id FROM conversation_participants WHERE conversation_id = ?` |
| Agent 的会话列表 | Phase 3+ | `SELECT c.id FROM conversations c JOIN participants p ON c.id = p.conversation_id WHERE p.agent_id = ?` |

---

## 📁 文件组织

```
src/phase-03-multi-agent/
├── cli.ts                      # 入口：解析参数，调用 Router
├── router/
│   ├── index.ts                # Router 主类（6 层流水线）
│   ├── mention-parser.ts      # 第 1 层：提及解析
│   ├── target-resolver.ts    # 第 2 层：目标解析
│   ├── fallback-resolver.ts  # 第 3 层：回退处理
│   ├── dispatcher.ts          # 第 4 层：分发调度
│   └── context-builder.ts    # 第 5 层：上下文组装
├── registry/
│   └── agent-registry.ts      # Agent 注册表
├── thread/
│   ├── manager.ts             # 会话管理器
│   └── thread.ts             # Thread 数据结构
├── agent/
│   └── agent.ts               # Agent 类（复用 Phase 2，扩展）
├── storage/
│   ├── schema.sql             # 新的数据库结构
│   └── sqlite.ts              # Storage 类（扩展方法）
└── context.ts                  # 上下文窗口（复用 Phase 2）
```

---

## 🔧 实现顺序

### Step 1：数据库迁移（1-2 小时）
- [ ] 更新 `schema.sql`
- [ ] 扩展 `Storage` 类方法
  - `getParticipants(threadId)`
  - `addParticipant(threadId, agentId)`
  - `getAgentThreads(agentId)`

### Step 2：AgentRegistry（1 小时）
- [ ] 实现 `AgentRegistry` 类
- [ ] 启动时扫描 `config/agents/`

### Step 3：MentionParser（1 小时）
- [ ] 实现正则解析
- [ ] 处理代码块边界情况

### Step 4：ThreadManager（1-2 小时）
- [ ] 实现 `ThreadManager` 类
- [ ] 管理会话生命周期

### Step 5：Router（2-3 小时）
- [ ] 实现 6 层流水线
- [ ] 集成所有组件

### Step 6：CLI（1 小时）
- [ ] 更新参数解析（支持 `--thread=`）
- [ ] 流式输出

### Step 7：测试与文档（1-2 小时）
- [ ] 验收标准测试
- [ ] 更新 README 进度
- [ ] 写 ADR-004

---

## 🚀 运行示例

```bash
# 启动（自动扫描 Agent）
pnpm phase3 --list
# 输出：
#   🍗 鸡腿 (ji-tui) - claude-opus-4-8
#   🎨 设计师 (alice) - claude-sonnet-5
#   💻 工程师 (bob) - claude-opus-4-8

# 与 alice 对话
pnpm phase3 "@alice 帮我设计登录页"
# 输出：
#   🎨: 登录页设计需要考虑...

# 会话隔离
pnpm phase3 --thread=t-1 "@alice 我们之前聊到哪了？"
pnpm phase3 --thread=t-2 "@bob 继续上次的工作"

# 回退行为
pnpm phase3 "你好"
# （使用默认 Agent 或上次回复者）
```

---

## 📚 相关文档

- [核心抽象：Router](../architecture/core-abstractions.md#抽象-3---router--orchestrator路由与编排)
- [核心抽象：Shared State](../architecture/core-abstractions.md#抽象-4--shared-state共享状态)
- [核心抽象：Message](../architecture/core-abstractions.md#抽象-2--message消息)
- [Phase 2 文档](./phase-02-agent-identity-memory.md)

---

## 🎯 下一步（Phase 4）

Phase 3 实现了"多 Agent 存在 + @mention 路由"。

**Phase 4 重点**：Agent 之间互相协作（A2A），alice 可以主动 `@bob` 请帮忙。

> 关键区别：
> - Phase 3：用户 `@alice` → alice 回复
> - Phase 4：用户 `@alice` → alice 回复时 `@bob` → bob 继续回复
