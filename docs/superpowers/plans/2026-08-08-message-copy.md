# Message Copy Affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hover-revealed copy buttons to user and assistant messages in Orbit's chat panels, plus a text-select cursor, so users can copy prompts and responses the way Claude.ai/ChatGPT do.

**Architecture:** Wrap each message (or, for an assistant turn, everything that turn produces) in a new `.orbit-msg-group` div. A shared `addCopyButton` helper renders a hover-revealed icon button inside the group that copies a supplied string via `navigator.clipboard.writeText`. User messages get one group+button per `addBubble` call. Assistant turns (`streamTurn`) get one group+button for the whole turn, built from a `turnParts` array that collects each text bubble and tool-output block as it finalizes.

**Tech Stack:** TypeScript (`main.ts`), Obsidian API (`setIcon`), plain CSS (`styles.css`). No test framework exists in this plugin (single-file Obsidian plugin, no Jest/etc. configured) — verification is `tsc --noEmit`, an `esbuild` dev build, and manual functional checks in Obsidian, not automated unit tests. Do not add a test framework as part of this work; that would be disproportionate to a two-file UI change.

## Global Constraints

- Single-file plugin: all logic in `main.ts`, all styling in `styles.css` — do not create new files.
- No `user-select` CSS exists anywhere and must not be added (messages are already selectable by default; don't break that).
- Copy behavior must apply uniformly to Chat, Code, and Cowork — all three funnel through `addBubble` and `streamTurn`.
- The "which notes Claude looked at" context line and system status lines (`Planning…`, `Stopped.`, `Cancelled…`) stay outside any `.orbit-msg-group` and are never included in copied text.
- No toast/Notice on copy — feedback is the icon swapping to a checkmark for ~1.2s.
- Follow existing code style: tabs for indentation in `main.ts` (matches surrounding code), two-space indentation in `styles.css`.

---

### Task 1: Shared copy-button helper + user message copy

**Files:**
- Modify: `main.ts:1-10` (import), `main.ts:533-538` (`addBubble`)
- Modify: `styles.css:225-262` (`.orbit-messages`, `.orbit-bubble`, `.orbit-user`, `.orbit-assistant` block)

**Interfaces:**
- Produces: `private addCopyButton(group: HTMLElement, getText: () => string): void` — appends a hover-revealed copy button to `group`; clicking it copies `getText()` to the clipboard and briefly shows a checkmark. Used by Task 2.
- Produces: `private addPlainBubble(container: HTMLElement, role: "user" | "assistant", text: string): HTMLElement` — creates a bare `.orbit-bubble.orbit-{role}` div with no group/button wrapper, appended to `container`. Used by Task 2.
- Produces: CSS classes `.orbit-msg-group`, `.orbit-msg-group-user`, `.orbit-msg-group-assistant`, `.orbit-copy-btn` — reused by Task 2's turn wrapper.

There is no existing automated test suite for this plugin, so "tests" below are manual verification steps run against a real Obsidian vault plus TypeScript's own type checking as a correctness gate.

- [ ] **Step 1: Add the `setIcon` import**

In `main.ts`, the import block currently reads:

```ts
import {
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	FileSystemAdapter,
	TFile,
	normalizePath,
} from "obsidian";
```

Change it to:

```ts
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
```

- [ ] **Step 2: Run the type checker to confirm the import resolves**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors (the unused-import isn't flagged yet since `strict` doesn't include `noUnusedLocals`; it will be used by Step 3 anyway).

- [ ] **Step 3: Replace `addBubble` with `addBubble` + `addPlainBubble` + `addCopyButton`**

Find in `main.ts`:

```ts
	private addBubble(container: HTMLElement, role: "user" | "assistant", text: string): HTMLElement {
		const bubble = container.createDiv({ cls: `orbit-bubble orbit-${role}` });
		bubble.setText(text);
		container.scrollTop = container.scrollHeight;
		return bubble;
	}
```

Replace with:

```ts
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
```

- [ ] **Step 4: Update CSS for the new wrapper structure**

Find in `styles.css`:

```css
.orbit-bubble {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  font-size: 14px;
}

/* Your message: a quiet bubble, not a saturated block. */
.orbit-user {
  align-self: flex-end;
  max-width: 85%;
  padding: 8px 12px;
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  border-radius: var(--orbit-radius) var(--orbit-radius) 4px var(--orbit-radius);
}

/* Replies are full-width plain text — far more readable than a bubble
   in a ~350px sidebar, and it's what Claude's own UI does. */
.orbit-assistant {
  align-self: stretch;
  max-width: 100%;
  background: none;
  color: var(--text-normal);
  padding: 0 2px;
}
```

Replace with:

```css
.orbit-bubble {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  font-size: 14px;
  cursor: text;
}

/* Wraps one message (or one whole assistant turn) plus its hover-revealed
   copy button. Alignment/width moved here from the bubble classes below
   since the bubble is no longer a direct flex child of .orbit-messages. */
.orbit-msg-group {
  display: flex;
  flex-direction: column;
}

.orbit-msg-group-user {
  align-self: flex-end;
  align-items: flex-end;
  max-width: 85%;
}

.orbit-msg-group-assistant {
  align-self: stretch;
  align-items: flex-start;
  max-width: 100%;
}

/* Your message: a quiet bubble, not a saturated block. */
.orbit-user {
  padding: 8px 12px;
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  border-radius: var(--orbit-radius) var(--orbit-radius) 4px var(--orbit-radius);
}

/* Replies are full-width plain text — far more readable than a bubble
   in a ~350px sidebar, and it's what Claude's own UI does. */
.orbit-assistant {
  background: none;
  color: var(--text-normal);
  padding: 0 2px;
}

.orbit-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: 2px;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-muted);
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.12s ease;
}

.orbit-msg-group:hover .orbit-copy-btn {
  opacity: 0.7;
}

.orbit-copy-btn:hover {
  opacity: 1 !important;
  color: var(--text-normal);
}

.orbit-copy-btn.is-copied {
  opacity: 1 !important;
  color: var(--text-normal);
}

.orbit-copy-btn svg {
  width: 14px;
  height: 14px;
}
```

- [ ] **Step 5: Run the type checker again**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Build the plugin**

Run: `npm run build`
Expected: exits 0, `main.js` is regenerated.

- [ ] **Step 7: Manually verify user-message copy in Obsidian**

1. If Orbit isn't already loaded as a plugin in the target vault, ensure `main.js`, `manifest.json`, `styles.css` are in `<vault>/.obsidian/plugins/orbit/` (they already are, since this repo IS that plugin folder) and reload Obsidian (Ctrl+R) or disable/re-enable the Orbit plugin in Settings → Community plugins to pick up the new build.
2. Open the Orbit panel, switch to any mode, type a message and send it.
3. Hover over your own sent message: confirm a small copy icon fades in below it, right-aligned under the bubble, and the mouse cursor over the message text itself is an I-beam (text-select) cursor.
4. Click the copy icon: confirm it swaps to a checkmark for about a second, then reverts to the copy icon.
5. Paste (Ctrl+V) into a scratch note: confirm the pasted text exactly matches what you typed.

- [ ] **Step 8: Commit**

```bash
git add main.ts styles.css
git commit -m "$(cat <<'EOF'
Add hover copy button and text cursor to user messages

Wraps each message bubble in an .orbit-msg-group with a hover-revealed
copy button (shared addCopyButton helper), and adds a text-select
cursor over message bubbles so it's clear they're selectable.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Assistant turn copy button

**Files:**
- Modify: `main.ts:889-973` (`streamTurn`)

**Interfaces:**
- Consumes: `addCopyButton(group: HTMLElement, getText: () => string): void` and `addPlainBubble(container: HTMLElement, role: "user" | "assistant", text: string): HTMLElement` from Task 1.
- Consumes: CSS classes `.orbit-msg-group`, `.orbit-msg-group-assistant`, `.orbit-copy-btn` from Task 1 (no new CSS needed — `orbit-turn` below is a marker class with no styling of its own, kept for readability/future hooks).

- [ ] **Step 1: Wrap the turn in a group and collect `turnParts`**

Find in `main.ts` (`streamTurn`):

```ts
		const contextEl = container.createDiv({ cls: "orbit-context is-empty" });
		let curBubble: HTMLElement | null = null;
		let curText = "";
		let produced = false;
		let fallbackResult = "";
		const reads = new Set<string>();
		const searches = new Set<string>();
		const bashCallIds = new Set<string>();

		const thinkingEl = container.createDiv({ cls: "orbit-thinking", text: "Claude is thinking…" });
		container.scrollTop = container.scrollHeight;

		const resetBubble = () => {
			curBubble = null;
			curText = "";
		};
		const appendText = (delta: string) => {
			thinkingEl.remove();
			if (!curBubble) {
				curBubble = this.addBubble(container, "assistant", "");
				curText = "";
			}
			curText += delta;
			curBubble.setText(curText);
			produced = true;
			container.scrollTop = container.scrollHeight;
		};
```

Replace with:

```ts
		const contextEl = container.createDiv({ cls: "orbit-context is-empty" });
		const turnEl = container.createDiv({ cls: "orbit-msg-group orbit-msg-group-assistant orbit-turn" });
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
```

- [ ] **Step 2: Route tool-output blocks into `turnEl` and push them onto `turnParts`**

Find:

```ts
			} else if (msg.type === "user" && msg.message?.content) {
				// Stream shell stdout/stderr into the panel as an output block.
				for (const b of msg.message.content) {
					if (b.type === "tool_result" && typeof b.tool_use_id === "string" && bashCallIds.has(b.tool_use_id)) {
						const out = toolResultText(b.content).trim();
						container.createEl("pre", { cls: "orbit-output" }).setText(out || "(no output)");
						produced = true;
						resetBubble();
						container.scrollTop = container.scrollHeight;
					}
				}
			} else if (msg.type === "result" && typeof msg.result === "string") {
```

Replace with:

```ts
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
```

- [ ] **Step 3: Finalize the turn — flush the last bubble, add the fallback into `turnEl`, and attach one copy button**

Find:

```ts
		thinkingEl.remove();
		if (this.cancel[mode]) {
			this.addSystemLine(container, "Stopped.");
		} else if (!produced) {
			this.addBubble(container, "assistant", fallbackResult || "(no response)");
		}
		this.renderContext(contextEl, reads, searches);
		return fallbackResult;
	}
