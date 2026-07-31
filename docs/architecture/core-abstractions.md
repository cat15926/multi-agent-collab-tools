# 核心心智模型：多 Agent 系统的 5 大抽象

> 本文是整个项目的**知识地基**，跨所有 Phase 复用。
> 把这 5 个抽象吃透，后面所有框架、论文、产品都能一眼看穿骨架。
>
> 关联：[Phase 0 阶段文档](../learning-path/phase-00-foundation.md)

整个领域看起来眼花缭乱，但剥到底只有 **5 个抽象**。每个 Phase 做的事，本质上都是"把其中某一个抽象，从概念变成可跑的代码"。

---

## 前置认知：三层原则

在理解 5 大抽象之前，先建立正确的**层次心智模型**。多 Agent 系统不是平面的，而是分三层的：

| 层次 | 职责 | 不负责 | 乘数效应 |
|------|------|--------|---------|
| **Model（模型层）** | 推理、生成、理解 | 长期记忆、协作纪律 | 设定**上限** |
| **Agent CLI（代理层）** | 工具调用、文件操作、命令执行 | 团队协调、跨模型审查 | 执行能力 |
| **Platform（平台层）** | 身份管理、协作编排、审计追踪、记忆持久化 | 具体推理（这是模型的事） | 设定**下限** |

**关键洞察**：每一层都是**乘数**，而非加法。模型设定天花板，平台设定地板。平台层做得好，能让中等模型发挥出接近高级模型的效果。

**误解警示**：⚠️ 不要把平台的职责（记忆、协作、纪律）塞给模型层，也不要让平台去抢模型的推理工作。各司其职，系统才会优雅。

---

## 抽象 1 ｜ Agent（智能体）

**定义**：`Agent = 持久身份(人格) + 大脑(LLM) + 记忆 + (可选)工具 + (可选)技能`

**为什么需要它**：LLM 本身是**无状态、无立场**的——你问它同一个问题，它不记得上一句，也没有固定性格。Agent 的作用，就是把"我是谁"（persona）和"我记得什么"（memory）**固定**下来，让一次孤立的 LLM 调用，变成"一个持续存在的人格在回应你"。

**最小代码骨架**：
```ts
interface Agent {
  id: string;
  persona: string;            // 身份：system prompt
  model: string;              // 大脑：用哪个 LLM
  history: Message[];         // 短期记忆：对话历史
  longTermMemory?: Evidence[]; // 长期记忆：Phase 7
  tools?: Tool[];             // 手：Phase 6 才有
  skills?: Skill[];           // 按需技能：Phase 5+
  reply(input: string): AsyncIterable<string>;  // 流式输出
}
```

**核心属性 — 持久身份**：
Agent 最重要的特征是**身份持久性**——它在会话之间保持相同的角色、性格和记忆，即使上下文被压缩。这不是简单的"保存聊天记录"，而是：
- 人格档案（persona）在会话间保持稳定
- 记忆在上下文压缩后不丢失
- Agent 知道"我是谁"，而不是每次都需要被告知

**演进路径**：固定文本人格 → 动态人格（根据记忆自我调整）→ 人格档案（连声音/语气/口头禅都定义）。

**最大的误解**：⚠️ **Agent ≠ LLM**。LLM 是"大脑"，Agent 是"整个人"。**同一个 LLM 可以是 N 个完全不同的 Agent**——区别只在 persona 和 memory。理解这点，就懂了为什么一个 Claude 能撑起多个性格迥异的 Agent。

> 引入于 **Phase 1**，深化于 **Phase 2**。

---

## 抽象 2 ｜ Message（消息）

**定义**：Agent 之间流转的**结构化信息单元**。不是"一段文字"，而是带完整元数据的协议包。

**最小代码骨架**：
```ts
interface Message {
  id: string;
  from: string;               // 发送者：agent id 或 "user"
  to: string | string[];      // 接收者：可路由到单个或广播
  content: string;
  type?: 'text' | 'task' | 'result' | 'review' | 'handoff';
  threadId: string;           // 归属哪个会话（Thread 隔离）
  timestamp: number;
  metadata?: {
    mentions?: string[];       // @mention 目标列表
    inReplyTo?: string;       // 回复哪条消息
    attachments?: Attachment[];
  };
}
```

