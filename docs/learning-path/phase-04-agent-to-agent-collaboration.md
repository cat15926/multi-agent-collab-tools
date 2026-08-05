# Phase 4 — Agent 间协作 A2A

> **这是"真正协作"的起点** —— Agent 不再只是回复用户，而是可以主动与其他 Agent 协作。
>
> **核心目标**：Agent 可以在回复中主动 @其他 Agent，实现任务传递和协作。
>
> **对应抽象**：② Message（Agent 作为发送者）、⑤ Pattern（A2A 雏形）

---

## 🎯 Phase 目标

| 功能 | Phase 3 状态 | Phase 4 目标 |
|------|-------------|-------------|
| 消息来源 | 只能是用户 | Agent 也可以发送消息 |
| @mention | 用户输入解析 | Agent 回复中的 @mention 解析 |
| 协作模式 | 单次回复 | 链式协作（A → B → C） |
| 球权流转 | 用户 → Agent | Agent → Agent |

---

## 📋 验收标准

完成本 Phase 后，以下场景应该都能跑通：

```bash
# 1. Agent 主动 @其他 Agent
pnpm phase4 "@alice 设计登录页"
# alice 回复后主动 @bob 审查
# bob 自动继续回复

# 2. 链式协作
pnpm phase4 "@alice 写代码"
# → alice @bob review
# → bob @carol 测试
# → carol 回复测试结果

# 3. 查看协作历史
pnpm phase4 --thread=xxx --history
# 显示完整的 A→B→C 协作链

# 4. 禁用 A2A（可选）
pnpm phase4 "@alice 设计登录页" --no-a2a
# alice 回复，不触发后续协作
```

---

## 🏗️ 架构设计

### 核心概念：A2A (Agent-to-Agent)

**定义**：Agent 作为消息的发送者，主动发起与其他 Agent 的协作。

**关键区别**：
- Phase 3：`Message{from: "user", to: "@alice"}` → alice 回复
- Phase 4：`Message{from: "alice", to: "@bob"}` → bob 回复

### 球权流转

**球权**：谁有资格/义务回应当前消息。

```
用户发言 → 球权在被 @ 的 Agent
Agent 发言 → 球权在接收方
无明确 @ 时 → 球权在上一轮发言者
```

**Phase 4 的球权流转**：
1. 用户 `@alice` → 球权在 alice
2. alice 回复，内容包含 `@bob` → 球权转移到 bob
3. bob 回复（可能再 @其他人）→ 球权继续流转

### 协作流程图

```
┌─────────────────────────────────────────────────────────┐
│                      CLI / 用户                           │
│   $ pnpm phase4 "@alice 设计登录页"                       │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                    Router (Phase 3)                       │
│   • 解析 @alice                                            │
│   • 唤醒 alice                                             │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                   Agent alice                              │
│   生成回复："这是设计稿..."                                │
│   主动 @bob："请 @bob 审查一下"                            │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│            A2A 处理器 (Phase 4 新增)                      │
│   • 检测 alice 回复中的 @mention                           │
│   • 提取目标：@bob                                          │
│   • 判断是否需要继续协作                                     │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                   协作决策                                  │
│   • 自动模式：直接继续唤醒 bob                               │
│   • 确认模式：询问用户是否继续                               │
│   • 禁用模式：停止协作                                       │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                   Agent bob                              │
│   接收上下文（用户原问题 + alice 的设计）                    │
│   生成审查回复                                             │
└─────────────────────────────────────────────────────────┘
```

---

## 🔧 核心组件

### 1. A2A Parser（Agent 间提及解析器）

**职责**：从 Agent 回复中提取 @mention。

```ts
class A2AParser {
  /**
   * 从 Agent 回复中提取 @mention
   * 与 MentionParser 不同的是：
   * - 不限制行首（Agent 可以在文中 @）
   * - 需要过滤掉代码块中的 @
   */
  parseFromAgentReply(reply: string): string[];

  /**
   * 判断 Agent 回复是否触发 A2A
   * 规则：
   * - 包含有效的 @mention
   * - 不是在解释代码
   * - 不是在举例
   */
  shouldTriggerA2A(reply: string, mentions: string[]): boolean;
}
```

**实现要点**：
- 正则：`/@(\w+)(?=\s|$)/g`（不限行首）
- 需要跳过代码块：```` ```code``` ```` 中的 @ 不算
- 排除模式：`"像 @alice 这样"` 不算 A2A

### 2. A2A Handler（A2A 处理器）

**职责**：处理 Agent 间的协作流转。

```ts
interface A2AConfig {
  /** 协作模式 */
  mode: "auto" | "confirm" | "disabled";
  /** 最大协作深度（防止无限循环） */
  maxDepth: number;
  /** 协作超时（秒） */
  timeout: number;
}

class A2AHandler {
  constructor(
    private registry: AgentRegistry,
    private threads: ThreadManager,
    private storage: Storage,
    private config: A2AConfig
  ) {}

  /**
   * 处理 A2A 协作
   * @param sourceAgentId 发起协作的 Agent
   * @param targetAgentIds 目标 Agent 列表
   * @param threadId 会话 ID
   * @param context 当前会话上下文
   */
  async handleA2A(
    sourceAgentId: string,
    targetAgentIds: string[],
    threadId: string,
    context: A2AContext
  ): Promise<A2AResult>;
}
```

### 3. 协作决策器

**职责**：决定是否继续协作。

```ts
enum A2ADecision {
  CONTINUE,  // 继续协作，自动唤醒下一个 Agent
  CONFIRM,   // 询问用户是否继续
  STOP,      // 停止协作
}

class A2ADecider {
  decide(params: {
    mentions: string[];
    depth: number;
    replyContent: string;
    config: A2AConfig;
  }): A2ADecision;
}
```

