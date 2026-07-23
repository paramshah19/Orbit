import { query } from "@anthropic-ai/claude-agent-sdk";

// Mirrors the plugin's EXACT Chat options — proves read-only holds and streaming works.
const VAULT = process.env.VAULT; // e.g. VAULT="C:/path/to/vault" node spike/spike3.mjs
if (!VAULT) { console.error("Set the VAULT env var to your Obsidian vault root."); process.exit(1); }
const READ = ["Read", "Grep", "Glob"];
const BLOCKED = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

const executed = [];
const denied = [];
let textDeltas = 0;
let streamed = "";

for await (const msg of query({
  prompt:
    "Which of my notes mention Orbit? Use Grep, then read projects/Orbit/ORBIT-PLAN.md and summarise it in one sentence.",
  options: {
    model: "sonnet",
    cwd: VAULT,
    tools: READ,
    allowedTools: READ,
    disallowedTools: BLOCKED,
    permissionMode: "default",
    settingSources: [],
    includePartialMessages: true,
    maxTurns: 12,
    canUseTool: async (toolName, input) => {
      if (READ.includes(toolName)) return { behavior: "allow", updatedInput: input };
      denied.push(toolName);
      return { behavior: "deny", message: `read-only; ${toolName} blocked` };
    },
  },
})) {
  if (msg.type === "assistant" && msg.message?.content) {
    for (const b of msg.message.content) if (b.type === "tool_use") executed.push(b.name);
  } else if (msg.type === "stream_event" && msg.event?.type === "content_block_delta") {
    if (msg.event.delta?.type === "text_delta" && msg.event.delta.text) {
      textDeltas++;
      streamed += msg.event.delta.text;
    }
  } else if (msg.type === "result") {
    console.log("result subtype:", msg.subtype);
  }
}

const mutating = executed.filter((n) => BLOCKED.includes(n));
console.log("tool_use emitted:", executed);
console.log("canUseTool denied:", denied);
console.log("text_delta count:", textDeltas, "| streamed chars:", streamed.length);
console.log("streamed preview:", JSON.stringify(streamed.slice(0, 120)));
console.log("\nREAD-ONLY:", mutating.length === 0 ? "✅ no mutating tool executed" : `❌ ran ${mutating}`);
console.log("STREAMING:", textDeltas > 0 ? "✅ text streamed via deltas" : "❌ no deltas");
process.exit(mutating.length === 0 && textDeltas > 0 ? 0 : 4);