**为什么需要它**：多 Agent 系统**靠消息驱动**。没有 Message 结构，你就没法路由（不知道发给谁）、没法记录（没法回放）、没法让 A 知道"B 说了什么"。**Message 是这个系统的"血液"，一切流动的都是它。**

**关键洞察**：把 Message 设计好，后面省一半力气——路由、协作、回放、计费全都建在这个数据结构上。**早期多花 1 小时把字段想清楚，比后期返工强 10 倍。**

**最大的误解**：⚠️ **Message ≠ 用户输入的文本**。用户输入只是 `Message{from:"user"}` 的一种特例；Agent A 让 Agent B 帮忙，发的也是 Message。一旦把"用户说话"和"Agent 说话"统一成 Message，整个系统就优雅了。

> 引入于 **Phase 1**（隐式），显式结构化于 **Phase 3**。

---

## 抽象 3 ｜ Router / Orchestrator（路由与编排）

**定义**：决定一条 Message **该由谁处理、按什么顺序、结果怎么传递**的中枢。

**为什么需要它**：有了多个 Agent 和 Message，必须有东西来**分发**，否则消息发出没人接，或全挤在一起乱套。

### 分层设计：6 层路由流水线

这是本抽象最核心的设计洞察——**路由分两层，机械层 + 判断层**：

```
用户发送包含 @handle 的消息
           │
           ▼
 ┌──────────────────────────┐
 │  1. 提及解析              │  机械层：从文本提取 @handle
 │     (机械层)              │  去除代码块、校验 token 边界
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  2. 目标解析              │  机械层：@handle → agentId
 │     (机械层)              │  检查可用性、推荐替代
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  3. 回退梯级              │  机械层：无显式 @ 时的默认行为
 │     (机械层)              │  上次回复者 → 偏好 Agent → 默认 Agent
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  4. 分发调度              │  机械层：唤醒目标，串行或并行
 │     (机械层)              │  护栏：深度限制、去重、乒乓检测
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  5. 上下文组装            │  机械层：构建对话历史 + 身份 + 队友表
 │     (机械层)              │  预算：约 20 条消息、约 2000 token
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  6. LLM 判断层            │  判断层：Agent 读上下文后三选一
 │     (判断层)              │  接受 / 拒绝 / 升级（"误 @ 检测"）
 └──────────────────────────┘
```

**第 1-5 层是代码**——确定性的、可测试的、不涉及 LLM。
**第 6 层是 Agent 本身**——非确定性的、感知上下文的、有判断力的。

**核心设计洞察**：**系统不试图猜测用户意图；它机械地路由，让接收方 Agent 自己决定接不接。** 这把复杂性从平台层推到了 Agent 层，让系统更简单、更可预测。

### Router vs Orchestrator 的本质区别

| 层次 | 角色 | 比喻 | 时机 | 对应 Phase |
|------|------|------|------|-----------|
| **Router（路由）** | 一条消息 → 谁来接（即时分发） | 派信员 | 每条消息即时 | Phase 3 |
| **Orchestrator（编排）** | 一个任务 → 多 Agent 按**什么模式**协作（流程） | 导演 | 任务级别的流程设计 | Phase 5 |

**Router 的设计原则**：
- **行首触发**：只有行首的 `@handle` 才触发路由
- **机械判断**：不尝试理解"语义"，只看结构
- **护栏机制**：深度限制、去重、乒乓检测

> 引入于 **Phase 3**（Router），**Phase 5**（Orchestrator）。

---

## 抽象 4 ｜ Shared State（共享状态）

**定义**：让多个 Agent 基于**共同上下文**协作的状态存储。分两层：

| 层 | 是什么 | 时间跨度 | 边界 | 例子 |
|----|--------|---------|------|------|
| **短期** | Thread（会话上下文） | 一次对话 | Thread 隔离 | "我们刚才聊到哪了" |
| **长期** | KnowledgeBase（证据/决策/经验） | 永久 | 跨 Thread 共享 | "上次踩过的坑" |

