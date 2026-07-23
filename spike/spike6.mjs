import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Cowork recon: plan (read-only) → resume SAME session with gated tools → execute.
// Validates session-resume-with-changed-toolset and the plan→execute handoff.
const VAULT = process.env.VAULT; // e.g. VAULT="C:/path/to/vault" node spike/spike6.mjs
if (!VAULT) { console.error("Set the VAULT env var to your Obsidian vault root."); process.exit(1); }
const READ = ["Read", "Grep", "Glob"];

let handlerRan = false;
const phase1Tools = [];
const phase2Gate = [];

const vaultWrite = tool(
  "vault_write",
  "Create or overwrite a note in the Obsidian vault (previewed + approved; applied via Obsidian).",
  { path: z.string(), content: z.string() },
  async (a) => {
    handlerRan = true;
    return { content: [{ type: "text", text: `Wrote ${a.path}` }] };
  },
);
const orbit = createSdkMcpServer({ name: "orbit", version: "0.1.0", tools: [vaultWrite] });

let sessionId = null;

// ---- Phase 1: PLAN (read-only + plan-only system prompt) ----
for await (const msg of query({
  prompt: "Task:\nCreate a note 'test-cowork-scratch.md' with a one-line summary of what Orbit is.",
  options: {
    model: "sonnet",
    cwd: VAULT,
    tools: READ,
    allowedTools: READ,
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"],
    settingSources: [],
    includePartialMessages: false,
    maxTurns: 6,
    systemPrompt:
      "You are Orbit's planning step. Reply with ONLY a short numbered plan. Do not write files or run code yet.",
    canUseTool: async (t, input) =>
      READ.includes(t) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "plan is read-only" },
  },
})) {
  if (msg.session_id) sessionId = msg.session_id;
  if (msg.type === "assistant" && msg.message?.content)
    for (const b of msg.message.content) if (b.type === "tool_use") phase1Tools.push(b.name);
  if (msg.type === "result") console.log("PLAN:", JSON.stringify(msg.result?.slice(0, 160)));
}
console.log("phase1 tools:", phase1Tools, "| session:", sessionId ? "captured" : "none");

// ---- Phase 2: EXECUTE (resume same session, gated write tool) ----
for await (const msg of query({
  prompt:
    "The user approved your plan. Carry it out now using the vault_write tool. You'll be asked to approve the write.",
  options: {
    model: "sonnet",
    cwd: VAULT,
    tools: ["Read", "Grep", "Glob", "Bash", "PowerShell"],
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
    mcpServers: { orbit },
    settingSources: [],
    includePartialMessages: false,
    maxTurns: 10,
    resume: sessionId,
    canUseTool: async (t, input) => {
      if (READ.includes(t)) return { behavior: "allow", updatedInput: input };
      phase2Gate.push(t);
      await new Promise((r) => setTimeout(r, 15));
      return { behavior: "allow", updatedInput: input };
    },
  },
})) {
  if (msg.type === "result") console.log("EXEC:", JSON.stringify(msg.result?.slice(0, 160)));
}

const planNoWrites = !phase1Tools.some((n) => !READ.includes(n));
console.log("phase2 gate calls:", phase2Gate);
console.log("\nPLAN read-only:", planNoWrites ? "✅" : "❌",
  "| resume worked + write gated:", phase2Gate.some((n) => n.includes("vault_write")) ? "✅" : "❌",
  "| handler ran:", handlerRan ? "✅" : "❌");
process.exit(planNoWrites && phase2Gate.some((n) => n.includes("vault_write")) && handlerRan ? 0 : 7);