```

Replace with:

```ts
		thinkingEl.remove();
		if (this.cancel[mode]) {
			this.addSystemLine(container, "Stopped.");
		} else if (!produced) {
			const text = fallbackResult || "(no response)";
			this.addPlainBubble(turnEl, "assistant", text);
			turnParts.push(text);
		} else {
			resetBubble(); // flush whatever text bubble was still in flight
		}
		this.renderContext(contextEl, reads, searches);
		if (turnParts.length > 0) {
			this.addCopyButton(turnEl, () => turnParts.join("\n\n"));
		}
		return fallbackResult;
	}
```

- [ ] **Step 4: Run the type checker**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Build the plugin**

Run: `npm run build`
Expected: exits 0, `main.js` is regenerated.

- [ ] **Step 6: Manually verify assistant-turn copy in Obsidian**

Reload/re-enable the Orbit plugin as in Task 1 Step 7.1, then:

1. **Simple turn:** In Chat, ask a question that doesn't require tools (e.g. "reply with just the word hello"). Hover the reply: confirm one copy icon appears below the whole reply. Click it, paste into a scratch note, confirm the pasted text matches the reply exactly.
2. **Tool-heavy turn:** Ask something that makes Claude read a note or search the vault (e.g. "search the vault for the word Orbit and summarize what you find"). Confirm the turn may render as multiple bubbles/output blocks, but only **one** copy button appears for the whole turn (below the last piece). Click it and paste: confirm the pasted text contains all the prose bubbles (and any shell output, if a shell tool ran) joined with blank lines, in the order shown in the panel — and does not include the "📄 read / 🔎 searched" context line or any `Stopped.`/`Planning…` status lines.
3. **Cowork:** Switch to Cowork mode, submit a task, and once the plan is shown, confirm the plan turn has its own copy button independent of the (not-yet-rendered) execution turn. Approve the plan and confirm the execution phase gets its own separate copy button once it completes.
4. **Cancelled turn:** Start a turn and click Stop before any text streams in. Confirm no copy button appears (nothing was produced to copy).

- [ ] **Step 7: Commit**

```bash
git add main.ts
git commit -m "$(cat <<'EOF'
Add single copy button per assistant turn

Wraps everything one streamTurn call produces (text bubbles, tool
output blocks, and the no-response fallback) in one .orbit-msg-group,
tracking finalized text in turnParts so a single copy button at the
end of the turn reproduces the whole response.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final push

After both tasks are committed, push the branch to GitHub:

```bash
git push
```
