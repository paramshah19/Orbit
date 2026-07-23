// Mirrors how main.ts now loads the engine: a STATIC import of the SDK, bundled
// to CJS by esbuild, plus an explicit pathToClaudeCodeExecutable. No dynamic
// import anywhere — Chromium's loader in the Obsidian renderer cannot fetch
// file:// modules, which is what broke the previous approach.
//
//   npx esbuild spike/bundletest.ts --bundle --platform=node --format=cjs \
//     --target=es2018 --outfile=spike/bundletest.cjs && node spike/bundletest.cjs
import { query } from "@anthropic-ai/claude-agent-sdk";

// VAULT="C:/path/to/vault" node spike/bundletest.cjs
const vault = process.env.VAULT;
if (!vault) {
	console.error("Set the VAULT env var to your Obsidian vault root.");
	process.exit(1);
}
const dir = `${vault}/.obsidian/plugins/orbit`;
const bin = process.platform === "win32" ? "claude.exe" : "claude";
const exe = `${dir}/node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${bin}`;

(async () => {
	let text = "";
	for await (const msg of query({
		prompt: "Reply with exactly: ORBIT BUNDLE OK",
		options: {
			model: "sonnet",
			cwd: dir,
			pathToClaudeCodeExecutable: exe,
			settingSources: [],
		},
	}) as AsyncIterable<Record<string, any>>) {
		if (msg.type === "system" && msg.subtype === "init") {
			console.log("init ok | apiKeySource:", msg.apiKeySource);
		}
		if (msg.type === "assistant" && msg.message?.content) {
			text += msg.message.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
		}
	}
	console.log("reply:", JSON.stringify(text));
	const ok = text.includes("ORBIT BUNDLE OK");
	console.log(ok ? "\nPASS — bundled SDK runs on the Claude login" : "\nFAIL");
	process.exit(ok ? 0 : 3);
})().catch((e) => {
	console.error("FAIL:", e);
	process.exit(2);
});
