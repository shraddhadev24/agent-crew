import { searchKnowledge } from "./knowledgeSearch.js";

const MODEL = "claude-sonnet-4-6";

/**
 * PLANNER AGENT
 * Decomposes a goal into an ordered list of subtasks, each assigned to a
 * specialized agent role. In demo mode this is a fixed research -> write ->
 * review pipeline. In live mode, Claude generates the plan itself, which
 * means the plan can adapt in shape (e.g. multiple research subtasks) if
 * the goal warrants it.
 */
export async function planTask(goal, client) {
  const fallbackSteps = [
    { id: 1, agent: "researcher", instruction: `Research background information relevant to: ${goal}` },
    { id: 2, agent: "writer", instruction: `Draft a concise report addressing: ${goal}` },
    { id: 3, agent: "reviewer", instruction: `Review the draft for accuracy, completeness, and clarity against the goal.` },
  ];

  if (!client) {
    return { steps: fallbackSteps, raw: "[DEMO MODE] Static plan: research -> draft -> review." };
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `You are a planning agent. Break the following goal into a short ordered list of subtasks (2-4 steps). Each step must be assigned to one of these agent roles: "researcher", "writer", "reviewer". Respond with ONLY valid JSON in this exact shape, no other text:\n{"steps":[{"id":1,"agent":"researcher","instruction":"..."}]}\n\nGoal: ${goal}`,
      },
    ],
  });

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) throw new Error("empty steps");
    return { steps: parsed.steps, raw: text };
  } catch (err) {
    return { steps: fallbackSteps, raw: text, parseError: true };
  }
}

/**
 * RESEARCHER AGENT
 * In live mode, this agent is given a `search_knowledge_base` tool via
 * Claude's function-calling interface. Claude decides what to search for,
 * we execute the search locally, feed the results back as a tool_result,
 * and Claude produces a grounded summary. This is a real tool-use round
 * trip, not a scripted call.
 */
export async function research(instruction, client) {
  if (!client) {
    const results = searchKnowledge(instruction, 3);
    const notes = results.map((r) => `- [${r.docName}] ${r.text}`).join("\n\n");
    return {
      notes: notes || "No relevant local knowledge found for this instruction.",
      raw: `[DEMO MODE] Ran local keyword search directly, retrieved ${results.length} passages.`,
    };
  }

  const tools = [
    {
      name: "search_knowledge_base",
      description: "Search the local knowledge base for passages relevant to a query.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  ];

  const messages = [
    {
      role: "user",
      content: `You are a research agent. Use the search_knowledge_base tool to find information relevant to this instruction, then summarize what you found in 3-5 concise bullet points.\n\nInstruction: ${instruction}`,
    },
  ];

  let response = await client.messages.create({ model: MODEL, max_tokens: 600, tools, messages });

  // Handle one round of tool use (agent calls the search tool, we execute it,
  // then ask Claude to produce the final summary using the tool result).
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (toolUse) {
    const results = searchKnowledge(toolUse.input.query, 3);
    const toolResultText = results.length
      ? results.map((r) => `[${r.docName}] ${r.text}`).join("\n\n")
      : "No relevant results found.";

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: toolResultText,
        },
      ],
    });

    response = await client.messages.create({ model: MODEL, max_tokens: 600, tools, messages });
  }

  const notes = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { notes, raw: notes };
}

/**
 * WRITER AGENT
 * Drafts a structured report from research notes. Accepts optional
 * `feedback` from a prior reviewer pass to support the revise loop.
 */
export async function write(goal, notes, client, feedback = null) {
  if (!client) {
    const revisionNote = feedback ? `\n\n> Revised based on reviewer feedback: ${feedback}` : "";
    return {
      draft: `## Report: ${goal}\n\n### Key Findings\n${notes}\n\n### Summary\nBased on the research above, the key considerations for "${goal}" are grounded in the findings listed.${revisionNote}`,
      raw: "[DEMO MODE] Assembled draft from notes using a fixed template.",
    };
  }

  const feedbackBlock = feedback ? `\n\nPrevious draft was reviewed and needs revision. Reviewer feedback: ${feedback}` : "";
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    messages: [
      {
        role: "user",
        content: `You are a writing agent. Using ONLY the research notes below, write a well-structured report (with markdown headers) addressing the goal.${feedbackBlock}\n\nGoal: ${goal}\n\nResearch notes:\n${notes}`,
      },
    ],
  });
  const draft = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { draft, raw: draft };
}

/**
 * REVIEWER AGENT
 * Validates a draft against the original goal and returns a verdict:
 * "approve" or "revise" (with feedback). This closes the loop — the
 * orchestrator sends revise feedback back to the writer for one retry.
 */
export async function review(goal, draft, client) {
  if (!client) {
    const hasHeaders = /##/.test(draft);
    const longEnough = draft.length > 150;
    if (hasHeaders && longEnough) {
      return { verdict: "approve", feedback: null, raw: "[DEMO MODE] Rule check passed: has headers and sufficient length." };
    }
    return {
      verdict: "revise",
      feedback: "Draft is missing structured headers or is too short — add clear section headers and expand on findings.",
      raw: "[DEMO MODE] Rule check failed.",
    };
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `You are a reviewer agent. Check whether this draft adequately addresses the goal, is well-structured, and is grounded in specific details (not vague filler). Respond with ONLY valid JSON: {"verdict":"approve"|"revise","feedback":"..."}\n\nGoal: ${goal}\n\nDraft:\n${draft}`,
      },
    ],
  });
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return { verdict: parsed.verdict, feedback: parsed.feedback || null, raw: text };
  } catch {
    return { verdict: "approve", feedback: null, raw: text, parseError: true };
  }
}
