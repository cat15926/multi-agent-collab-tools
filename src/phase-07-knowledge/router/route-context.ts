/**
 * Phase 4 — 路由上下文
 */

/** 路由上下文（传递给 Agent） */
export interface RouteContext {
  threadId: string;
  participants: string[];
  hasMention: boolean;
}
