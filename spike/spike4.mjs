import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Week 3 recon: validate (a) in-process MCP vault_write tool + zod interop,
// (b) canUseTool as the approval chokepoint for BOTH the write tool and Bash,
// (c) built-in Write is blocked. The handler SIMULATES the apply (no real write).
const VAULT = process.env.VAULT; // e.g. VAULT="C:/path/to/vault" node spike/spike4.mjs
if (!VAULT) { console.error("Set the VAULT env var to your Obsidian vault root."); process.exit(1); }

let handlerRan = false;
const gateCalls = [];
const executed = [];
let bashStreamed = "";

const vaultWrite = tool(
  "vault_write",
  "Create or overwrite a note in the Obsidian vault (previewed and approved by the user; applied via Obsidian).",
  { path: z.string(), content: z.string() },
  async (args) => {
    handlerRan = true;
    // In the plugin this calls app.vault.modify/create. Here we just simulate.
    return { content: [{ type: "text", text: `Wrote ${args.path} (${args.content.length} chars).` }] };
  },
);

const orbit = createSdkMcpServer({ name: "orbit", version: "0.1.0", tools: [vaultWrite] });

const BLOCKED = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

for await (const msg of query({
  prompt:
    "Use the vault_write tool to create a note at 'test-orbit-scratch.md' containing 'hello from orbit'. Then run a bash command that echoes the text DONE.",
  options: {
    model: "sonnet",
    cwd: VAULT,
    tools: ["Read", "Grep", "Glob", "Bash"],
    disallowedTools: BLOCKED,
    mcpServers: { orbit },
    permissionMode: "default",
    settingSources: [],
    includePartialMessages: true,
    maxTurns: 12,
    canUseTool: async (toolName, input) => {
      gateCalls.push(toolName);
      if (BLOCKED.includes(toolName)) return { behavior: "deny", message: "blocked" };
      // Simulate the user clicking Approve after a beat.
      await new Promise((r) => setTimeout(r, 20));
      return { behavior: "allow", updatedInput: input };
    },
  },
})) {
  if (msg.type === "assistant" && msg.message?.content) {
    for (const b of msg.message.content) if (b.type === "tool_use") executed.push(b.name);
  } else if (msg.type === "user" && msg.message?.content) {
    for (const b of msg.message.content) {
      if (b.type === "tool_result") {
        const t = Array.isArray(b.content) ? b.content.map((c) => c.text).join("") : b.content;
        if (typeof t === "string" && t.includes("DONE")) bashStreamed = t;
      }
    }
  }
}

console.log("gate calls (approval points):", gateCalls);
console.log("tool_use executed:", executed);
console.log("MCP handler ran (vault_write):", handlerRan);
console.log("bash result contained DONE:", bashStreamed ? "yes" : "no");
const gatedWrite = gateCalls.some((n) => n.includes("vault_write"));
const gatedBash = gateCalls.includes("Bash");
const noBuiltinWrite = !executed.some((n) => BLOCKED.includes(n));
console.log("\nGATE(write):", gatedWrite ? "✅" : "❌", "| GATE(bash):", gatedBash ? "✅" : "❌",
  "| handler+interop:", handlerRan ? "✅" : "❌", "| built-in write blocked:", noBuiltinWrite ? "✅" : "❌");
process.exit(gatedWrite && gatedBash && handlerRan && noBuiltinWrite ? 0 : 5);
