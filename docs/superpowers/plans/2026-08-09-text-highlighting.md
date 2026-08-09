# Text Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select text inside any chat bubble (Chat/Code/Cowork panels), click a floating "Highlight" pill to mark it, and click a highlighted span again to un-highlight it.

**Architecture:** A single `mouseup` listener on each panel's `.orbit-messages` container detects selections inside `.orbit-bubble` elements, positions a floating pill button via the selection's bounding rect, and on click wraps the `Range` in a `<mark class="orbit-highlight">`. A separate `click` listener (delegated on the same container) detects clicks on `.orbit-highlight` marks and unwraps them. No new files — this plugin is single-file (`main.ts` + `styles.css`), following the existing pattern from the copy-button feature.

**Tech Stack:** TypeScript, Obsidian Plugin API (`setIcon`), vanilla DOM `Selection`/`Range` APIs. No test framework exists in this repo (`package.json` has no test script) — verification is manual, by loading the plugin in Obsidian, matching how the existing copy-button feature was verified.

## Global Constraints

- Highlights are in-memory DOM state only — no persistence to disk (spec: "Persistence / lifecycle"). Do not add any `saveData`/`localStorage` calls.
- Highlighting is scoped to a single `.orbit-bubble` — selections crossing bubble boundaries must not show the pill (spec: "Constraints on selection").
- One highlight color only, no color picker (spec: "Out of scope").
- Copy buttons must keep copying plain text unaffected by highlight markup (spec: "Lifecycle / persistence") — since copy already uses the original `text` string / `textContent`, not `innerHTML`, this should already hold; Task 3 includes a manual check.
- Selections that intersect an existing `.orbit-highlight` must not show the pill (spec: "Constraints on selection") — avoids `Range.surroundContents` throwing on partially-overlapping ranges.

---

### Task 1: Highlight pill — show/hide on selection

**Files:**
- Modify: `main.ts` — add a new private method `attachHighlighting(messagesEl: HTMLElement)` near `addCopyButton` (main.ts:551-564), and call it once from `renderConversation` (main.ts:467-534) right after `messagesEl` is created (main.ts:480).
- Modify: `styles.css` — add `.orbit-highlight-pill` rules after the `.orbit-copy-btn` block (styles.css:281-314).

**Interfaces:**
- Produces: `attachHighlighting(messagesEl: HTMLElement): void` — call once per panel, wires up all selection/highlight behavior for that panel's message list for its lifetime. Idempotent per element (only ever called once, at panel creation).
- Consumes: Obsidian's `setIcon` (already imported in `main.ts`, used by `addCopyButton`).

This task builds the pill's show/hide logic only — clicking it (the actual highlight action) is Task 2.

- [ ] **Step 1: Add the pill element and positioning helper**

Add this method to the plugin class, near `addCopyButton`:

```typescript
/** Wires up select-to-highlight for one panel's message list. */
private attachHighlighting(messagesEl: HTMLElement) {
	const pill = messagesEl.createEl("button", {
		cls: "orbit-highlight-pill",
		attr: { "aria-label": "Highlight" },
	});
	setIcon(pill, "highlighter");
	pill.style.display = "none";

	const hidePill = () => {
		pill.style.display = "none";
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

		showPillFor(range);
	});

	messagesEl.addEventListener("scroll", hidePill);
}
```

- [ ] **Step 2: Call it from `renderConversation`**

In `renderConversation`, right after `const messagesEl = wrap.createDiv({ cls: "orbit-messages" });` (main.ts:480), add:

```typescript
this.attachHighlighting(messagesEl);
```

- [ ] **Step 3: Add pill styling**

In `styles.css`, after the `.orbit-copy-btn svg` block (ends around styles.css:314), add:

```css
.orbit-highlight-pill {
  position: absolute;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--orbit-radius);
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  cursor: pointer;
  box-shadow: var(--shadow-s, 0 1px 4px rgba(0, 0, 0, 0.2));
}

.orbit-highlight-pill:hover {
  background: var(--background-modifier-border);
}

.orbit-highlight-pill svg {
  width: 14px;
  height: 14px;
}
```

Also add `position: relative;` to the existing `.orbit-messages` rule (styles.css:225-235, the block containing `overflow-y: auto`) so the pill's `position: absolute` is relative to the messages container, not the page.

- [ ] **Step 4: Manual verification**

Run `npm run dev` (starts esbuild watch), reload the plugin in Obsidian (Settings → Community plugins → toggle Orbit off/on, or `Ctrl+R` for full reload), open the Chat panel, send a message, and once a reply appears:
- Select a few words inside your own message bubble → pill should appear just above the selection.
- Select a few words inside Claude's reply → pill should appear.
- Click elsewhere (collapsing the selection) → pill should disappear.
- Select text spanning from your message into Claude's reply (drag across the boundary) → pill should NOT appear (selection's common ancestor bubble check fails).
- Scroll the message list while a selection is active → pill should disappear.

