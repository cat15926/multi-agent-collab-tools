/**
 * Phase 6 — Tool 接口定义
 *
 * 一个工具 = 给 LLM 看的 schema + 给运行时执行的 handler。
 * 工具是 Agent 的"手"——让 Agent 能操作真实环境（读文件、跑命令等）。
 *
 * 对应「核心心智模型」抽象 ① Agent 的 tools 字段（Phase 6 才有）。
 */

/** 工具的输入 schema（JSON Schema 格式，直接喂给 Anthropic API 的 input_schema） */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  // index signature：满足 Anthropic SDK InputSchema 的类型要求（JSON Schema 允许额外字段）
  [key: string]: unknown;
}

/** 工具执行结果 */
export interface ToolResult {
  /** 文本结果，喂回 LLM 的 tool_result.content */
  content: string;
  /** true = 工具执行失败（LLM 会据此重试或改方案）；省略/false = 成功 */
  isError?: boolean;
}

/**
 * 工具执行上下文（Phase 7 新增）
 * kb_write 等需要归属标注的工具用它拿 agentId/threadId；现有工具忽略。
 */
export interface ToolContext {
  agentId: string;
  threadId: string;
}

/** 工具接口 */
export interface Tool {
  /** 工具名（LLM 用它调用，必须唯一；推荐 snake_case） */
  name: string;
  /** 描述（LLM 据此判断"该不该用这个工具"——写清楚 = LLM 调得准） */
  description: string;
  /** 输入 schema（JSON Schema，直接传给 Anthropic API） */
  inputSchema: ToolInputSchema;
  /** 执行函数：LLM 传来的参数 → 真实环境操作 → 文本结果（可选执行上下文） */
  execute(input: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}

/** 便捷：构造成功的 ToolResult */
export function ok(content: string): ToolResult {
  return { content };
}

/** 便捷：构造失败的 ToolResult */
export function err(content: string): ToolResult {
  return { content, isError: true };
}
