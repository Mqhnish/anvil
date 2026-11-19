# Anvil — guide for AI coding agents working in this repo

You are helping team Tokenisers finish **Anvil**, a VS Code coding-agent extension whose loop runs on TrueForge,
for the TrueFoundry Forge-a-thon (Techfest 2026-27). **Round 1 deadline: 20 November 2026, 23:59 IST.**
Read `README.md` first, then `docs/DEMO-SCRIPT.md` and `WRITEUP.md`. The judging rubric is in `docs/RUBRIC.md`.

## Non-negotiables (eligibility)
- The agent loop MUST run on TrueForge. The extension never calls a model provider directly. Models are configured
  in TrueForge; Anvil only references FQNs (`provider/model`). Do not add any direct OpenAI/Anthropic/etc. client.
- Editor capabilities are exposed to the agent as MCP tools (`src/mcp/server.ts`). The agent decides what to read
  and change; the extension renders, reviews, applies. Keep it that way.
- No API keys in the repo. `trueforge/models.local.json` and `.env*` are git-ignored; keep them so.
- `agent/anvil-agent.json` is the shipped agent definition. If you change instructions/tool policy, change it there
  and keep `src/trueforge/agentSpec.ts` in sync.
- MIT license and attribution stay. Starting point is "from scratch" — do not vendor code from Cline/Continue/Roo.

## How to build, test, run
```bash
npm install && npm run build      # esbuild → dist/
npm run typecheck && npm test     # tsc + vitest (hunks, edit blocks, retrieval on ../flask)
./trueforge/start.sh              # TrueForge local mode with loopback allow-listed (needed for MCP callbacks)
npm run e2e                       # headless e2e: real TurnRunner + real TrueForge + mock model (needs TrueForge running)
# F5 in VS Code launches the extension against ../flask (clone pallets/flask tag 3.1.3 next to this repo)
```
Always run `npm run typecheck && npm test` before committing; run `npm run e2e` when touching runner/mcp/edit.

## Architecture in one minute
- `src/trueforge/runner.ts` — one turn: `createTurnStream` → event index (merge deltas) → on `turn.update paused`
  handle `tool.approval_required` (propose_edit → hunk review; run_command → approval card) → `subscribeToTurn` +
  `createTurnEvents` → … → `turn.done`. Retries with backoff, then automatic fallback model. `cancel()` = `sessions.cancel`.
- `src/mcp/server.ts` — Streamable-HTTP MCP server on 127.0.0.1. Tool annotations matter: `propose_edit` is
  `@write` (approval → review), `run_command` is `@destructive`, everything else read-only.
- `src/edit/` — `hunks.ts` (diff → hunks → apply subset), `editBlocks.ts` (search/replace with tolerant matching),
  `decisions.ts` (review decisions keyed by content hash so the approved tool call applies exactly what was accepted),
  `reviewer.ts` (diff editor + CodeLens + decorations + undo).
- `src/context/` — `index.ts` (RepoIndex: gitignore-aware file list, regex outline, symbol chunks, BM25, imports),
  `retriever.ts` (scores + budgeted packing + reasons), `mentions.ts` (@file/@symbol).
- `src/host/` — `WorkspaceHost` interface with `VsCodeHost` and `HeadlessHost`; everything above the host is testable
  without VS Code (`dist/headless.js`, `dist/e2e.js`).

## Current state (19 Nov 2026)
Working and verified headlessly: TrueForge session/turn streaming, MCP registration + tool calls, approval-driven
per-hunk review path, retry + fallback, clear-error path, cancellation. Automated tests: 63 passing, including MCP integration and mocked editor review/undo; typecheck, build and all five headless e2e scenarios passed. See `docs/TESTLOG.md`. Interactive VS Code smoke checks cover panel rendering, the macOS inline shortcut, native diff proposals, Accept/Reject All, and undo. Individual CodeLens actions, UI cancellation, and complete real-model Tasks A/B/C remain unverified. **Those need a real-model run on the Flask tasks — see docs/DEMO-SCRIPT.md.**

## Open work, in priority order
1. Run Tasks A, B, C for real in VS Code with a real model; fix whatever breaks (reviewer, panel, prompt wording in
   `agent/anvil-agent.json`). Record findings in `docs/TESTLOG.md`.
2. Record the ≤4-minute demo video (A → B → C, verification on screen, TrueForge session visible during B).
3. Finish `WRITEUP.md` (8 headings, in order) with real timestamps; export to PDF (`docs/` has instructions).
4. Polish completed: setup/empty state, native-theme panel, accessible cards, draft preservation, webview readiness, command allowlist, CodeLens default, isolated VSIX install and clean-source package. Maintain these checks when editing the UI.
5. Nice-to-have: show sub-agent threads more richly; `find_symbols` via language server when available.

## Conventions
- TypeScript strict, no `any` unless interfacing with untyped SDK bits; small pure modules with unit tests.
- No new runtime dependencies without a reason in the PR description.
- Commit messages: imperative, one topic each. Never commit `dist/`, `*.vsix`, secrets.
- Keep `README.md` setup steps true from a clean clone — judges follow them literally.
