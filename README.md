# Anvil — an editor-native coding agent on TrueForge

Team **Tokenisers** · TrueFoundry Forge-a-thon, Techfest 2026-27, IIT Bombay

Anvil is a VS Code extension whose agent loop runs entirely on [TrueForge](https://github.com/truefoundry/trueforge).
VS Code is a *client* of a TrueForge agent: it opens sessions, streams turns, and exposes the editor to the agent as
MCP tools. TrueForge decides what to read and change; Anvil decides what the model sees (budgeted context
assembly) and keeps the editor safe (hunk-by-hunk review, undo, cancellation, model fallback).

```
   ┌──────────────── VS Code (extension host) ────────────────┐
   │  Agent panel · Inline edit · Hunk reviewer · Undo stack   │
   │        │ @truefoundry/trueforge-sdk (sessions/turns/SSE)  │
   │        ▼                                                  │
   │  TurnRunner ──retry/backoff──► fallback model             │
   │        │                                                  │
   │  Workspace MCP server (127.0.0.1:port, Streamable HTTP)   │
   │   read_file · search_workspace · find_symbols             │
   │   assemble_context · propose_edit · run_command · …       │
   └────────────▲──────────────────────────────┬──────────────┘
                │ MCP tool calls               │ HTTP API
   ┌────────────┴──────────────────────────────▼──────────────┐
   │  TrueForge (local mode)  — agent loop, approvals,         │
   │  deferred tool loading, sub-agents, compaction, sessions  │
   │            └── any model: catalog provider or OpenAI-compatible endpoint
   └───────────────────────────────────────────────────────────┘
```

**Starting point: from scratch.** No upstream fork. Dependencies: `@truefoundry/trueforge-sdk`,
`@modelcontextprotocol/sdk`, `diff`, `ignore`, `zod` (all MIT).

## The five capabilities

| # | Capability | Where | How |
|---|---|---|---|
| 1 | **Inline edit** | `src/edit/inlineEdit.ts` | Select → `Ctrl+Alt+I` (`Ctrl+Cmd+I` on Mac) → instruction → the agent calls `propose_edit` → diff opens in the editor with per-hunk Accept/Reject |
| 2 | **Agent mode** | `src/ui/panel.ts`, `src/trueforge/runner.ts` | Panel in the Anvil activity bar; one request drives a TrueForge tool loop until done. Files are discovered, never named |
| 3 | **Context assembly** | `src/context/*` | `@file`/`@symbol` mentions + automatic retrieval (BM25 over symbol chunks, path/symbol-name match, open editors, test/doc/import neighbours) packed under a token budget, with a *reason per file* shown in the panel |
| 4 | **Diff review** | `src/edit/reviewer.ts`, `hunks.ts` | Native diff editor + CodeLens per hunk; nothing is written until *Finish review*; applied via `WorkspaceEdit` (Cmd+Z) plus `Anvil: Undo Last Applied Change` |
| 5 | **Streaming & cancellation** | `runner.ts` | SSE deltas rendered as they arrive; `Esc`/Cancel calls `sessions.cancel`; writes happen only inside an approved tool call, pending reviews are denied and running commands are stopped on cancellation; earlier accepted edits remain applied |

Resilience (Task C): model/transport errors are retried with exponential backoff, then the request is re-run on the
configured **fallback model** automatically when no edit or command has run. If a turn fails after an accepted
edit or command, it stops with a clear message instead of replaying side effects. Earlier accepted edits remain
applied; use undo to revert them. Verified by `npm run e2e` (see below).

## Setup from a clean clone

Prerequisites: Node.js ≥ 22.14, VS Code ≥ 1.90, `git`. Python 3 + `pip install -e .` in the Flask checkout if you
want to run the fixed tasks' verifications.

```bash
git clone https://github.com/Mqhnish/anvil && cd anvil
npm ci
npm run build            # bundles dist/extension.js, dist/headless.js, dist/e2e.js
```

### 1. Start TrueForge locally (one terminal)

```bash
./trueforge/start.sh      # = OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
```

The allow-list matters: TrueForge's outbound SSRF guard blocks loopback addresses by default, and Anvil's workspace
MCP server lives on `127.0.0.1`. (Inside VS Code the command **Anvil: Start TrueForge** does the same thing.)

### 2. Configure a model in TrueForge

Open http://localhost:8790 → **Settings → Models** and add any provider (OpenAI, Anthropic, Gemini, …) or a `custom`
OpenAI-compatible endpoint (Ollama, vLLM, a gateway). Or from a file:

```bash
cp trueforge/models.example.json trueforge/models.local.json   # git-ignored; put real keys here
node trueforge/configure-models.mjs trueforge/models.local.json
```

Anvil never talks to a model provider itself — it only ever names a TrueForge model FQN (`provider/model`).

### 3. Run the extension

Open this folder in VS Code and press **F5** (launch config *Run Anvil extension (Flask workspace)* opens `../flask`;
clone it first: `git clone --branch 3.1.3 https://github.com/pallets/flask ../flask`). Or package it:

```bash
npm run package && code --install-extension anvil-0.1.0.vsix
```

On first use Anvil pings TrueForge, registers the workspace MCP server under **Settings → Connectors** as
`vscode-workspace` (header-auth with a per-session secret), and asks you to pick a model from the ones TrueForge has.
Pick a fallback with **Anvil: Select Fallback Model**.

### 4. The agent definition

[`agent/anvil-agent.json`](agent/anvil-agent.json) is the TrueForge agent spec Anvil runs — instructions, the MCP
server entry with selective preloading (`preload_tools`) and approval rules, sub-agents on, compaction trigger. The
extension loads it and fills in the model and server name from settings (`src/trueforge/agentSpec.ts`).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `anvil.trueforge.baseUrl` | `http://localhost:8790` | TrueForge server |
| `anvil.model.primary` / `anvil.model.fallback` | — | Model FQNs as configured in TrueForge |
| `anvil.resilience.maxRetries` | 2 | Backoff retries before falling back |
| `anvil.context.budgetTokens` | 12000 | Context-pack budget |
| `anvil.agent.subagents` | true | TrueForge dynamic sub-agents |
| `anvil.agent.compactionTriggerTokens` | 60000 | TrueForge compaction threshold |
| `anvil.mcp.serverName` / `anvil.mcp.port` | `vscode-workspace` / 0 | MCP registration name / port (0 = free port) |

## Tests

```bash
npm test                 # 63 tests: retrieval, edit blocks, MCP safety, cancellation, commands, mocked editor review/undo
npm run e2e              # headless end-to-end against a running TrueForge + the scripted mock model (scripts/mock-model.mjs):
                         #   approval→review→apply, per-hunk rejection, retry→fallback, clear error, cancellation
node dist/headless.js assemble --root ../flask "Add a new built-in CLI command flask config …"   # print a context pack
```

The mock model (`scripts/mock-model.mjs`) is an OpenAI-compatible server with a scripted coding policy and a
`--fail` switch; it exists so the *behaviours* can be tested deterministically, exactly as the judging rubric scores
them. It is not used for the demo video's model.

Latest verification: [docs/TESTLOG.md](docs/TESTLOG.md). The automated editor tests use VS Code API doubles;
Interactive smoke checks also cover the panel, inline shortcut, accept/reject and undo in VS Code.
A complete real-model run and the recorded demo still need verification.

## Actual editor regression tests

With TrueForge running locally and VS Code installed, run `npm run test:editor`. It opens an isolated Extension
Development Host with a disposable workspace and a local scripted model. Five scenarios exercise the real
CodeLens commands, partial hunk application, WorkspaceEdit undo, cancellation, rejecting all hunks, and closing
the diff. These are actual VS Code APIs, not the unit tests' mocked editor module. No paid model or credentials
are needed. The test runner does not alter your normal editor settings or project files.

The server defaults to `http://127.0.0.1:8790`; override it with `ANVIL_TEST_TRUEFORGE_URL`. On non-macOS systems,
put `code` on PATH or set `ANVIL_CODE_BIN`. Passing results are saved to `output/verification/editor-results.json`; failed runs retain the printed temporary workspace for diagnostics.
Mock endpoints use dynamically assigned ports and unique provider names so they cannot reuse an unrelated server.

**Anvil: Run Workspace Task** starts a task from the command palette; **Anvil: New Chat** starts a fresh session
when no task is running. Both use the same reviewed tool flow as the sidebar.

## Free model setup

For the current zero-spend submission, use [the Free Tier setup guide](docs/FREE-MODEL-SETUP.md) and
`trueforge/models.free.example.json`. It contains only Gemini 2.5 Flash-Lite. Use an eligible Free Tier Google
project with billing disabled; the model name itself does not prevent charges on a paid project. Stop on
quota or eligibility errors rather than upgrading or choosing a paid fallback.

## Submission preparation

`npm run check` runs typecheck, tests and the build. `npm run package` builds the extension and creates
`anvil-0.1.0.vsix`; install it through VS Code's **Extensions: Install from VSIX** command. Packaging uses a
runtime-only allowlist, so local credentials, tests, maps and development files are excluded.

The panel includes setup guidance and works with VS Code dark, light and high-contrast theme tokens.
Select a model, describe a task or choose an example prompt. The draft stays in the composer if setup fails.
Per-hunk controls use `diffEditor.codeLens`, enabled by default; an explicit user setting can override it.
Anvil requires a trusted local workspace because approved commands run on the host.

See [the submission handoff](docs/SUBMISSION-CHECKLIST.md) for the remaining real-model, video and PDF steps.
`WRITEUP.md` is an editable review draft with verified evidence separated from pending demonstration claims.

## Fixed tasks (Round 1)

See [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md) for the exact click-by-click flow for Tasks A, B and C, with the
verification commands.

## Layout

```
agent/anvil-agent.json     agent definition (spec) passed to TrueForge
src/extension.ts           activation, commands, wiring
src/trueforge/             SDK client, agent spec builder, TurnRunner (stream, pauses, approvals, retry, fallback, cancel)
src/mcp/server.ts          workspace MCP server + tools (annotations drive TrueForge approval)
src/context/               RepoIndex (BM25 + outline + imports), Retriever (budgeted pack), @mentions
src/edit/                  hunks, search/replace blocks, DecisionStore, HunkReviewer (diff editor + CodeLens), inline edit
src/host/                  WorkspaceHost: VsCodeHost and HeadlessHost (+ CLI and e2e)
src/ui/                    agent panel (webview)
trueforge/                 start script, example model config, configure script
scripts/mock-model.mjs     deterministic OpenAI-compatible model for tests
test/                      vitest unit tests
```

## Team

Mohnish Singh Rawat (@Mqhnish) · Arnav Jain (@arnavjain29) · Anay Sharma (@WgbCode7129) — Tokenisers, NTU. License: MIT.
