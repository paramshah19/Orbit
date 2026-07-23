# Orbit

Claude **Chat**, **Code**, and **Cowork** inside Obsidian — powered by your **existing Claude plan**, no API key.

Orbit embeds the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (Claude Code as a library) and authenticates with the `claude` login already on your machine. There is nothing to paste — if you use Claude Code, you're set.

> **Status:** MVP in development. Desktop only.

## Requirements

- **Obsidian desktop.** Orbit is `isDesktopOnly` — it needs Node/Electron, so it can't run on mobile.
- **[Claude Code](https://code.claude.com) installed and logged in.** Verified against CLI v2.1.214 and SDK v0.3.214.
- A Claude plan. Model availability follows your tier — Opus generally needs Max; without it, use Sonnet 5 or Haiku 4.5.

## The three modes

| Mode | What it does |
|------|------|
| **Chat** | Streaming Q&A over your vault. Reads and searches (`Read`/`Grep`/`Glob`), **never writes or runs anything**, and shows which notes it looked at. |
| **Code** | Writes and runs code against your notes. **Every run and every note write is approval-gated**; output streams into the panel. |
| **Cowork** | Multi-step tasks. Claude **plans first**, you approve the plan, then it executes step by step, pausing for approval at each write and run. |

Each mode keeps its own conversation and its own model, and switching tabs doesn't lose your transcript.

## Safety model

**The gates are enforced by the toolset, not by trust.**

- Chat's tool list is restricted to `Read`/`Grep`/`Glob`. The write and shell tools aren't merely discouraged — they're absent from the model's context, so it cannot call them.
- Code and Cowork add the shell (`PowerShell` on Windows, `Bash` elsewhere) plus a custom `vault_write` tool. The built-in `Write`/`Edit`/`MultiEdit` tools are removed.
- `vault_write` applies changes **through Obsidian's Vault API** (`vault.modify`/`vault.create`), never raw disk writes, so Obsidian's index and backlinks stay in sync.
- Every shell run and every note write pauses at an in-panel **Approve / Deny** card — with the exact command for runs, and a diff for writes.
- A `canUseTool` deny-gate backstops all of it, and `settingSources: []` isolates Orbit from your global Claude Code config.

Orbit never stores or asks for an API key.

## Settings

**Obsidian → Settings → Orbit**

- **Default mode** — which tab opens first.
- **Models** — one per mode (also switchable from the panel header). Defaults: Sonnet 5 for Chat, Opus 4.8 for Code and Cowork.
- **Vault scope** — limit the engine to a subfolder, or leave empty for the whole vault.

## Develop

```bash
npm install
npm run dev      # esbuild watch → main.js
npm run build    # production build
```

Obsidian needs to load a folder that contains `node_modules`, because the `claude` binary the SDK drives ships as a platform-specific package inside it. The simplest dev setup is to make this project folder *be* the plugin folder:

**Windows** (a directory *junction* needs no admin rights; a symlink does):

```powershell
New-Item -ItemType Junction `
  -Path "<vault>\.obsidian\plugins\orbit" `
  -Target "<path-to-this-repo>"
```

**macOS / Linux:**

```bash
ln -s "<path-to-this-repo>" "<vault>/.obsidian/plugins/orbit"
```

Then **Settings → Community plugins → enable Orbit**, and open the panel from the ribbon (bot icon) or the command palette ("Open Orbit panel").

## How the engine loads (the non-obvious part)

Two things here cost real debugging, and both are easy to get backwards:

**1. The SDK must be bundled into `main.js`.** It's tempting to mark it `external` and `import()` it at runtime from `node_modules` — but inside Obsidian, `import()` in plugin code is *Chromium's* module loader, and Chromium refuses to fetch `file://` modules. Any runtime dynamic import fails with `Failed to fetch dynamically imported module`, no matter how correct the path is. So esbuild bundles it, converting the SDK's ESM to CJS.

**2. Bundling then needs two fixes**, both in `esbuild.config.mjs` and `main.ts`:

- `define: { "import.meta.url": "__filename" }` — the SDK calls `createRequire(import.meta.url)` at module load, which in a CJS bundle is `undefined` and throws `ERR_INVALID_ARG_VALUE` before any plugin code runs. `createRequire` accepts an absolute path, and Obsidian provides `__filename`.
- `pathToClaudeCodeExecutable` is passed explicitly. Once bundled, the SDK's own binary lookup walks from the bundle's location and can't find its sibling package, so Orbit names the path outright.

## Authentication

Orbit calls `query()` with no API key. The SDK resolves credentials from your existing `claude` OAuth login and reports `apiKeySource: 'none'`. Usage counts against your Claude plan, not per-token billing.

## Spikes

`spike/` holds the harnesses that proved each piece, kept as regression tests. They take your vault path from an env var:

```bash
VAULT="C:/path/to/vault" node spike/spike2.mjs
```

`bundletest.ts` and `contexttest.ts` are TypeScript and need bundling first — the command is in the header comment of each.

## Known limitations

- Desktop only; no mobile support is planned.
- Replies render as plain text — Markdown is not rendered yet.
- Distribution still requires Claude Code installed locally, since the `claude` binary (~245 MB) can't be shipped in a plugin release.

## License

MIT — see [LICENSE](LICENSE).
