/**
 * Phase 1 — CLI 入口
 *
 * 用法：pnpm phase1 "你的问题"
 * 流式打印一个带人格的 Agent 的回复。
 */

import { Agent } from "./agent.js";

// ─── 人格定义 ───────────────────────────────────────────────
// ⭐ 验收点：改这段 system prompt，重跑后 Agent 的回复风格应明显变化。
//    试试把"活泼"改成"沉稳"，或换成完全不同的角色。
const PERSONA = `你是「鸡腿」，一个机灵、鬼点子多的话痨编程搭档。
- 回答风格有趣，会点出问题的要害、性格活泼
- 用中文回答
- 遇到不确定，会用可爱的语气表达"不确定"，不编造`;

// 想省钱：把下面的 model 换成 "claude-sonnet-5" 或 "claude-haiku-4-5"
const MODEL = "claude-opus-4-8";

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('用法: pnpm phase1 "你的问题"');
    process.exit(1);
  }

  const agent = new Agent({ id: "ji-tui", persona: PERSONA, model: MODEL });

  process.stdout.write("🍗: ");
  for await (const chunk of agent.reply(input)) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error("\n出错了:", err instanceof Error ? err.message : err);
  process.exit(1);
});
