/**
 * Phase 8 — Token 计价（读时计算）
 *
 * 设计（ADR-013）：落库只存 token（事实），查询时乘单价（策略）。
 *   - 单价表 config/pricing.json（$/1M tokens，input/output 分开）
 *   - 单价更新 → 历史账单自动修正（无需回填）
 *   - 未知模型 → costOf 返回 null → 渲染层显示 "?"（relay 模型 usage 可能缺，不猜）
 *
 * 定位沿 agent-registry 惯例：__dirname 相对项目根 config/。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 单价表路径：项目根 config/pricing.json */
const PRICING_PATH = join(__dirname, "../../../config/pricing.json");

/** 单模型单价（$/1M tokens） */
export interface ModelPrice {
  input: number;
  output: number;
}

let cache: Map<string, ModelPrice> | null = null;

/** 加载单价表（读失败 → 空表，全部按未知模型处理；agent-registry 同款容错） */
export function loadPricing(): Map<string, ModelPrice> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(PRICING_PATH, "utf-8")) as Record<string, unknown>;
    const map = new Map<string, ModelPrice>();
    for (const [model, v] of Object.entries(raw)) {
      if (model.startsWith("$")) continue; // $comment 等元字段
      if (typeof v === "object" && v !== null && "input" in v && "output" in v) {
        map.set(model, { input: Number((v as ModelPrice).input), output: Number((v as ModelPrice).output) });
      }
    }
    cache = map;
    return map;
  } catch {
    cache = new Map();
    return cache;
  }
}

/** 单次调用成本（$）。未知模型 → null（渲染为 "?"） */
export function costOf(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = loadPricing().get(model);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

/** 成本渲染：null → "?"；<$0.01 → "<$0.01"；否则 $x.xxx（3 位小数） */
export function formatCost(cost: number | null): string {
  if (cost === null) return "?";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(3)}`;
}

/** token 数渲染：1234 → "1.2k" */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