**为什么需要它**：没有它，每个 Agent 都是**失忆的孤岛**——A 不知道 B 做了什么，协作无从谈起。

### Thread Isolation（线程隔离）

**核心原则**：**共享状态的边界 = 协作的边界**。

同一个 Thread 内的 Agent 共享上下文（所以能即时协作）；跨 Thread 的协作，只能靠长期记忆（KnowledgeBase）。

Thread 隔离的好处：
- 鉴权重构不会污染落地页 Thread
- 每个功能/bug 有自己独立的工作空间
- 上下文干净，不会互相干扰

**最小代码骨架**：
```ts
interface Thread {              // 短期共享上下文
  id: string;
  messages: Message[];          // 这个会话里所有 Agent 都能看到
  participants: string[];       // 参与 Agent 列表
  metadata?: {
    topic?: string;
    status: 'active' | 'archived';
  };
}

interface KnowledgeBase {       // 长期共享记忆（Phase 7）
  add(entry: Evidence): void;
  search(query: string): Evidence[];
  getThreadContext(threadId: string): Evidence[];
}

interface Evidence {
  id: string;
  type: 'decision' | 'lesson' | 'observation' | 'outcome';
  content: string;
  sourceThread?: string;       // 来自哪个 Thread
  timestamp: number;
  verified?: boolean;          // 是否被验证
}
```

> 引入于 **Phase 2**（单 Agent 记忆），短期共享于 **Phase 3**（Thread），长期于 **Phase 7**（KnowledgeBase）。

---

## 抽象 5 ｜ Collaboration Pattern（协作模式）

**定义**：Agent 组织起来完成任务的**拓扑结构**。**这是整个系统的"性格"。**

**为什么它最重要**：同样一群 Agent，组织方式不同，效果天差地别。"3 个 Agent 顺序做" vs "3 个 Agent 辩论"——是两个完全不同的系统。**Pattern 是多 Agent 系统区别于"多次调 API"的本质。**

### 核心概念：球权（Ball Ownership）

在多 Agent 协作中，"球权"指**谁有资格/义务回应当前消息**。

**球权流转规则**：
- 用户发言 → 球权在被 @ 的 Agent
- Agent 发言 → 球权在接收方
- 无明确 @ 时 → 球权在上一轮发言者
- 并行模式 → 球权分裂（多个 Agent 同时持有）

理解球权，就理解了 A2A（Agent-to-Agent）协作的核心机制。

### 四种基础模式（Phase 5 会亲手实现）

| 模式 | 拓扑 | 球权流转 | 典型场景 |
|------|------|---------|---------|
| **顺序流水线** | A→B→C（前一个输出 = 后一个输入） | 线性传递 | 写代码 → 审查 → 测试 |
| **并行多视角** | A,B,C 同看一题 → 汇总（map-reduce） | 一分多聚 | 3 个 Agent 各出方案，取最优 |
| **辩论** | A↔B 多轮对抗 → 收敛 | 往返传递 | 方案 A vs 方案 B 互驳 |
| **层级分工** | Manager 拆任务 → Workers → 汇总 | 中心化分发 | 架构师拆需求给开发 Agent |

**关键洞察**：好的设计让 Pattern **可插拔**——同一个任务能切换不同模式跑、对比效果。这正是 Phase 5 的验收标准。

**最小代码骨架**：
```ts
interface Pattern {
  name: string;
  execute(task: Task, agents: Agent[]): Promise<Result>;
}

// 顺序流水线示例
class PipelinePattern implements Pattern {
  async execute(task: Task, agents: Agent[]): Promise<Result> {
    let result = task;
    for (const agent of agents) {
      result = await agent.process(result);
    }
    return result;
  }
}
```

> 雏形于 **Phase 4**（A2A handoff），正式抽象于 **Phase 5**。

---

## 架构图：5 个抽象怎么串起来