---

## 🗄️ 数据库扩展

### Phase 3 → Phase 4 的变化

**新增字段**：`messages` 表增加 `a2a_source` 字段，记录消息来源。

```sql
-- 扩展 messages 表
ALTER TABLE messages ADD COLUMN a2a_source TEXT;
-- a2a_source: 如果这条消息是由 Agent 触发的，记录触发 Agent 的 ID
-- 例如：bob 的回复，a2a_source = "alice"（表示 alice @bob）

-- 新增协作链表（可选，用于追踪协作路径）
CREATE TABLE IF NOT EXISTS a2a_chains (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (thread_id) REFERENCES conversations(id),
  FOREIGN KEY (source_agent_id) REFERENCES agents(id),
  FOREIGN KEY (target_agent_id) REFERENCES agents(id),
  FOREIGN KEY (trigger_message_id) REFERENCES messages(id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_a2a_chains_thread
  ON a2a_chains(thread_id, created_at);
```

### Message 结构扩展

```ts
interface Message {
  // ... 现有字段
  a2aSource?: string;  // 新增：触发此消息的 Agent ID
}
```

---

## 📁 文件组织

```
src/phase-04-agent-to-agent/
├── cli.ts                          # 入口：支持 --no-a2a, --a2a-mode
├── a2a/
│   ├── index.ts                    # A2A 主处理器
│   ├── parser.ts                   # A2AParser（从 Agent 回复提取 @）
│   ├── decider.ts                  # A2ADecider（协作决策）
│   └── handler.ts                  # A2AHandler（协作执行）
├── router/
│   └── index.ts                    # Router（复用 Phase 3，扩展 A2A）
├── registry/
│   └── agent-registry.ts           # AgentRegistry（复用 Phase 3）
├── thread/
│   └── manager.ts                  # ThreadManager（复用 Phase 3）
├── agent/
│   └── agent.ts                     # Agent（复用 Phase 3）
└── storage/
    ├── schema.sql                   # 扩展的数据库结构
    └── sqlite.ts                    # Storage（扩展 a2a 相关方法）
```

---

## 🔧 实现顺序

### Step 1：数据库扩展（30 分钟）
- [ ] 更新 `schema.sql`（a2a_source, a2a_chains 表）
- [ ] 扩展 `Storage` 类方法
  - `addA2AChain()`
  - `getA2AChains(threadId)`
  - `updateA2ASource(messageId, sourceAgentId)`

### Step 2：A2A Parser（1 小时）
- [ ] 实现 `A2AParser` 类
- [ ] 从 Agent 回复提取 @mention
- [ ] 过滤代码块和举例

### Step 3：A2A Decider（30 分钟）
- [ ] 实现 `A2ADecider` 类
- [ ] 决策逻辑（depth check, content analysis）

### Step 4：A2A Handler（2 小时）
- [ ] 实现 `A2AHandler` 类
- [ ] 协作执行逻辑
- [ ] 深度限制和超时

### Step 5：Router 扩展（1 小时）
- [ ] 集成 A2A 到 Router
- [ ] 协作后继续处理

### Step 6：CLI 扩展（30 分钟）
- [ ] 添加 `--no-a2a` 选项
- [ ] 添加 `--a2a-mode` 选项
- [ ] 显示协作链

### Step 7：测试与文档（1 小时）
- [ ] 验收标准测试
- [ ] 更新 README 进度
- [ ] 写 ADR-005

---

## 🎯 验收场景

### 场景 1：基本 A2A

```bash
$ pnpm phase4 "@alice 设计登录页"

🍗 鸡腿:
好的！这是登录页设计方案：
[...]

请 @bob 帮我审查一下这个设计。

(协作：鸡腿 → Bob)

👨‍💻 工程师 Bob:
收到。我来审查鸡腿的设计：

1. 布局合理...
2. 颜色搭配...
3. [...]

审查完成，可以直接开发。
```

### 场景 2：链式协作

```bash
$ pnpm phase4 "@alice 写个登录函数"

🍗 鸡腿:
这是登录函数：
```javascript
function login(user, pass) { ... }
```

请 @bob 审查代码，然后 @carol 写测试。

(协作：鸡腿 → Bob)

👨‍💻 工程师 Bob:
代码审查：
- 安全性问题...
- 错误处理...

@carol 请基于这个函数写测试。

(协作：Bob → Carol)

🎨 设计师 Carol:
好的，这是测试用例：
```javascript
test('login success', () => { ... })
```
```

### 场景 3：协作历史查询

```bash
$ pnpm phase4 --thread=xxx --chain

协作链：
1. 用户 → @alice (设计登录页)
2. alice → @bob (请审查)
3. bob → (完成审查)
```

---

## 📚 相关文档

- [核心抽象：Ball Ownership](../architecture/core-abstractions.md#核心概念球权ball-ownership)
- [核心抽象：Pattern](../architecture/core-abstractions.md#抽象-5--collaboration-pattern协作模式)
- [Phase 3 文档](./phase-03-multi-agent-routing.md)
- [Phase 5 文档](./phase-05-collaboration-patterns.md)（下一步：完整 Pattern）

---

## 🎯 下一步（Phase 5）

Phase 4 实现了"Agent 可以主动 @其他 Agent"。

**Phase 5 重点**：把协作模式抽象化，支持：
- 顺序流水线（A→B→C）
- 并行多视角（A,B,C → 汇总）
- 辩论（A↔B）
- 层级分工（Manager → Workers）

> 关键区别：
> - Phase 4：A2A 是"自然发生"的（Agent 自发 @）
> - Phase 5：Pattern 是"结构化"的（定义协作拓扑）
