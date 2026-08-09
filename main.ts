import {
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	FileSystemAdapter,
	TFile,
	normalizePath,
	setIcon,
} from "obsidian";
import { z } from "zod";

export const VIEW_TYPE_ORBIT = "orbit-view";

type OrbitMode = "chat" | "code" | "cowork";

interface OrbitSettings {
	/** Which tab opens first. */
	defaultMode: OrbitMode;
	/**
	 * Model alias per mode — the modes have different needs, so one global
	 * choice can't express them (availability depends on the Claude plan tier).
	 */
	models: Record<OrbitMode, string>;
	/** Vault-relative folder to scope the engine to; "" = whole vault. */
	scopeFolder: string;
}

/** Selectable models, newest first. Availability depends on the plan tier. */
const ORBIT_MODELS: Record<string, string> = {
	opus: "Opus 4.8",
	sonnet: "Sonnet 5",
	haiku: "Haiku 4.5",
};

const DEFAULT_SETTINGS: OrbitSettings = {
	defaultMode: "chat",
	// Matches the plan: cheap and fast for Q&A, strongest for code and multi-step.
	models: { chat: "sonnet", code: "opus", cowork: "opus" },
	scopeFolder: "",
};

/**
 * Minimal shape of the Agent SDK messages we consume this week.
 * Ground-truthed from the Week 1 feasibility spike:
 *   - "assistant" carries message.content[] blocks of { type: "text", text }
 *   - "result" carries the final answer as a plain string in .result
 */
interface OrbitContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: Record<string, unknown>;
	id?: string;
	tool_use_id?: string;
	content?: unknown;
}

interface OrbitStreamEvent {
	type: string;
	delta?: { type: string; text?: string; thinking?: string };
}

interface OrbitSDKMessage {
	type: string;
	subtype?: string;
	session_id?: string;
	message?: { content?: OrbitContentBlock[] };
	result?: string;
	event?: OrbitStreamEvent;
}

type QueryFn = (args: {
	prompt: string;
	options?: Record<string, unknown>;
}) => AsyncIterable<OrbitSDKMessage>;

interface CallToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}
type ToolFn = (
	name: string,
	description: string,
	inputSchema: Record<string, unknown>,
	handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>,
) => unknown;
type CreateSdkMcpServerFn = (opts: { name: string; version?: string; tools: unknown[] }) => unknown;

interface OrbitSdkModule {
	query: QueryFn;
	tool: ToolFn;
	createSdkMcpServer: CreateSdkMcpServerFn;
}

/**
 * The Agent SDK is imported STATICALLY and bundled into main.js by esbuild
 * (which converts its ESM to CJS). It must not be loaded with a runtime
 * dynamic import: inside Obsidian, `import()` in plugin code is Chromium's
 * module loader, and Chromium refuses to fetch file:// modules — so a runtime
 * import fails with "Failed to fetch dynamically imported module" no matter
 * how correct the path is. Bundling is what Claudian (proven working) does.
 *
 * The one thing bundling costs us is the SDK's own binary lookup, which walks
 * from its module location. We don't rely on it — `pathToClaudeCodeExecutable`
 * is passed explicitly below.
 */
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "fs";

const sdk = { query, tool, createSdkMcpServer } as unknown as OrbitSdkModule;

/** Absolute path of the folder Obsidian loaded this plugin from. */
function pluginDir(plugin: OrbitPlugin): string {
	const base = plugin.getVaultPath();
	if (!base) throw new Error("Orbit is desktop-only — no local vault path is available.");
	return `${base}/${plugin.manifest.dir}`;
}

/**
 * The `claude` binary that the SDK drives. It ships as a platform-specific
 * optional dependency inside the plugin's own node_modules, so we can name the
 * path outright instead of hoping the bundle can resolve it.
 */
export function claudeBinaryPath(dir: string): string | null {
	const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
	const bin = process.platform === "win32" ? "claude.exe" : "claude";
	const p = `${dir}/node_modules/${pkg}/${bin}`;
	return existsSync(p) ? p : null;
}

export default class OrbitPlugin extends Plugin {
	settings: OrbitSettings = { ...DEFAULT_SETTINGS };

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_ORBIT, (leaf) => new OrbitView(leaf, this));

		this.addRibbonIcon("bot", "Open Orbit", () => this.activateView());

		this.addCommand({
			id: "open-orbit",
			name: "Open Orbit panel",
			callback: () => this.activateView(),
		});

		this.addSettingTab(new OrbitSettingTab(this.app, this));
	}

	async onunload() {
		// Leaves are detached automatically by Obsidian on unload.
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<OrbitSettings> & { model?: string };
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// Migrate the pre-per-mode single `model` setting rather than silently
		// dropping the user's choice.
		if (saved?.model && !saved.models) {
			this.settings.models = { chat: saved.model, code: saved.model, cowork: saved.model };
		}
		delete (this.settings as Partial<OrbitSettings> & { model?: string }).model;
		this.settings.models = { ...DEFAULT_SETTINGS.models, ...this.settings.models };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_ORBIT)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE_ORBIT, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	/** Push a settings-tab model change into any open Orbit panels. */
	refreshModelSelects() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ORBIT)) {
			const view = leaf.view;
			if (view instanceof OrbitView) view.syncModelSelects();
		}
	}

	/** Absolute path of the current vault, for the engine's cwd. Desktop-only. */
	getVaultPath(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
		return null;
	}
}

const READ_TOOLS = ["Read", "Grep", "Glob"];
/** Chat is read-only: these are the only tools the engine may use. */
const CHAT_TOOLS = READ_TOOLS;
const CHAT_BLOCKED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];
/** The shell/code-run tool is platform-specific: PowerShell on Windows, Bash elsewhere. */
const SHELL_TOOLS = ["Bash", "PowerShell"];
/** Code adds the gated shell tools (code runs) + the gated vault-write MCP tool. */
const CODE_TOOLS = ["Read", "Grep", "Glob", ...SHELL_TOOLS];
/** Built-in mutating tools are always removed — writes go through our Vault-API tool. */
const WRITE_BLOCKED = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const ORBIT_WRITE_TOOL = "mcp__orbit__vault_write";

