import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { runCrew } from "./orchestrator.js";

const args = process.argv.slice(2).filter((a) => a !== "--demo");
const goal = args.join(" ") || "Explain what makes remote hiring for AI engineering roles different in 2026, and how a candidate should prepare.";

const forceDemoMode = process.argv.includes("--demo");
const client =
  !forceDemoMode && process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

console.log(`\nGoal: ${goal}`);
console.log(`Mode: ${client ? "LIVE (Claude API)" : "DEMO (no API key / --demo flag)"}\n`);
console.log("Running agent crew...\n");

const result = await runCrew(goal, client);

console.log("─".repeat(60));
console.log("TRACE\n");
for (const step of result.trace) {
  const detail = typeof step.detail === "string" ? step.detail : JSON.stringify(step.detail, null, 2);
  console.log(`[${step.agent.toUpperCase()}] ${step.action}`);
  console.log(detail.length > 400 ? detail.slice(0, 400) + "…" : detail);
  console.log("");
}

console.log("─".repeat(60));
console.log(`FINAL RESULT (verdict: ${result.verdict}, revisions: ${result.revisions})\n`);
console.log(result.finalDraft);
