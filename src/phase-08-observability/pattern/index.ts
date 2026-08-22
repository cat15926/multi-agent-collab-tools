/**
 * Phase 5 — Pattern 模块导出
 */

export { Pattern, BasePattern, type ValidationResult } from "./base.js";
export type { PatternContext, PatternConfig, PatternHistoryItem, PatternEvents } from "./context.js";
export type { PatternResult, PatternStep, PatternMetadata, createEmptyPatternResult, createPatternStep } from "./result.js";
export { PatternRegistry, globalPatternRegistry } from "./registry.js";
