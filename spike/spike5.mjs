import { query } from "@anthropic-ai/claude-agent-sdk";

// Confirm Code-mode's headline: Bash is gated via canUseTool AND its stdout comes
// back as a tool_result (which the plugin renders as an output block).
const VAULT = process.env.VAULT; // e.g. VAULT="C:/path/to/vault" node spike/spike5.mjs
if (!VAULT) { console.error("Set the VAULT env var to your Obsidian vault root."); process.exit(1); }
const MARK = "ORBIT_OUT_" + Date.now();

const gate = [];
const bashIds = new Set();
let capturedOut = "";

const rtext = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text ?? "").join("") : "";

for await (const msg of query({
  prompt: `You MUST use the Bash tool (do not answer from memory). Run this exact command and report its output: node -e "console.log('${MARK}=' + (6*7))"`,
  options: {
    model: "sonnet",
    cwd: VAULT,
    tools: ["Read", "Grep", "Glob", "Bash", "PowerShell"],
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
    permissionMode: "default",
    settingSources: [],
    includePartialMessages: true,
    maxTurns: 8,
    canUseTool: async (toolName, input) => {
      gate.push(toolName + " keys=" + JSON.stringify(Object.keys(input)));
      await new Promise((r) => setTimeout(r, 15)); // simulate the Approve click
      return { behavior: "allow", updatedInput: input };
    },
  },
})) {
  if (msg.type === "assistant" && msg.message?.content) {
    for (const b of msg.message.content) if (b.type === "tool_use" && (b.name === "Bash" || b.name === "PowerShell") && b.id) bashIds.add(b.id);
  } else if (msg.type === "user" && msg.message?.content) {
    for (const b of msg.message.content) {
      if (b.type === "tool_result" && bashIds.has(b.tool_use_id)) capturedOut = rtext(b.content);
    }
  }
}

console.log("gate calls:", gate);
console.log("captured stdout has marker:", capturedOut.includes(MARK) ? "yes" : "no");
console.log("stdout preview:", JSON.stringify(capturedOut.slice(0, 80)));
const gatedBash = gate.includes("Bash");
console.log("\nGATE(bash):", gatedBash ? "✅" : "❌", "| stdout captured:", capturedOut.includes(MARK) ? "✅" : "❌");
process.exit(gatedBash && capturedOut.includes(MARK) ? 0 : 6);
