/**
 * Phase 3 — Agent 注册表
 *
 * 职责：
 * - 集中管理所有可用 Agent 的配置
 * - 启动时扫描 config/agents/*.json
 * - 提供 @handle → agentId 解析
 * - 管理默认 Agent
 */

import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Agent 配置目录：从项目根目录的 config/agents/ 扫描
const AGENTS_CONFIG_DIR = join(__dirname, "../../../config/agents");

/** Agent 配置结构 */
export interface AgentConfig {
  id: string;
  name: string;
  emoji: string;
  model: string;
  persona: string;
  traits?: Record<string, unknown>;
  /** 可用工具白名单（Phase 6）；省略 = 该 Agent 可用全部已注册工具 */
  tools?: string[];
  /**
   * 推理运行时（Phase 9）：anthropic = 裸 API + 自研 tool loop；
   * claude-code = Claude Code 完整 agentic loop。省略 = anthropic（旧配置零影响）。
   */
  runtime?: AgentRuntime;
}

/** Agent 推理运行时类型 */
export type AgentRuntime = "anthropic" | "claude-code";

/** 加载配置错误 */
export class RegistryError extends Error {
  constructor(message: string) {
    super(`[Registry] ${message}`);
    this.name = "RegistryError";
  }
}

export class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map();
  private defaultAgentId?: string;

  constructor() {
    this.loadAgentsFromConfig();
    this.validateDefaultAgent();
  }

  /** 从 config/agents/ 目录加载所有 Agent 配置 */
  private loadAgentsFromConfig(): void {
    try {
      const files = readdirSync(AGENTS_CONFIG_DIR);
      const jsonFiles = files.filter((f) => f.endsWith(".json") && f !== "template.json");

      for (const file of jsonFiles) {
        try {
          const filePath = join(AGENTS_CONFIG_DIR, file);
          const content = readFileSync(filePath, "utf-8");
          const config = JSON.parse(content) as AgentConfig;

          // 验证必需字段
          this.validateConfig(config);

          // 验证文件名与 id 一致
          const expectedId = file.replace(".json", "");
          if (config.id !== expectedId) {
            throw new RegistryError(
              `配置文件名不匹配: 文件 "${file}" 中的 id 是 "${config.id}"`
            );
          }

          this.register(config);
        } catch (err) {
          console.warn(`⚠️  加载 ${file} 失败:`, err instanceof Error ? err.message : err);
        }
      }

      console.log(`✅ AgentRegistry: 加载了 ${this.agents.size} 个 Agent`);
    } catch (err) {
      console.warn(`⚠️  扫描 ${AGENTS_CONFIG_DIR} 失败:`, err);
    }
  }

  /** 验证 Agent 配置 */
  private validateConfig(config: unknown): asserts config is AgentConfig {
    if (typeof config !== "object" || config === null) {
      throw new RegistryError("配置必须是对象");
    }

    const c = config as Record<string, unknown>;

    if (typeof c.id !== "string" || !c.id) {
      throw new RegistryError("id 字段缺失或无效");
    }
    if (typeof c.name !== "string" || !c.name) {
      throw new RegistryError("name 字段缺失或无效");
    }
    if (typeof c.emoji !== "string" || !c.emoji) {
      throw new RegistryError("emoji 字段缺失或无效");
    }
    if (typeof c.model !== "string" || !c.model) {
      throw new RegistryError("model 字段缺失或无效");
    }
    if (typeof c.persona !== "string" || !c.persona) {
      throw new RegistryError("persona 字段缺失或无效");
    }
    if (
      c.runtime !== undefined &&
      c.runtime !== "anthropic" &&
      c.runtime !== "claude-code"
    ) {
      throw new RegistryError(
        `runtime 字段无效: "${String(c.runtime)}"（合法值: anthropic | claude-code）`
      );
    }
  }

  /** 验证有默认 Agent */
  private validateDefaultAgent(): void {
    if (this.agents.size === 0) {
      console.warn("⚠️  AgentRegistry: 没有找到任何 Agent");
      return;
    }

    // 优先使用 "ji-tui" 作为默认，否则用第一个
    if (this.agents.has("ji-tui")) {
      this.defaultAgentId = "ji-tui";
    } else {
      this.defaultAgentId = this.agents.keys().next().value;
    }

    console.log(`📍 默认 Agent: ${this.defaultAgentId}`);
  }

  // ─── 公共 API ─────────────────────────────────────────────────────

  /** 注册或更新 Agent */
  register(config: AgentConfig): void {
    this.agents.set(config.id, config);
  }

  /** 获取单个 Agent 配置 */
  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  /** 检查 Agent 是否可用 */
  isAvailable(id: string): boolean {
    return this.agents.has(id);
  }

  /** 列出所有 Agent */
  listAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  /** 获取所有 Agent ID */
  listIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /** 解析 @handle → agentId（直接使用 id 作为 handle） */
  resolveHandle(handle: string): string | null {
    if (this.agents.has(handle)) {
      return handle;
    }
    return null;
  }

  /** 获取默认 Agent */
  getDefaultAgent(): AgentConfig | undefined {
    return this.defaultAgentId ? this.agents.get(this.defaultAgentId) : undefined;
  }

  /** 设置默认 Agent */
  setDefaultAgent(id: string): boolean {
    if (!this.agents.has(id)) {
      return false;
    }
    this.defaultAgentId = id;
    return true;
  }

  /** 获取默认 Agent ID */
  getDefaultAgentId(): string | undefined {
    return this.defaultAgentId;
  }
}