function toolResultText(c: unknown): string {
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((x) => (x && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : ""))
			.join("");
	}
	return "";
}

class OrbitView extends ItemView {
	private plugin: OrbitPlugin;
	private mode: OrbitMode = "chat";
	private tabBarEl!: HTMLElement;
	/** One pane per mode, built once and shown/hidden — so transcripts survive tab switches. */
	private panes: Record<OrbitMode, HTMLElement> = {} as Record<OrbitMode, HTMLElement>;
	/** Per-mode busy flag: one mode running must not lock the others. */
	private busy: Record<OrbitMode, boolean> = { chat: false, code: false, cowork: false };
	/** Set by Stop; checked each iteration of the stream loop. */
	private cancel: Record<OrbitMode, boolean> = { chat: false, code: false, cowork: false };
	/** Per-mode Send/Stop button, so the stream loop can flip it. */
	private sendBtns: Record<OrbitMode, HTMLButtonElement | null> = { chat: null, code: null, cowork: null };
	private inputs: Record<OrbitMode, HTMLTextAreaElement | null> = { chat: null, code: null, cowork: null };
	private modelSelects: Record<OrbitMode, HTMLSelectElement | null> = { chat: null, code: null, cowork: null };
	/** Per-mode Agent SDK session id, kept across turns for real conversations. */
	private sessions: Record<OrbitMode, string | null> = { chat: null, code: null, cowork: null };
	/** Cached in-process MCP server exposing the gated Vault-API write tool. */
	private orbitServer: unknown | null = null;
	/** The current turn's element, so approval cards created mid-turn land inside it instead of after it. Null between turns. */
	private activeTurnHost: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: OrbitPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_ORBIT;
	}

	getDisplayText(): string {
		return "Orbit";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("orbit-root");

		this.renderBrandBar(root);

		// Tab bar: Chat / Code / Cowork
		this.tabBarEl = root.createDiv({ cls: "orbit-tabs" });
		const modes: Array<{ id: OrbitMode; label: string }> = [
			{ id: "chat", label: "Chat" },
			{ id: "code", label: "Code" },
			{ id: "cowork", label: "Cowork" },
		];
		for (const m of modes) {
			const btn = this.tabBarEl.createEl("button", {
				text: m.label,
				cls: "orbit-tab",
			});
			btn.dataset.mode = m.id;
			btn.addEventListener("click", () => this.setMode(m.id));
		}

		// Preflight: surface a missing engine binary once, at open, instead of
		// only failing on the first message.
		if (this.sdkMissing()) this.renderEngineBanner(root);

		// Build all three panes up front; switching only toggles visibility.
		for (const m of modes) {
			const pane = root.createDiv({ cls: "orbit-pane is-hidden" });
			this.panes[m.id] = pane;
			this.renderConversation(m.id, pane);
		}
		this.setMode(this.plugin.settings.defaultMode);
	}

	async onClose() {
		this.contentEl.empty();
	}

	/**
	 * Orbit's own mark: a body on an orbital path. Built with createElementNS
	 * rather than innerHTML, which Obsidian's plugin review flags.
	 */
	private renderOrbitMark(parent: HTMLElement, size: number): SVGElement {
		const NS = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(NS, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("width", String(size));
		svg.setAttribute("height", String(size));
		svg.addClass("orbit-mark");

		const ring = document.createElementNS(NS, "ellipse");
		ring.setAttribute("cx", "12");
		ring.setAttribute("cy", "12");
		ring.setAttribute("rx", "10.5");
		ring.setAttribute("ry", "5");
		ring.setAttribute("transform", "rotate(-28 12 12)");
		ring.setAttribute("fill", "none");
		ring.setAttribute("stroke", "currentColor");
		ring.setAttribute("stroke-width", "1.4");
		ring.setAttribute("opacity", "0.55");
		svg.appendChild(ring);

		const core = document.createElementNS(NS, "circle");
		core.setAttribute("cx", "12");
		core.setAttribute("cy", "12");
		core.setAttribute("r", "3.4");
		core.setAttribute("fill", "currentColor");
		svg.appendChild(core);

		// Sits exactly on the ellipse (t=0, rotated -28°), not near it.
		const satellite = document.createElementNS(NS, "circle");
		satellite.setAttribute("cx", "21.27");
		satellite.setAttribute("cy", "7.07");
		satellite.setAttribute("r", "1.8");
		satellite.setAttribute("fill", "currentColor");
		svg.appendChild(satellite);

		parent.appendChild(svg);
		return svg;
	}

	/** Identity strip above the tabs: mark + wordmark + what powers it. */
	private renderBrandBar(root: HTMLElement) {
		const bar = root.createDiv({ cls: "orbit-brand" });
		const left = bar.createDiv({ cls: "orbit-brand-left" });
		this.renderOrbitMark(left, 18);
		left.createSpan({ cls: "orbit-wordmark", text: "Orbit" });
		// Nominative reference only — Orbit is not an Anthropic product.
		bar.createSpan({ cls: "orbit-poweredby", text: "Powered by Claude" });
	}

	private renderEngineBanner(root: HTMLElement) {
		const banner = root.createDiv({ cls: "orbit-banner" });
		banner.createSpan({
			text: "Orbit's engine isn't installed. Run `npm install` in <vault>/.obsidian/plugins/orbit, then reload Obsidian.",
		});
		const x = banner.createEl("button", { cls: "orbit-banner-dismiss", text: "✕" });
		x.addEventListener("click", () => banner.remove());
	}

	private setMode(mode: OrbitMode) {
		this.mode = mode;
		for (const btn of Array.from(this.tabBarEl.children) as HTMLElement[]) {
			btn.toggleClass("is-active", btn.dataset.mode === mode);
		}
		for (const m of Object.keys(this.panes) as OrbitMode[]) {
			this.panes[m].toggleClass("is-hidden", m !== mode);
		}
	}

	/** Status pill copy + dot tone for a mode (no emoji — the dot carries the colour). */
	private modeBadge(mode: OrbitMode): { tone: string; text: string } {
		// Kept short: the header also carries the model picker and New chat.
		if (mode === "chat") return { tone: "safe", text: "Read-only" };
		if (mode === "code") return { tone: "warn", text: "Approval required" };
		return { tone: "safe", text: "Plan first" };
	}

	private modePlaceholder(mode: OrbitMode): string {
		if (mode === "chat") return "Ask Claude about your vault…";
		if (mode === "code") return "Ask Claude to write or run code on your notes…";
		return "Give Claude a multi-step task (it will plan first)…";
	}

	/** Example prompts shown in a mode's empty state. */
	private modeExamples(mode: OrbitMode): string[] {
		if (mode === "chat") {
			return [
				"Summarise the note I have open",
				"Which notes mention Orbit?",
				"What did I plan for Week 3?",
			];
		}
		if (mode === "code") {
			return ["Count words across my daily notes", "Chart the numbers in this note"];
		}
		return ["Draft this week's review from my daily notes"];
	}

	private renderEmptyState(mode: OrbitMode, messagesEl: HTMLElement, input: HTMLTextAreaElement) {
		const empty = messagesEl.createDiv({ cls: "orbit-empty" });
		this.renderOrbitMark(empty.createDiv({ cls: "orbit-empty-mark" }), 32);
		empty.createDiv({ cls: "orbit-empty-title", text: this.modeTitle(mode) });
		empty.createDiv({ cls: "orbit-empty-desc", text: this.modeDesc(mode) });
		for (const ex of this.modeExamples(mode)) {
			const chip = empty.createDiv({ cls: "orbit-example", text: ex });
			chip.addEventListener("click", () => {
				input.value = ex;
				input.focus();
				input.dispatchEvent(new Event("input"));
			});
		}
	}

	private modeTitle(mode: OrbitMode): string {
		if (mode === "chat") return "Chat";
		if (mode === "code") return "Code";
		return "Cowork";
	}

	private modeDesc(mode: OrbitMode): string {
		if (mode === "chat") return "Ask about your vault. Reads your notes, never edits them.";
		if (mode === "code") return "Writes and runs code on your notes. You approve every run.";
		return "Multi-step tasks. Claude plans first, then you approve each change.";
	}

	/**
	 * Per-mode model picker. Takes effect on the next turn — the resumed
	 * session carries the conversation, so switching mid-chat is safe.
	 */
	private renderModelSelect(parent: HTMLElement, mode: OrbitMode) {
		const select = parent.createEl("select", { cls: "orbit-model" });
		select.setAttr("aria-label", `Model for ${this.modeTitle(mode)}`);
		for (const [value, label] of Object.entries(ORBIT_MODELS)) {
			const opt = select.createEl("option", { text: label });
			opt.value = value;
		}
		select.value = this.plugin.settings.models[mode];
		select.addEventListener("change", async () => {
			this.plugin.settings.models[mode] = select.value;
			await this.plugin.saveSettings();
			this.syncModelSelects();
		});
		this.modelSelects[mode] = select;
	}

	/** Keep panel pickers and the settings tab from drifting apart. */
	syncModelSelects() {
		for (const m of Object.keys(this.modelSelects) as OrbitMode[]) {
			const el = this.modelSelects[m];
			if (el) el.value = this.plugin.settings.models[m];
		}
	}

	/** Flip a mode's send button between Send (↑) and Stop (■). */
	private setRunning(mode: OrbitMode, running: boolean) {
		this.busy[mode] = running;
		const btn = this.sendBtns[mode];
		if (!btn) return;
		btn.setText(running ? "■" : "↑");
		btn.setAttr("aria-label", running ? "Stop" : "Send");
		btn.toggleClass("is-running", running);
		// Stop is always clickable; Send is dead until there's something to send.
		btn.disabled = running ? false : (this.inputs[mode]?.value.trim().length ?? 0) === 0;
	}

	private renderConversation(mode: OrbitMode, pane: HTMLElement) {
		const wrap = pane.createDiv({ cls: "orbit-chat" });

		const header = wrap.createDiv({ cls: "orbit-chat-header" });
		const badge = this.modeBadge(mode);
		const badgeEl = header.createDiv({ cls: "orbit-mode-badge" });
		badgeEl.createSpan({ cls: `orbit-dot is-${badge.tone}` });
		badgeEl.createSpan({ text: badge.text });
		const actions = header.createDiv({ cls: "orbit-header-actions" });
		this.renderModelSelect(actions, mode);
		const newBtn = actions.createEl("button", { cls: "orbit-newchat", text: "New chat" });
		newBtn.setAttr("aria-label", "Start a new conversation");

		const messagesEl = wrap.createDiv({ cls: "orbit-messages" });

		// One bordered container owns the composer; the textarea inside is
		// transparent and borderless (the shape Claude and Claudian both use).
		const composer = wrap.createDiv({ cls: "orbit-composer" });
		const input = composer.createEl("textarea", {
			cls: "orbit-input",
			attr: { rows: "1", placeholder: this.modePlaceholder(mode) },
		});
		const bar = composer.createDiv({ cls: "orbit-composer-bar" });
		bar.createSpan({ cls: "orbit-hint", text: "⏎ send · ⇧⏎ newline" });
		const sendBtn = bar.createEl("button", { cls: "orbit-send", text: "↑" });
		sendBtn.setAttr("aria-label", "Send");
		sendBtn.disabled = true;
		this.sendBtns[mode] = sendBtn;
		this.inputs[mode] = input;

		// Grow with the message instead of scrolling inside a one-line box.
		const autoGrow = () => {
			input.style.height = "auto";
			input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
			if (!this.busy[mode]) sendBtn.disabled = input.value.trim().length === 0;
		};
		input.addEventListener("input", autoGrow);

		this.renderEmptyState(mode, messagesEl, input);
		this.attachHighlighting(messagesEl);

		newBtn.addEventListener("click", () => {
			this.sessions[mode] = null;
			// Not messagesEl.empty() — that would also delete the highlight
			// pill (a persistent child wired up once by attachHighlighting).
			for (const child of Array.from(messagesEl.children)) {
				if (child.hasClass("orbit-highlight-pill")) (child as HTMLElement).style.display = "none";
				else child.remove();
			}
			this.renderEmptyState(mode, messagesEl, input);
		});

		const submit = () => {
			const text = input.value.trim();
			if (!text || this.busy[mode]) return;
			input.value = "";
			autoGrow();
			messagesEl.querySelector(".orbit-empty")?.remove();
			if (mode === "cowork") void this.runCowork(text, messagesEl);
			else void this.run(mode, text, messagesEl);
		};

		// One button, two jobs: Send when idle, Stop while streaming.
		sendBtn.addEventListener("click", () => {
			if (this.busy[mode]) this.cancel[mode] = true;
			else submit();
		});
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.shiftKey) {
				evt.preventDefault();
				submit();
			}
		});
	}

	private addBubble(container: HTMLElement, role: "user" | "assistant", text: string): HTMLElement {
		const group = container.createDiv({ cls: `orbit-msg-group orbit-msg-group-${role}` });
		const bubble = this.addPlainBubble(group, role, text);
		this.addCopyButton(group, () => text);
		container.scrollTop = container.scrollHeight;
		return bubble;
	}

	/** Bare message bubble with no group/button wrapper — caller owns the wrapper. */
	private addPlainBubble(container: HTMLElement, role: "user" | "assistant", text: string): HTMLElement {
		const bubble = container.createDiv({ cls: `orbit-bubble orbit-${role}` });
		bubble.setText(text);
		return bubble;
	}

	/** Hover-revealed copy button appended to a `.orbit-msg-group`. */
	private addCopyButton(group: HTMLElement, getText: () => string) {
		const btn = group.createEl("button", { cls: "orbit-copy-btn", attr: { "aria-label": "Copy" } });
		setIcon(btn, "copy");
		btn.addEventListener("click", () => {
			void navigator.clipboard.writeText(getText());
			btn.addClass("is-copied");
			setIcon(btn, "check");
			setTimeout(() => {
				btn.removeClass("is-copied");
				setIcon(btn, "copy");
			}, 1200);
		});
	}

	/** Wires up select-to-highlight for one panel's message list. */
	private attachHighlighting(messagesEl: HTMLElement) {
		const pill = messagesEl.createEl("button", {
			cls: "orbit-highlight-pill",
			attr: { "aria-label": "Highlight" },
		});
		setIcon(pill, "highlighter");
		pill.style.display = "none";

		let activeRange: Range | null = null;

		const hidePill = () => {
			pill.style.display = "none";
			activeRange = null;
		};

		const showPillFor = (range: Range) => {
			const rect = range.getBoundingClientRect();
			const parentRect = messagesEl.getBoundingClientRect();
			pill.style.display = "flex";
			pill.style.left = `${rect.left - parentRect.left + rect.width / 2 - 14}px`;
			pill.style.top = `${rect.top - parentRect.top - 30 + messagesEl.scrollTop}px`;
		};

		messagesEl.addEventListener("mouseup", (evt) => {
			// Clicking the pill itself must not re-run selection handling.
			if (evt.target === pill || pill.contains(evt.target as Node)) return;

			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				hidePill();
				return;
			}
			const range = selection.getRangeAt(0);
			if (range.collapsed) {
				hidePill();
				return;
			}

			const bubble = (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
				? (range.commonAncestorContainer as Element)
				: range.commonAncestorContainer.parentElement
			)?.closest(".orbit-bubble");
			if (!bubble || !messagesEl.contains(bubble)) {
				hidePill();
				return;
			}

			// Selection must not intersect an existing highlight (avoids
			// surroundContents throwing on a partially-overlapping range).
			const existingMarks = bubble.querySelectorAll(".orbit-highlight");
			for (const mark of Array.from(existingMarks)) {
				if (range.intersectsNode(mark)) {
					hidePill();
					return;
				}
			}

			activeRange = range;
			showPillFor(range);
		});

		messagesEl.addEventListener("scroll", hidePill);

		pill.addEventListener("click", () => {
			if (!activeRange) return;
			const mark = document.createElement("mark");
			mark.className = "orbit-highlight";
			try {
				activeRange.surroundContents(mark);
			} catch {
				// Range spans multiple text nodes (e.g. selection crosses a
				// child element within the bubble) — extract and re-wrap instead.
				const contents = activeRange.extractContents();
				mark.appendChild(contents);
				activeRange.insertNode(mark);
			}
			window.getSelection()?.removeAllRanges();
			hidePill();
		});

		messagesEl.addEventListener("click", (evt) => {
			const target = evt.target as HTMLElement;
			const mark = target.closest(".orbit-highlight");
			if (!mark || !messagesEl.contains(mark)) return;
			const parent = mark.parentNode;
			if (!parent) return;
			while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
			parent.removeChild(mark);
			parent.normalize();
		});
	}

	/** Vault-relative, forward-slashed display path for a tool's absolute path. */
	private toVaultRel(abs: string, vaultPath: string): string {
		let p = abs.replace(/\\/g, "/");
		const root = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
		if (p.startsWith(root + "/")) p = p.slice(root.length + 1);
		return p;
	}

	/** Render the "which notes Claude looked at" indicator. */
	private renderContext(el: HTMLElement, reads: Set<string>, searches: Set<string>) {
		if (reads.size === 0 && searches.size === 0) {
			el.setText("");
			el.toggleClass("is-empty", true);
			return;
		}
		el.toggleClass("is-empty", false);
		el.empty();
		if (reads.size > 0) {
			el.createSpan({ text: `📄 read: ${Array.from(reads).join(", ")}` });
		}
		if (searches.size > 0) {
			el.createSpan({ text: `  🔎 searched: ${Array.from(searches).join(", ")}` });
		}
	}

	/** Apply a note write through Obsidian's Vault API (never raw disk). */
	private async applyVaultWrite(rawPath: string, content: string): Promise<string> {
		const path = normalizePath(rawPath);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return `Updated ${path}`;
		}
		const dir = path.split("/").slice(0, -1).join("/");
		if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
			try {
				await this.app.vault.createFolder(dir);
			} catch {
				/* folder may already exist */
			}
		}
		await this.app.vault.create(path, content);
		return `Created ${path}`;
	}

	/** Build a preview (new-file or overwrite diff summary) for the approval card. */
	private async buildWriteDiff(rawPath: string, content: string): Promise<string> {
		const existing = this.app.vault.getAbstractFileByPath(normalizePath(rawPath));
		let header: string;
		if (existing instanceof TFile) {
			const old = await this.app.vault.read(existing);
			header = `Overwrite existing note (${old.length} → ${content.length} chars)`;
		} else {
			header = "Create new note";
		}
		const preview = content.length > 1500 ? content.slice(0, 1500) + "\n…(truncated)" : content;
		return `${header}\n\n${preview}`;
	}

	/** In-process MCP server exposing the Vault-API write tool (cached). */
	private buildOrbitServer(sdk: OrbitSdkModule): unknown {
		if (this.orbitServer) return this.orbitServer;
		const vaultWrite = sdk.tool(
			"vault_write",
			"Create or overwrite a note in the user's Obsidian vault. The change is previewed and must be approved by the user, then applied through Obsidian so the vault index stays in sync. Use this — not shell commands — to write notes.",
			{ path: z.string(), content: z.string() },
			async (args: Record<string, unknown>) => {
				const text = await this.applyVaultWrite(String(args.path ?? ""), String(args.content ?? ""));
				return { content: [{ type: "text" as const, text }] };
			},
		);
		this.orbitServer = sdk.createSdkMcpServer({ name: "orbit", version: "0.1.0", tools: [vaultWrite] });
		return this.orbitServer;
	}

	/** Render an approval card and resolve true/false when the user clicks. */
	private renderApprovalCard(
		container: HTMLElement,
		title: string,
		body: string,
		kind: "code" | "diff",
	): Promise<boolean> {
		return new Promise((resolve) => {
			const host = this.activeTurnHost ?? container;
			const card = host.createDiv({ cls: `orbit-approval orbit-approval-${kind}` });
			card.createDiv({ cls: "orbit-approval-title", text: `⏸ Approve — ${title}` });
			card.createEl("pre", { cls: "orbit-approval-body" }).setText(body);
			const row = card.createDiv({ cls: "orbit-approval-actions" });
			const approve = row.createEl("button", { cls: "mod-cta", text: "Approve" });
			const deny = row.createEl("button", { text: "Deny" });
			const decide = (v: boolean) => {
				approve.disabled = true;
				deny.disabled = true;
				card.addClass(v ? "is-approved" : "is-denied");
				row.createSpan({ cls: "orbit-approval-status", text: v ? "  ✓ approved" : "  ✕ denied" });
				resolve(v);
			};
			approve.addEventListener("click", () => decide(true));
			deny.addEventListener("click", () => decide(false));
			container.scrollTop = container.scrollHeight;
		});
	}

	/** The approval gate: reads auto-allow; code runs & note writes are gated; else denied. */
	private makeGate(container: HTMLElement) {
		return async (toolName: string, input: Record<string, unknown>) => {
			if (READ_TOOLS.includes(toolName)) return { behavior: "allow", updatedInput: input };
			if (SHELL_TOOLS.includes(toolName)) {
				const cmd = String(input.command ?? "");
				const ok = await this.renderApprovalCard(container, "Run command", cmd, "code");
				return ok
					? { behavior: "allow", updatedInput: input }
					: { behavior: "deny", message: "User denied running this command." };
			}
			if (toolName === ORBIT_WRITE_TOOL) {
				const path = String(input.path ?? "");
				const body = await this.buildWriteDiff(path, String(input.content ?? ""));
				const ok = await this.renderApprovalCard(container, `Write ${path}`, body, "diff");
				return ok
					? { behavior: "allow", updatedInput: input }
					: { behavior: "deny", message: "User denied the note write." };
			}
			return { behavior: "deny", message: `Orbit blocked ${toolName}.` };
		};
	}

	/**
	 * Who and where Orbit is. Without this the engine has no idea it's a panel
	 * inside an Obsidian vault, what the files are, or which of its usual
	 * abilities have been taken away — so it offers to do things it can't and
	 * treats personal notes like source code.
	 *
	 * Deliberately stable within a session (no date, no active note — those go
	 * in the user turn) so the cached system prefix isn't invalidated each turn.
	 */
	private orbitContext(mode: OrbitMode, vaultPath: string): string {
		const vaultName = this.app.vault.getName();
		const noteCount = this.app.vault.getMarkdownFiles().length;
		const scope = this.plugin.settings.scopeFolder.trim();
		const shell = process.platform === "win32" ? "PowerShell" : "Bash";

		const lines = [
			"# Orbit",
			"",
			"You are Orbit, running inside Obsidian as a panel in the user's right sidebar — not a terminal, not a browser, not a chat website. The user is reading you in a narrow (~350px) column beside their notes.",
			"",
			"## Where you are",
			`Obsidian vault "${vaultName}" — ${noteCount} markdown notes — at ${vaultPath}.`,
			scope
				? `You are scoped to the subfolder "${scope}"; you cannot see the rest of the vault.`
				: "You can see the whole vault.",
			`This machine is ${process.platform}; the shell tool here is called ${shell}.`,
			"",
			"## What these files are",
			"Personal notes, not a software project: Markdown with YAML frontmatter, [[wikilinks]] between notes, and #tags. Preserve frontmatter, and never break or rewrite a [[wikilink]] — the links are how the vault holds together. Refer to notes by vault-relative path (e.g. projects/Orbit/SPRINT.md), not absolute path.",
			"If the vault root has a CLAUDE.md, it holds the user's own context — read it when a question depends on who they are or what they're working on.",
			"",
			"## How to reply",
			"Your replies render as plain text in that narrow panel — Markdown is not rendered yet. Keep answers short and scannable. Avoid tables, deep nesting, and long code fences. A couple of sentences beats a report.",
			"",
			"## What you can and cannot do here",
			this.modeContract(mode, shell),
		];
		return lines.join("\n");
	}

	/** The per-mode capability contract — the part that changes between modes. */
	private modeContract(mode: OrbitMode, shell: string): string {
		if (mode === "chat") {
			return [
				"Mode: **Chat** (read-only).",
				"You have exactly three tools: Read, Grep, Glob. You cannot create, edit or delete notes, and you cannot run commands — those tools have been removed from you, not merely discouraged, so do not plan around them or claim you will use them.",
				"If the user asks for a change to their notes, say plainly that Chat is read-only and that the Code or Cowork tab can do it.",
			].join("\n");
		}
		if (mode === "code") {
			return [
				"Mode: **Code**.",
				`You can run shell commands with the ${shell} tool, and create or overwrite notes with the mcp__orbit__vault_write tool.`,
				"Both are approval-gated: the user sees the exact command, or the full file content, and must click Approve before anything happens. So nothing is done until the tool call actually returns — never report a change as complete before that. If the user denies a step, stop and ask; do not retry it or route around it.",
				"Always use vault_write for note changes — never shell redirection or a file-writing command — so Obsidian's index stays in sync.",
			].join("\n");
		}
		return [
			"Mode: **Cowork**.",
			"The user has already approved a plan you wrote. Carry it out step by step, and say which step you are on.",
			`Same gates as Code: every ${shell} command and every note write pauses for the user's approval, so nothing is done until the tool returns. If a step is denied, stop and ask rather than working around it.`,
			"Always use mcp__orbit__vault_write for note changes, never shell file writes.",
		].join("\n");
	}

	/** Claude Code's own prompt, plus Orbit's context appended. */
	private systemPrompt(mode: OrbitMode, vaultPath: string, extra?: string): Record<string, unknown> {
		const append = extra ? `${this.orbitContext(mode, vaultPath)}\n\n${extra}` : this.orbitContext(mode, vaultPath);
		return { type: "preset", preset: "claude_code", append };
	}

	/** Apply the settings "vault scope" folder to the engine cwd. */
	private scopedCwd(vaultPath: string): string {
		const scope = this.plugin.settings.scopeFolder.trim().replace(/^[/\\]+|[/\\]+$/g, "");
		return scope ? `${vaultPath}/${scope}` : vaultPath;
	}

	private baseOptions(mode: OrbitMode, vaultPath: string): Record<string, unknown> {
		const resume = this.sessions[mode];
		// Name the binary outright. Bundled into main.js, the SDK's own lookup
		// walks from the bundle's location and can't find its sibling package.
		const executable = claudeBinaryPath(pluginDir(this.plugin));
		return {
			model: this.plugin.settings.models[mode] || "sonnet",
			cwd: this.scopedCwd(vaultPath),
			...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
			permissionMode: "default",
			settingSources: [],
			includePartialMessages: true,
			...(resume ? { resume } : {}),
		};
	}

	private buildOptions(
		mode: OrbitMode,
		vaultPath: string,
		container: HTMLElement,
		sdk: OrbitSdkModule,
	): Record<string, unknown> {
		const base = this.baseOptions(mode, vaultPath);
		if (mode === "chat") {
			return {
				...base,
				maxTurns: 12,
				systemPrompt: this.systemPrompt("chat", vaultPath),
				tools: CHAT_TOOLS,
				allowedTools: CHAT_TOOLS,
				disallowedTools: CHAT_BLOCKED_TOOLS,
				canUseTool: async (toolName: string, input: Record<string, unknown>) =>
					READ_TOOLS.includes(toolName)
						? { behavior: "allow", updatedInput: input }
						: { behavior: "deny", message: `Orbit Chat is read-only; ${toolName} is blocked.` },
			};
		}
		// Code + Cowork execution: gated shell runs + gated Vault-API write; built-in writes removed.
		return {
			...base,
			maxTurns: 24,
			systemPrompt: this.systemPrompt(mode, vaultPath),
			tools: CODE_TOOLS,
			disallowedTools: WRITE_BLOCKED,
			mcpServers: { orbit: this.buildOrbitServer(sdk) },
			canUseTool: this.makeGate(container),
		};
	}

	/** Read-only "planning" options for Cowork's first phase. */
	private buildPlanOptions(vaultPath: string): Record<string, unknown> {
		return {
			...this.baseOptions("cowork", vaultPath),
			maxTurns: 8,
			tools: CHAT_TOOLS,
			allowedTools: CHAT_TOOLS,
			disallowedTools: CHAT_BLOCKED_TOOLS,
			// Planning is read-only, so it gets Chat's contract plus the planning task.
			systemPrompt: this.systemPrompt(
				"chat",
				vaultPath,
				[
					"## Right now: planning",
					"This is Orbit's planning step for a Cowork task. Explore with the read-only tools if you need to, then reply with ONLY a short numbered plan (3–7 steps) of exactly what you will do — which notes you will change and what you will run.",
					"Do not write anything or run anything yet. The user will approve this plan before you execute it, and every write and run will be approved separately after that. Keep it brief.",
				].join("\n"),
			),
			canUseTool: async (toolName: string, input: Record<string, unknown>) =>
				READ_TOOLS.includes(toolName)
					? { behavior: "allow", updatedInput: input }
					: { behavior: "deny", message: "Planning is read-only." },
		};
	}

	private addSystemLine(container: HTMLElement, text: string) {
		container.createDiv({ cls: "orbit-systemline", text });
		container.scrollTop = container.scrollHeight;
	}

	/** True only if the `claude` binary genuinely isn't next to the plugin. */
	private sdkMissing(): boolean {
		try {
			return claudeBinaryPath(pluginDir(this.plugin)) === null;
		} catch {
			return true;
		}
	}

	/**
	 * Errors render inline only — never as a Notice. A toast covers the user's
	 * notes and can't be re-read. The raw message always stays available.
	 */
	private renderError(container: HTMLElement, err: unknown) {
		console.error("[Orbit] engine error:", err);
		const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
		const msg = err instanceof Error ? err.message : String(err);
		// Only blame the install when the binary is genuinely absent — matching
		// on message text alone mislabels every error the SDK throws.
		const engineMissing = this.sdkMissing();

		const card = container.createDiv({ cls: "orbit-error" });
		card.createDiv({
			cls: "orbit-error-title",
			text: engineMissing ? "Engine not installed" : "Engine error",
		});
		card.createDiv({
			text: engineMissing
				? "Orbit couldn't find the `claude` binary next to the plugin. Open a terminal in <vault>/.obsidian/plugins/orbit and run: npm install"
				: msg,
		});

		const details = card.createEl("details");
		details.createEl("summary", { text: "Details" });
		details.createEl("pre").setText(raw);

		const copy = card.createEl("button", { cls: "orbit-error-copy", text: "Copy error" });
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(raw);
			copy.setText("Copied");
			window.setTimeout(() => copy.setText("Copy error"), 1500);
		});

		container.scrollTop = container.scrollHeight;
	}

	/** A plan-approval control (Approve & execute / Cancel). */
	private renderConfirm(container: HTMLElement, label: string): Promise<boolean> {
		return new Promise((resolve) => {
			const card = container.createDiv({ cls: "orbit-approval orbit-approval-plan" });
			card.createDiv({ cls: "orbit-approval-title", text: label });
			const row = card.createDiv({ cls: "orbit-approval-actions" });
			const yes = row.createEl("button", { cls: "mod-cta", text: "Approve plan & execute" });
			const no = row.createEl("button", { text: "Cancel" });
			const decide = (v: boolean) => {
				yes.disabled = true;
				no.disabled = true;
				card.addClass(v ? "is-approved" : "is-denied");
				row.createSpan({ cls: "orbit-approval-status", text: v ? "  ✓ approved" : "  ✕ cancelled" });
				resolve(v);
			};
			yes.addEventListener("click", () => decide(true));
			no.addEventListener("click", () => decide(false));
			container.scrollTop = container.scrollHeight;
		});
	}

	/** Run one engine turn, streaming into the panel. Returns the final text. */
	private async streamTurn(
		mode: OrbitMode,
		prompt: string,
		options: Record<string, unknown>,
		container: HTMLElement,
		vaultPath: string,
	): Promise<string> {
		const contextEl = container.createDiv({ cls: "orbit-context is-empty" });
		const turnEl = container.createDiv({ cls: "orbit-msg-group orbit-msg-group-assistant orbit-turn" });
		this.activeTurnHost = turnEl;
		let curBubble: HTMLElement | null = null;
		let curText = "";
		let produced = false;
		let fallbackResult = "";
		const turnParts: string[] = [];
		const reads = new Set<string>();
		const searches = new Set<string>();
		const bashCallIds = new Set<string>();

		const thinkingEl = container.createDiv({ cls: "orbit-thinking", text: "Claude is thinking…" });
		container.scrollTop = container.scrollHeight;

		// Ends the current text bubble, flushing its text into turnParts so
		// the turn's eventual copy button includes it.
		const resetBubble = () => {
			if (curText.trim()) turnParts.push(curText);
			curBubble = null;
			curText = "";
		};
		const appendText = (delta: string) => {
			thinkingEl.remove();
			if (!curBubble) {
				curBubble = this.addPlainBubble(turnEl, "assistant", "");
				curText = "";
			}
			curText += delta;
			curBubble.setText(curText);
			produced = true;
			container.scrollTop = container.scrollHeight;
		};

		try {
			for await (const msg of sdk.query({ prompt, options })) {
				// Stop: breaking the loop closes the iterator, which ends the SDK subprocess.
				if (this.cancel[mode]) break;
				if (msg.session_id) this.sessions[mode] = msg.session_id;

				if (msg.type === "stream_event" && msg.event?.type === "content_block_delta") {
					if (msg.event.delta?.type === "text_delta" && msg.event.delta.text) {
						appendText(msg.event.delta.text);
					}
				} else if (msg.type === "assistant" && msg.message?.content) {
					for (const b of msg.message.content) {
						if (b.type !== "tool_use") continue;
						resetBubble(); // a tool interaction ends the current text bubble
						const inp = b.input ?? {};
						if (b.name === "Read" && typeof inp.file_path === "string") {
							reads.add(this.toVaultRel(inp.file_path, vaultPath));
						} else if (b.name === "Grep" && typeof inp.pattern === "string") {
							searches.add(`"${inp.pattern}"`);
						} else if (b.name === "Glob" && typeof inp.pattern === "string") {
							searches.add(inp.pattern);
						} else if (b.name && SHELL_TOOLS.includes(b.name) && typeof b.id === "string") {
							bashCallIds.add(b.id);
						}
						this.renderContext(contextEl, reads, searches);
					}
				} else if (msg.type === "user" && msg.message?.content) {
					// Stream shell stdout/stderr into the panel as an output block.
					for (const b of msg.message.content) {
						if (b.type === "tool_result" && typeof b.tool_use_id === "string" && bashCallIds.has(b.tool_use_id)) {
							const out = toolResultText(b.content).trim();
							const shown = out || "(no output)";
							turnEl.createEl("pre", { cls: "orbit-output" }).setText(shown);
							turnParts.push(shown);
							produced = true;
							resetBubble();
							container.scrollTop = container.scrollHeight;
						}
					}
				} else if (msg.type === "result" && typeof msg.result === "string") {
					fallbackResult = msg.result;
				}
			}

			thinkingEl.remove();
			resetBubble(); // flush whatever text bubble was still in flight, even if cancelled
			if (this.cancel[mode]) {
				this.addSystemLine(container, "Stopped.");
			} else if (!produced) {
				const text = fallbackResult || "(no response)";
				this.addPlainBubble(turnEl, "assistant", text);
				turnParts.push(text);
			}
			this.renderContext(contextEl, reads, searches);
			if (turnParts.length > 0) {
				this.addCopyButton(turnEl, () => turnParts.join("\n\n"));
			}
			return fallbackResult;
		} finally {
			this.activeTurnHost = null;
		}
	}

	private async run(mode: OrbitMode, prompt: string, container: HTMLElement) {
		this.addBubble(container, "user", prompt);

		const vaultPath = this.plugin.getVaultPath();
		if (!vaultPath) {
			this.addBubble(container, "assistant", "Orbit is desktop-only — no local vault path is available.");
			return;
		}

		const activeFile = this.app.workspace.getActiveFile();
		const fullPrompt = activeFile
			? `(The user's currently active note is: ${activeFile.path})\n\n${prompt}`
			: prompt;

		this.cancel[mode] = false;
		this.setRunning(mode, true);
		try {
			await this.streamTurn(mode, fullPrompt, this.buildOptions(mode, vaultPath, container, sdk), container, vaultPath);
		} catch (err) {
			this.renderError(container, err);
		} finally {
			this.setRunning(mode, false);
			this.cancel[mode] = false;
			container.scrollTop = container.scrollHeight;
		}
	}

	/** Cowork: plan (read-only) → approve the plan → execute step by step (gated). */
	private async runCowork(prompt: string, container: HTMLElement) {
		this.addBubble(container, "user", prompt);

		const vaultPath = this.plugin.getVaultPath();
		if (!vaultPath) {
			this.addBubble(container, "assistant", "Orbit is desktop-only — no local vault path is available.");
			return;
		}

		this.cancel.cowork = false;
		this.setRunning("cowork", true);
		try {
			const activeFile = this.app.workspace.getActiveFile();
			const planPrompt = (activeFile ? `(Active note: ${activeFile.path})\n\n` : "") + `Task:\n${prompt}`;

			this.addSystemLine(container, "① Planning (read-only)…");
			await this.streamTurn("cowork", planPrompt, this.buildPlanOptions(vaultPath), container, vaultPath);
			if (this.cancel.cowork) return; // stopped during planning — don't offer the plan

			const ok = await this.renderConfirm(container, "⏸ Approve the plan above to execute?");
			if (!ok) {
				this.addSystemLine(container, "Cancelled — nothing was changed.");
				return;
			}

			this.cancel.cowork = false; // fresh stop budget for the execution phase
			this.addSystemLine(container, "② Executing — each note write & code run needs approval…");
			await this.streamTurn(
				"cowork",
				"The user approved your plan. Carry it out now, step by step. Use the vault_write tool for any note changes and the shell tool for any code — you will be asked to approve each write and run.",
				this.buildOptions("cowork", vaultPath, container, sdk),
				container,
				vaultPath,
			);
		} catch (err) {
			this.renderError(container, err);
		} finally {
			this.setRunning("cowork", false);
			this.cancel.cowork = false;
			container.scrollTop = container.scrollHeight;
		}
	}
}