```
                          ┌───────────────┐
                          │   用户 (CVO)   │
                          └───────┬───────┘
                                  │ Message { from:user, to:@alice }
                                  ▼
           ┌─────────────────────────────────────────────┐
           │   ③ Router（6层流水线）                        │
           │   1.提及解析→2.目标解析→3.回退→4.分发→5.组装→6.LLM判断  │
           └────────────────────┬────────────────────────┘
                                ▼
          ┌──────────────────────────────────────────────────────┐
          │   ④ Thread（会话 = 短期共享状态）                        │
          │   messages: [ m1(user→@alice), m2(alice→@bob), ... ] │
          │                                                        │
          │     ┌─────────┐    ┌─────────┐    ┌─────────┐         │
          │     │ Agent A │◄──►│ Agent B │◄──►│ Agent C │  ◄── ① Agent
          │     │ persona │    │ persona │    │ persona │    互相发消息
          │     │ +LLM    │    │ +LLM    │    │ +LLM    │  (A2A协作/球权流转)
          │     │ +技能   │    │ +技能   │    │ +技能   │         │
          │     └─────────┘    └─────────┘    └─────────┘         │
          │                          ▲                            │
          │            ⑤ Pattern 编排它们"怎么"协作                 │
          │            （顺序? 并行? 辩论? 层级? 球权如何流转?）       │
          └────────────┬─────────────────────┬────────────────────┘
                       ▼                             ▼
              ┌────────────────┐              ┌────────────────┐
              │ ④ KnowledgeBase │              │   Tools        │
              │  (长期共享记忆)  │              │  (文件/命令)    │
              │  决策/经验/证据  │              │  ① Agent 的"手" │
              └────────────────┘              └────────────────┘
```

### 一次请求的完整旅程

1. 用户发 `Message{from:user, to:@alice, content:"帮我设计登录页"}`
2. **Router** 的 6 层流水线处理：
   - 提及解析：识别 `@alice`
   - 目标解析：查 Registry 找到 alice 的配置
   - 上下文组装：构建 Thread 历史 + alice 的身份 + 队友列表
3. alice（**Agent**）被唤醒，通过**第 6 层（LLM 判断层）**决定是否接这个球
4. alice 接球后，生成回复，觉得需要 bob 审查 → 发 `Message{from:alice, to:@bob}`（这是 **A2A**，球权转移）
5. **Pattern**（Phase 5）决定：
   - 流水线模式：alice 直接转给 bob
   - 并行模式：alice+bob+carol 各出方案再汇总
6. 过程中产生的决策/经验写进 **KnowledgeBase**（长期 Shared State，Phase 7）；如需读文件，Agent 调 **Tools**（Phase 6）
7. 最终结果作为 Message 回到用户

---

## 5 抽象 → Phase 映射

每个 Phase 都只是"把某个抽象从概念变成代码"。没有黑魔法。

| 抽象 | 首次引入 | 深化阶段 |
|------|---------|---------|
| ① Agent | P1（基础人格） | P2（持久身份+记忆） |
| ② Message | P1（隐式文本） | P3（显式结构化） |
| ③ Router / Orchestrator | P3（Router 6层流水线） | P5（Orchestrator Pattern） |
| ④ Shared State | P2（单 Agent 记忆） | P3（Thread 隔离）→ P7（长期 KnowledgeBase） |
| ⑤ Pattern | P4（A2A handoff 雏形） | P5（正式 Pattern 抽象） |

---

## 设计哲学：Hard Rails + Soft Power

多 Agent 系统不是靠"控制"来工作的，而是靠"文化"。

| 概念 | 含义 |
|------|------|
| **Hard Rails（硬护栏）** | 非协商的安全底线——不能删数据库、不能杀父进程、不能修改运行时配置 |
| **Soft Power（软权力）** | 护栏之上的自我协调、自我审查、自我改进 |

这不是"防止 Agent 搞砸"，而是"帮助 Agent 像真正的团队一样工作"。

**核心原则**：
- **P1：面向终态** — 每一步都是地基，不是脚手架
- **P2：协作者而非木偶** — 硬约束是地板，以上释放自主性
- **P3：方向 > 速度** — 不确定时：停 → 搜 → 问 → 确认 → 执行
- **P4：单一真相源** — 每个概念只在一个地方定义
- **P5：验证 = 完成** — 证据说话，不是自信说话