Expected: all five behaviors match. Note results before moving to Task 2 — this task has no automated test, so this manual pass is the acceptance gate.

- [ ] **Step 5: Commit**

```bash
git add main.ts styles.css
git commit -m "Add floating highlight pill on text selection"
```

---

### Task 2: Apply highlight on pill click

**Files:**
- Modify: `main.ts` — extend `attachHighlighting` from Task 1 with the pill's click handler.
- Modify: `styles.css` — add `.orbit-highlight` mark styling.

**Interfaces:**
- Consumes: `pill`, `hidePill`, the `range` computed in Task 1's `mouseup` handler — Task 2 needs the last-computed `Range` available when the pill is clicked, so the `mouseup` handler must stash it (e.g. `let activeRange: Range | null = null;` at the top of `attachHighlighting`, set alongside each `showPillFor(range)` call, cleared in `hidePill`).
- Produces: `<mark class="orbit-highlight">` elements inside bubbles — Task 3's unhighlight logic queries for this exact class.

- [ ] **Step 1: Track the active range and wire the pill's click**

In `attachHighlighting`, add `let activeRange: Range | null = null;` right after the `pill` is created. Update `hidePill` to also clear it:

```typescript
const hidePill = () => {
	pill.style.display = "none";
	activeRange = null;
};
```

In the `mouseup` handler, right before the final `showPillFor(range);` call, add `activeRange = range;`.

Then, after the `mouseup` listener block, add:

```typescript
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
```

- [ ] **Step 2: Add highlight styling**

In `styles.css`, after the `.orbit-highlight-pill svg` block, add:

```css
.orbit-highlight {
  background: var(--text-highlight-bg, rgba(255, 208, 0, 0.35));
  color: inherit;
  border-radius: 2px;
  cursor: pointer;
}
```

- [ ] **Step 3: Manual verification**

With `npm run dev` still running, reload the plugin in Obsidian:
- Select text in a message, click the pill → the selected text should now have a yellow highlight background and the pill should disappear.
- Highlight a span, then use the message's existing copy button → pasted text should be plain (no visible markup, no extra characters) — confirms copy is unaffected (Global Constraints).
- Try selecting text that includes part of an already-highlighted span → pill should not appear (per Task 1's intersection check).

Expected: all three match. This is the acceptance gate for Task 2.

- [ ] **Step 4: Commit**

```bash
git add main.ts styles.css
git commit -m "Apply highlight mark on pill click"
```

---

### Task 3: Un-highlight on click

**Files:**
- Modify: `main.ts` — add a delegated `click` listener on `messagesEl` for `.orbit-highlight` elements, inside `attachHighlighting`.

**Interfaces:**
- Consumes: `.orbit-highlight` elements produced by Task 2.
- Produces: nothing new consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Add the unhighlight click handler**

In `attachHighlighting`, after the `pill.addEventListener("click", ...)` block from Task 2, add:

```typescript
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
```

- [ ] **Step 2: Manual verification**

With `npm run dev` still running, reload the plugin in Obsidian:
- Highlight a span of text, then click directly on the highlighted (yellow) text → the highlight should disappear and the text should read exactly as it did before highlighting (no extra spaces, no lost characters).
- Highlight two separate spans in the same bubble, un-highlight one → the other should remain highlighted and unaffected.
- Highlight a span, reload the Obsidian window (`Ctrl+R`) → chat history clears entirely (existing behavior, unrelated to this feature) — confirms no persistence was accidentally added.

Expected: all three match. This is the acceptance gate for Task 3 and for the feature as a whole.

- [ ] **Step 3: Commit**

```bash
git add main.ts
git commit -m "Add click-to-remove for highlighted text"
```

---

### Task 4: Push branch and open PR

**Files:** none (git/GitHub operations only).

- [ ] **Step 1: Push the feature branch**

```bash
git checkout -b text-highlighting
git push -u origin text-highlighting
```

(If already on a branch other than `main` from earlier work in this session, confirm branch name before pushing.)

- [ ] **Step 2: Open a pull request**

```bash
gh pr create --title "Add text highlighting to chat messages" --body "$(cat <<'EOF'
## Summary
- Select text in any chat bubble to reveal a floating highlight pill
- Click the pill to mark the selection with a highlight
- Click a highlighted span to remove the highlight
- Highlights are in-memory only, matching existing (unpersisted) chat history

## Test plan
- [x] Manual verification per docs/superpowers/plans/2026-08-09-text-highlighting.md (Tasks 1-3 verification steps)
- [ ] Reviewer: load the branch in Obsidian and repeat the manual checks above

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL back to the user**

---
