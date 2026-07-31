# Phase 0 — 地基与心智地图

> 状态：🔄 进行中
> 关联知识：[5 大核心抽象（必读）](../architecture/core-abstractions.md)

## 目标

不写代码，**先在脑子里装一张坐标系**。吃透多 Agent 系统的 5 大核心抽象：
**Agent / Message / Router / Shared State / Collaboration Pattern**。

## 学什么

- 读 [5 大核心抽象](../architecture/core-abstractions.md)，理解每个抽象的：定义、为什么需要、最小代码骨架、演进路径、常见陷阱。
- （实物参照）读 Clowder 的 `README.md` + `docs/architecture/2026-05-05-architecture-views.md`，对照看这 5 个抽象在工业级实现里长什么样。

## 产出（Phase 0 唯一的"作业"）

必须**自己动手**做这两件事（不要抄文档里的）：

1. **自己画一张架构图**——默画，不看参考，标出 5 个抽象 + 一次请求的数据流。
   画不出来的地方，就是还没懂的地方。
2. **用自己的话写 5 个抽象的定义**——每个不超过两句话，像解释给完全不懂的人听。

## 验收标准

- 能向别人讲清楚"一条消息从用户发出 → 多个 Agent 协作完成 → 返回结果"的完整旅程。
- 上述两张图/定义已完成并可复查。

## 为什么这一步不能跳

没有这张地图，后面每个 Phase 都会迷路——不知道自己在搭什么、为什么这么搭。
Clowder 团队也是先在 `docs/architecture/` 画图、在 `docs/decisions/` 写决策，才开始写代码的。

## 完成后

把你的架构图和定义贴给 Claude（或自检），确认无误后 → 进入 [Phase 1](./phase-01-single-agent.md)（待创建）。
