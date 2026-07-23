import { query } from "@anthropic-ai/claude-agent-sdk";

// Fail loud if a key is sneaking in — we want to prove the LOGIN path, not a key.
if (process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is set — unset it so we test the OAuth login.");
  process.exit(1);
}

let sawText = false;

try {
  for await (const msg of query({
    prompt: "Reply with exactly: ORBIT ENGINE OK",
    options: { model: "sonnet", cwd: process.cwd() },
  })) {
    console.log("MSG TYPE:", msg.type); // learn the real message union
    console.dir(msg, { depth: 4 });     // ground-truth shape, no guessing
    if (msg.type === "assistant") sawText = true;
  }
} catch (err) {
  console.error("\n❌ SPIKE ERROR:", err);
  process.exit(2);
}

console.log(sawText ? "\n✅ SPIKE PASSED" : "\n❌ no assistant message");
process.exit(sawText ? 0 : 3);
