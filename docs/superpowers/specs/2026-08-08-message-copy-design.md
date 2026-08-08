# Message copy affordance — design

Date: 2026-08-08

## Problem

Orbit's chat panels (Chat, Code, Cowork) render messages as plain-text bubbles with no way to copy them other than manual drag-select, and no visual cue that the text is selectable. Users want the same copy experience as Claude.ai/ChatGPT: hover a message to reveal a copy button, plus an obvious text-select cursor when hovering message text.

## Current state

- Single-file plugin: all logic lives in `main.ts` (~1130 lines), styling in `styles.css`.
- `addBubble(container, role, text)` (main.ts:533) creates one `.orbit-bubble.orbit-{role}` div and appends it directly to the messages container. Used for user prompts and for one-shot assistant fallback messages (e.g. "Orbit is desktop-only…").
- `streamTurn(...)` (main.ts:889) drives one assistant turn: it streams text deltas into a growing bubble via `appendText`, and resets to a new bubble whenever a tool call interrupts the text (`resetBubble`) or when shell output is rendered into a separate `<pre class="orbit-output">` block. A single turn can therefore end up as several sibling elements in the DOM (multiple text bubbles + output blocks), all appended straight into the shared `.orbit-messages` scroll container — there's no wrapper grouping "everything this turn produced."
- `run()` calls `streamTurn` once per user message (Chat/Code). `runCowork()` calls it twice per user message — once for the read-only plan, once for execution — so a cowork "turn" is naturally two separate `streamTurn` invocations.
- No `user-select` rules exist anywhere in `styles.css`, so message text is already selectable by default; there's just no visual/interactive affordance advertising it.
- Obsidian's `setIcon` helper (lucide icons) is not yet used anywhere in the plugin.

## Design

### Selection affordance

Add `cursor: text` to `.orbit-bubble` and `.orbit-output` in `styles.css`. No JS change — this only fixes the hover cursor so it reads as selectable text instead of inheriting a pointer/default cursor from ancestor rules.

### Copy buttons

A small hover-revealed copy icon (Obsidian's `copy` lucide icon via `setIcon`) appears below each **message group**:

- **User messages** — `addBubble` is changed to wrap its bubble in a `.orbit-msg-group` div together with a copy button positioned below the bubble (opacity 0 → 1 on `.orbit-msg-group:hover`). Clicking copies exactly the prompt text passed to `addBubble`.
- **Assistant turns** — `streamTurn` creates one `.orbit-msg-group.orbit-turn` wrapper at the start of each invocation. Everything the turn produces (streamed text bubbles, tool-output `<pre>` blocks, and the "no response" fallback bubble) is appended inside this wrapper instead of directly into the messages container. As each piece finalizes (a bubble is reset by a tool call, an output block is rendered, or the turn ends), its text is pushed onto a local `turnParts: string[]`. After the turn completes, if `turnParts` is non-empty, one copy button is appended at the end of the wrapper; clicking it copies `turnParts.join("\n\n")` — the full turn, in order, as seen in the panel.
- The "which notes Claude looked at" context line and system status lines (`Planning…`, `Stopped.`, `Cancelled…`) are rendered *outside* the turn's `.orbit-msg-group`, same as today — they're metadata/status, not response content, and stay out of the copied text.
- If a turn is cancelled before producing anything, `turnParts` stays empty and no button is rendered.
- Cowork's plan phase and execution phase are two separate `streamTurn` calls, so each gets its own independent copy button — consistent with them being two distinct responses in the transcript.

### Click feedback

On click: write to clipboard via `navigator.clipboard.writeText(text)`, then swap the icon to a checkmark (`setIcon(btn, "check")`) for ~1.2s before reverting to `copy`. No toast/notice needed — the icon swap is the confirmation.

## Scope

Changes are confined to:
- `main.ts`: `addBubble`, `streamTurn`, plus the new `setIcon` import.
- `styles.css`: `.orbit-msg-group`, `.orbit-copy-btn`, hover-reveal rules, `cursor: text` additions.

No changes to Cowork's approval-card flow, session handling, or the SDK integration.

## Out of scope

- Markdown rendering of assistant text (bubbles remain plain `setText` — copy grabs exactly what's rendered, since there's no formatting to lose yet).
- Per-sub-bubble copy buttons within a single turn (only one button per turn, per user approval).
- Copying tool-call announcements themselves (only their text/output results are included, matching what's already visible).
