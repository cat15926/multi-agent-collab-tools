/**
 * Phase 7 — Knowledge 模块导出
 */

export type {
  Evidence,
  EvidenceType,
  NewEvidence,
  KbStats,
  KbSearchHit,
  DistillEntry,
  DistillStatus,
} from "./types.js";
export { EVIDENCE_TYPES } from "./types.js";
export { KnowledgeBase } from "./knowledge-base.js";
export { Distiller, type DistillResult } from "./distiller.js";
