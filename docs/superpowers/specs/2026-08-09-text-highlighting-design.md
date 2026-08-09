# Text highlighting — design

Date: 2026-08-09

## Problem

Message text in Orbit's chat panels (Chat, Code, Cowork) is selectable but there's no way to mark a passage as important for later reference within the session. Users want a lightweight "highlighter" — select text, mark it, and have it stay visually marked for the rest of the session.

## Current state

- Copy buttons already exist per-message (user) and per-turn (assistant) — see `docs/superpowers/specs/2026-08-08-message-copy-design.md`. Not touched by this change.
- Chat history is not persisted to disk — `main.ts` only calls `loadData`/`saveData` for plugin settings (`main.ts:157,169`). Messages live only in the DOM for the current session; closing/reloading the panel clears them.
- No selection or highlight code exists anywhere in `main.ts` or `styles.css` — this is new.
- Bubbles (`.orbit-bubble`) render plain text via `setText`, not innerHTML/markdown — so wrapping a substring in a `<mark>` requires splitting the existing text node rather than string-replacing rendered HTML.

## Design

### Interaction flow

1. User selects text with the mouse inside any `.orbit-bubble` (user or assistant).
2. On `mouseup`, if the selection is non-empty and fully contained within a single bubble, show a small floating pill button ("Highlight", using Obsidian's `highlighter` or `pen` lucide icon via `setIcon`) positioned just above the selection's bounding rect.
3. Clicking the pill wraps the selected `Range` in a `<mark class="orbit-highlight">` element (using `Range.surroundContents`, with a fallback that extracts and re-wraps contents if the range spans multiple text nodes within the bubble) and hides the pill.
4. Clicking anywhere else (mouseup with an empty/collapsed selection, or scroll) hides the pill without acting.
5. Clicking an existing `<mark class="orbit-highlight">` removes the highlight (unwraps the mark, merging its text back into the surrounding node) — no confirmation needed, it's a one-click toggle in both directions.

### Constraints on selection

- Selections that cross bubble boundaries (e.g. dragging from one message into the next) do not show the pill — highlighting is scoped to a single bubble's content to keep the DOM surgery simple and avoid corrupting multiple bubbles' text nodes.
- Overlapping highlights (selecting text that partially overlaps an existing `<mark>`) are not specially handled in v1 — `surroundContents` will throw on a partially-overlapping range in that case, so the pill is simply not shown when the selection intersects an existing mark. Fully re-selecting and re-highlighting a bigger span is out of scope.

### Visual style

- `.orbit-highlight`: background `var(--text-highlight-bg)` if Obsidian exposes it, else a fixed soft-yellow (`rgba(255, 220, 0, 0.35)`), no border, `cursor: pointer` (to signal it's clickable to un-highlight), rounded via `border-radius: 2px`.
- Floating pill: small rounded button, same visual language as `.orbit-copy-btn` (reuses `--orbit-radius`, `--background-modifier-hover` etc.), positioned with `position: fixed` using the selection range's `getBoundingClientRect()`.

### Lifecycle / persistence

- Highlights are pure DOM state, matching how messages themselves are already unpersisted. No saving to disk, no new plugin settings. Reloading Obsidian or closing the chat panel clears highlights along with the rest of the transcript — consistent with current behavior for messages themselves.
- No interaction with the copy buttons: copying a message copies its plain text (`textContent`), so highlighted spans copy as normal text with no markup — matches existing copy behavior which already strips all formatting.

### Click feedback

None needed beyond the immediate visual change (mark appears/disappears) — no toast, no icon-swap animation, matching the "no confirmation dialog" pattern in the existing copy-button work.

## Scope

Changes are confined to:
- `main.ts`: new selection-handling logic (mouseup listener scoped to the messages container, pill creation/positioning, highlight/un-highlight DOM surgery), plus the new `setIcon` icon name if not already imported (it already is, from the copy-button work).
- `styles.css`: `.orbit-highlight`, `.orbit-highlight-pill` (or similar) and its positioning/visibility rules.

No changes to `addBubble`, `streamTurn`, the copy-button code, Cowork's approval flow, or session/SDK handling.

## Out of scope

- Persisting highlights across reloads (chat history itself isn't persisted, so this would require a larger, separate change to add message persistence first).
- Multiple highlight colors — one color, matching a basic "highlighter" mental model.
- Highlighting across multiple bubbles/messages in one action.
- Extending/merging overlapping highlights — re-highlighting over an existing mark is not supported in v1.