class OrbitSettingTab extends PluginSettingTab {
	private plugin: OrbitPlugin;

	constructor(app: OrbitPlugin["app"], plugin: OrbitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h3", { text: "Orbit" });
		containerEl.createEl("p", {
			text: "Orbit runs on your existing Claude login — no API key. Desktop only.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Default mode")
			.setDesc("Which tab opens first.")
			.addDropdown((d) =>
				d
					.addOptions({ chat: "Chat", code: "Code", cowork: "Cowork" })
					.setValue(this.plugin.settings.defaultMode)
					.onChange(async (v) => {
						this.plugin.settings.defaultMode = v as OrbitMode;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h4", { text: "Models" });
		containerEl.createEl("p", {
			text: "One per mode — also switchable from the panel. Availability depends on your Claude plan tier (Opus needs Max); the engine falls back to Sonnet if a model isn't available to you.",
			cls: "setting-item-description",
		});

		const modeDescs: Record<OrbitMode, string> = {
			chat: "Read-only Q&A about your notes.",
			code: "Writes and runs code — approve each run.",
			cowork: "Multi-step tasks — plans first, then gated edits.",
		};
		for (const mode of ["chat", "code", "cowork"] as OrbitMode[]) {
			new Setting(containerEl)
				.setName(mode.charAt(0).toUpperCase() + mode.slice(1))
				.setDesc(modeDescs[mode])
				.addDropdown((d) =>
					d
						.addOptions(ORBIT_MODELS)
						.setValue(this.plugin.settings.models[mode])
						.onChange(async (v) => {
							this.plugin.settings.models[mode] = v;
							await this.plugin.saveSettings();
							// Panel pickers are rebuilt from settings when the view reopens;
							// refresh any that are live right now.
							this.plugin.refreshModelSelects();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Vault scope")
			.setDesc("Limit the engine to a folder (vault-relative). Leave empty for the whole vault.")
			.addText((t) =>
				t
					.setPlaceholder("e.g. projects/Orbit")
					.setValue(this.plugin.settings.scopeFolder)
					.onChange(async (v) => {
						this.plugin.settings.scopeFolder = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		const about = containerEl.createDiv({ cls: "orbit-about" });
		about.createDiv({
			cls: "orbit-about-line",
			text: `Orbit v${this.plugin.manifest.version} — made by ${this.plugin.manifest.author}`,
		});
		about.createDiv({
			cls: "orbit-about-line is-faint",
			text: "Orbit is an independent plugin. Claude is a product of Anthropic; Orbit is not affiliated with or endorsed by Anthropic.",
		});
	}
}
