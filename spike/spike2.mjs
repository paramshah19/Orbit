import { query } from "@anthropic-ai/claude-agent-sdk";

// Week 2 recon: read-only vault access + streaming shapes.
// Point cwd at the vault root so Claude can Grep/Read real notes.
const VAULT = process.env.VAULT; // e.g. VAULT="C:/path/to/vault" node spike/spike2.mjs
if (!VAULT) { console.error("Set the VAULT env var to your Obsidian vault root."); process.exit(1); }

const toolUses = [];
let streamEventKinds = new Set();
let firstStreamEvent = null;
let sawMutating = false;

for await (const msg of query({
  prompt:
    "Which of my notes mention Orbit? Use Grep to find them, then read projects/Orbit/ORBIT-PLAN.md and give a one-sentence summary.",
  options: {
    model: "sonnet",
    cwd: VAULT,
    permissionMode: "plan",
    allowedTools: ["Read", "Grep", "Glob"],
    disallowedTools: ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit"],
    includePartialMessages: true,
    maxTurns: 12,
  },
})) {
  if (msg.type === "assistant" && msg.message?.content) {
    for (const b of msg.message.content) {
      if (b.type === "tool_use") {
        toolUses.push({ name: b.name, input: b.input });
        if (["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit"].includes(b.name)) sawMutating = true;
      }
    }
  } else if (msg.type === "stream_event") {
    const ev = msg.event;
    streamEventKinds.add(ev?.type);
    if (!firstStreamEvent && ev?.type === "content_block_delta") {
      firstStreamEvent = ev;
    }
  } else if (msg.type === "result") {
    console.log("\n=== RESULT ===");
    console.log("subtype:", msg.subtype, "| permission_denials:", JSON.stringify(msg.permission_denials));
    console.log("result text:", JSON.stringify(msg.result?.slice(0, 200)));
  }
}

console.log("\n=== TOOL USES (name + input) ===");
for (const t of toolUses) console.log("-", t.name, JSON.stringify(t.input));

console.log("\n=== stream_event kinds seen ===", [...streamEventKinds]);
console.log("=== sample content_block_delta event ===");
console.dir(firstStreamEvent, { depth: 5 });

console.log("\n=== READ-ONLY CHECK ===", sawMutating ? "❌ a mutating tool was called" : "✅ no Write/Edit/Bash");
