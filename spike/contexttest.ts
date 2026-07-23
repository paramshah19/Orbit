// Verifies Orbit's system-prompt context: does the engine accept
// {type:'preset', preset:'claude_code', append} and does the model then know
// it's Orbit, inside an Obsidian vault, in read-only Chat mode?
//
//   npx esbuild spike/contexttest.ts --bundle --platform=node --format=cjs \
//     --target=es2018 --define:import.meta.url=__filename \
//     --outfile=spike/contexttest.cjs && node spike/contexttest.cjs
import { query } from "@anthropic-ai/claude-agent-sdk";

// VAULT="C:/path/to/vault" node spike/contexttest.cjs
const vault = process.env.VAULT;
if (!vault) {
	console.error("Set the VAULT env var to your Obsidian vault root.");
	process.exit(1);
}
const dir = `${vault}/.obsidian/plugins/orbit`;
const bin = process.platform === "win32" ? "claude.exe" : "claude";
const exe = `${dir}/node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${bin}`;

// Mirrors OrbitView.orbitContext(mode="chat") closely enough to test the shape.
const append = `# Orbit

You are Orbit, running inside Obsidian as a panel in the user's right sidebar — not a terminal, not a browser, not a chat website. The user is reading you in a narrow (~350px) column beside their notes.

## Where you are
Obsidian vault "MyVault" — 42 markdown notes — at ${vault}.
You can see the whole vault.
This machine is win32; the shell tool here is called PowerShell.

## What these files are
Personal notes, not a software project: Markdown with YAML frontmatter, [[wikilinks]] between notes, and #tags.

## How to reply
Your replies render as plain text in that narrow panel — Markdown is not rendered yet. Keep answers short.

## What you can and cannot do here
Mode: **Chat** (read-only).
You have exactly three tools: Read, Grep, Glob. You cannot create, edit or delete notes, and you cannot run commands — those tools have been removed from you, not merely discouraged.
If the user asks for a change to their notes, say plainly that Chat is read-only and that the Code or Cowork tab can do it.`;

(async () => {
	let text = "";
	for await (const msg of query({
		prompt: "In one or two sentences: what are you, where are you running, and can you edit my notes right now?",
		options: {
			model: "sonnet",
			cwd: vault,
			pathToClaudeCodeExecutable: exe,
			settingSources: [],
			permissionMode: "default",
			systemPrompt: { type: "preset", preset: "claude_code", append },
			tools: ["Read", "Grep", "Glob"],
			allowedTools: ["Read", "Grep", "Glob"],
			maxTurns: 3,
		} as any,
	}) as AsyncIterable<Record<string, any>>) {
		if (msg.type === "assistant" && msg.message?.content) {
			text += msg.message.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
		}
	}
	console.log("reply:", text.trim(), "\n");
	const t = text.toLowerCase();
	const checks: Array<[string, boolean]> = [
		["knows it is Orbit", t.includes("orbit")],
		["knows it is in Obsidian", t.includes("obsidian")],
		["knows it cannot edit", /can'?t|cannot|read-only|read only|unable/.test(t)],
	];
	for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
	process.exit(checks.every(([, ok]) => ok) ? 0 : 3);
})().catch((e) => {
	console.error("FAIL:", e);
	process.exit(2);
});
