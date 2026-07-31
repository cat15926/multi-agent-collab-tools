/**
 * Phase 2 — Agent 配置文件加载器
 *
 * 职责：
 * - 从 config/agents/*.json 加载 Agent 配置
 * - 提供配置文件的发现和验证
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 从 src/phase-02-agent-identity 向上两级到项目根，然后进入 config/agents
const CONFIG_DIR = join(__dirname, "../../config/agents");

/** Agent 配置结构 */
export interface AgentConfig {
  /** Agent 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 表情符号（用于 CLI 显示） */
  emoji: string;
  /** 使用的模型 */
  model: string;
  /** 人格描述（system prompt） */
  persona: string;
  /** 可选的额外特征 */
  traits?: Record<string, unknown>;
}

/** 配置加载错误 */
export class ConfigError extends Error {
  constructor(message: string, public file?: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 验证配置文件格式 */
function validateConfig(config: unknown, file: string): AgentConfig {
  if (typeof config !== "object" || config === null) {
    throw new ConfigError(`配置必须是一个对象`, file);
  }

  const c = config as Record<string, unknown>;

  if (typeof c.id !== "string" || !c.id) {
    throw new ConfigError(`缺少必需字段: id (string)`, file);
  }

  if (typeof c.name !== "string" || !c.name) {
    throw new ConfigError(`缺少必需字段: name (string)`, file);
  }

  if (typeof c.emoji !== "string") {
    throw new ConfigError(`缺少必需字段: emoji (string)`, file);
  }

  if (typeof c.model !== "string" || !c.model) {
    throw new ConfigError(`缺少必需字段: model (string)`, file);
  }

  if (typeof c.persona !== "string" || !c.persona) {
    throw new ConfigError(`缺少必需字段: persona (string)`, file);
  }

  return {
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    model: c.model,
    persona: c.persona,
    traits: c.traits && typeof c.traits === "object" ? (c.traits as Record<string, unknown>) : undefined,
  };
}

/** 从文件加载单个 Agent 配置 */
export function loadAgentConfig(id: string): AgentConfig {
  const filePath = join(CONFIG_DIR, `${id}.json`);

  if (!existsSync(filePath)) {
    throw new ConfigError(`Agent 配置文件不存在: ${id}.json`, filePath);
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const config = JSON.parse(content);
    return validateConfig(config, filePath);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw err;
    }
    if (err instanceof SyntaxError) {
      throw new ConfigError(`JSON 格式错误: ${err.message}`, filePath);
    }
    throw new ConfigError(`读取失败: ${err}`, filePath);
  }
}

/** 列出所有可用的 Agent ID */
export function listAgentIds(): string[] {
  if (!existsSync(CONFIG_DIR)) {
    return [];
  }

  const files = readdirSync(CONFIG_DIR);
  return files
    .filter((f) => f.endsWith(".json") && f !== "template.json")
    .map((f) => f.replace(".json", ""));
}

/** 获取所有 Agent 配置 */
export function loadAllAgentConfigs(): AgentConfig[] {
  const ids = listAgentIds();
  const configs: AgentConfig[] = [];

  for (const id of ids) {
    try {
      configs.push(loadAgentConfig(id));
    } catch (err) {
      console.warn(`警告: 跳过无效配置 ${id}: ${err}`);
    }
  }

  return configs;
}
