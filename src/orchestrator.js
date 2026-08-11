import { planTask, research, write, review } from "./agents.js";

const MAX_REVISIONS = 1;

/**
 * Runs the full agent pipeline for a goal, producing a trace of every
 * agent's input/output alongside the final result. The trace is the point:
 * in a multi-agent system, observability into *why* a result looks the way
 * it does matters as much as the result itself.
 */
export async function runCrew(goal, client) {
  const trace = [];
  const log = (agent, action, detail) => trace.push({ agent, action, detail, timestamp: new Date().toISOString() });

  log("planner", "plan", `Decomposing goal: "${goal}"`);
  const plan = await planTask(goal, client);
  log("planner", "plan_result", plan);

  let notes = "";
  for (const step of plan.steps.filter((s) => s.agent === "researcher")) {
    log("researcher", "start", step.instruction);
    const result = await research(step.instruction, client);
    log("researcher", "notes", result.notes);
    notes += (notes ? "\n\n" : "") + result.notes;
  }

  if (!notes) {
    // If the plan didn't include a researcher step, still gather baseline notes
    log("researcher", "start", `(fallback) Research background for: ${goal}`);
    const result = await research(goal, client);
    log("researcher", "notes", result.notes);
    notes = result.notes;
  }

  log("writer", "start", "Drafting report from research notes");
  let { draft } = await write(goal, notes, client);
  log("writer", "draft", draft);

  let revisions = 0;
  let verdict = "revise";
  let feedback = null;

  while (revisions <= MAX_REVISIONS) {
    log("reviewer", "start", "Reviewing draft against goal");
    const reviewResult = await review(goal, draft, client);
    verdict = reviewResult.verdict;
    feedback = reviewResult.feedback;
    log("reviewer", "verdict", { verdict, feedback });

    if (verdict === "approve" || revisions === MAX_REVISIONS) break;

    log("writer", "revise", `Revising based on feedback: ${feedback}`);
    const revised = await write(goal, notes, client, feedback);
    draft = revised.draft;
    log("writer", "draft_revised", draft);
    revisions += 1;
  }

  return {
    goal,
    finalDraft: draft,
    verdict,
    revisions,
    trace,
  };
}
