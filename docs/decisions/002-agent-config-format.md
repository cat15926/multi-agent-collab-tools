---
decision_id: ADR-002
date: 2025-07-31
status: accepted
phase: 2
---

# ADR-002: Agent 配置文件格式设计

## Context

Phase 2 需要让 Agent 的身份从硬编码转变为可配置。需要选择一种配置文件格式，并定义字段结构。

## Decision

### 文件格式：选择 JSON

**选择**：使用 JSON 作为配置文件格式。

**原因**：
1. **原生支持**：Node.js 内置 `JSON.parse`，无需额外依赖
2. **类型安全**：与 TypeScript 类型系统天然契合
3. **注释方案**：通过 `_comment` 字段支持（见示例），避免依赖非标准 JSON-with-comments
4. **IDE 友好**：所有编辑器原生支持 JSON，语法高亮和校验开箱即用

**未选方案**：
- **YAML**：更简洁，但需要额外依赖（`js-yaml`），缩进错误不易调试
- **TOML**：语法不错，但生态较小，TypeScript 支持不如 JSON
- **ENV**：不适合结构化数据

### 字段设计

```json
{
  "id": "ji-tui",           // 必需，文件名也用这个
  "name": "鸡腿",            // 必需，显示名称
  "emoji": "🍗",             // 必需，CLI 显示
  "model": "claude-opus-4-8", // 必需，LLM 模型
  "persona": "...",          // 必需，system prompt
  "traits": {...}            // 可选，扩展字段
}
```

**设计原则**：
1. **必需字段最小化**：只保留运行时必需的 5 个字段
2. **扩展性**：`traits` 字段为未来留空间（Phase 5+ 可能用到）
3. **一致性**：`id` 与文件名一致，避免混淆
4. **可读性**：`persona` 支持多行字符串（`\n` 换行）

**字段说明**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | Agent 唯一标识，用于 `--agent=` 参数和文件命名 |
| `name` | string | ✅ | 人类可读名称，用于列表显示 |
| `emoji` | string | ✅ | 单个 emoji，用于 CLI 输出，增加辨识度 |
| `model` | string | ✅ | Anthropic 模型 ID，如 `claude-opus-4-8` |
| `persona` | string | ✅ | System prompt，定义 Agent 人格，支持 `\n` 换行 |
| `traits` | object | ⬜ | 扩展字段，未来用于性格特征、能力标签等 |

### 文件组织

```
config/agents/
├── ji-tui.json          # 实际 Agent
├── template.json         # 新 Agent 模板
└── (future agents).json
```

**规则**：
- 文件名必须与 `id` 字段一致
- `template.json` 被列表命令忽略，避免误加载
- 每个文件 = 一个 Agent，便于版本管理

## Consequences

### 正面
- **零学习成本**：JSON 是通用格式，开发者无需学习新语法
- **类型安全**：TypeScript 接口直接对应 JSON 结构，编译时校验
- **易于扩展**：新增字段只需在接口和 JSON 中同步添加

### 负面
- **无原生注释**：标准 JSON 不支持注释，通过 `_comment` 字段变通
- **冗长**：相比 YAML/TOML，JSON 的引号和逗号略显啰嗦

### 风险
- **配置漂移**：开发者可能直接修改数据库而不更新 JSON 文件
  - **缓解**：Phase 2 启动时自动从 JSON 同步到数据库，JSON 是真相源

## Related

- [Phase 2 文档](../learning-path/phase-02-agent-identity-memory.md)
- [ADR-003: SQLite Schema](./003-sqlite-schema.md)
