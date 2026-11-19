# Anvil - coding with context and review

Round 1 review draft - partial live-model verification; full demonstration and recording pending.

## 1. Team

Tokenisers, Nanyang Technological University: Mohnish Singh Rawat (@Mqhnish, team leader), Arnav Jain (@arnavjain29), and Anay Sharma (@WgbCode7129).

Repository: https://github.com/Mqhnish/anvil

Demo video: not recorded. Replace this status with the public video link after recording.

## 2. Starting point

Built from scratch as a TypeScript VS Code extension, under the MIT license. Anvil uses the TrueForge SDK, MCP SDK, diff, ignore, and zod. It uses VS Code's native diff editor and undoable workspace edits. No upstream coding-agent extension was forked.

## 3. Architecture on TrueForge

VS Code is the editor client; TrueForge owns the agent loop. Anvil creates TrueForge sessions, streams turns, handles approval pauses, and requests cancellation. The extension does not call a model provider directly. Primary and fallback models are configured in TrueForge and selected by name in Anvil.

Anvil hosts a local MCP server with a per-launch secret. Its tools expose file reading, search, symbols, diagnostics, open editors, context assembly, edit proposals, approved commands, and git status. The model chooses which tools to use.

Tool approval drives review. Before a proposed edit executes, Anvil opens a native diff and collects hunk decisions. The executing MCP handler applies only accepted hunks. Decisions are tied to the baseline and proposal; intervening file changes require a fresh review. Undo restores the previous content and removes newly created files when appropriate.

Cancellation denies pending reviews, revokes approvals, and stops active shell processes on macOS/POSIX. Accepted changes remain applied. Retry and automatic fallback are available before an edit or command executes. After a side effect, a failure stops with an explanation instead of replaying the request.

Four frequent tools are preloaded; other tools are discovered on demand. The agent definition also enables dynamic subagents and context compaction at 60,000 input tokens. These features are configured, but their usefulness in the final real-model task has not yet been demonstrated.

## 4. How context is selected

The local repository index respects ignore rules and excludes binary and oversized files. It extracts symbol outlines, splits code into symbol-sized chunks, indexes identifier terms with BM25, and records import relationships. Files are refreshed after saves and applied changes.

Context ranking combines explicit @file/@symbol mentions, lexical relevance, path and symbol-name agreement, open editors, and related tests, documentation and imports. The default context budget is approximately 12,000 tokens. Packing chooses relevant symbol bodies or outlines instead of including every whole file. Token counts are estimates, not provider billing measurements.

Every selected file includes a reason. A visible context card shows selected files, reasons, estimated budget usage and skipped candidates. The agent is instructed to explain its intended files before a multi-file edit, and can search or read more when the initial pack is insufficient.

The trade-off is speed and explainability versus semantic recall. Retrieval uses no embeddings or additional model calls. Pure paraphrases can be weaker matches; search, symbol lookup and further reading provide recovery paths.

## 5. Model setup

All provider credentials stay in TrueForge or the git-ignored local configuration. The extension can select any supported configured model, plus a distinct fallback. The example configuration includes OpenAI, Gemini and a local OpenAI-compatible endpoint.

Live rehearsal on 19 November used Google's gemini-3.5-flash-lite through local TrueForge 0.185.1, with subagents off, an 8,000-token context budget and no retries. The user confirmed Free Tier with billing disabled; no paid model was selected. Expected API cost is $0 on that tier, not an independently audited billing measurement. The older gemini-2.5-flash-lite returned unavailable for new users before the switch.

The real inline edit passed 13 behavior checks; its docstring still omitted the empty-string case. Task B exhausted the free input-token-per-minute quota before making edits. Model calls stopped at that error. The real fallback run and recorded demonstration remain pending; scripted tests are separate evidence.

## 6. Scorecard

Evidence status below distinguishes implementation checks from the required recorded demonstration. Add video timestamps after recording; no competition score is claimed.

| Criterion | Verified evidence | Still required |
|---|---|---|
| A1 Inline edit | Real Gemini edit passes 13 behavior checks; native diff tested separately | Complete empty-string docstring; record Task A |
| A2 Agent mode | TrueForge/MCP tool loop exercised headlessly | Real-model Task B: discover and edit at least three files |
| A3 Streaming and cancellation | Streaming/e2e checks; actual Extension Host review cancellation passes | Record responsive cancellation on video |
| B1 Context assembly | Retrieval tests and budget/reason card implemented | Show selection and reasons during Task B |
| B2 Diff safety | Baseline protection; actual per-hunk accept/reject and WorkspaceEdit undo | Show individual accepted/rejected hunks on video |
| B3 Resilience | Dead primary, retry, fallback, and no-fallback e2e cases pass | Repeat with a real fallback model |
| B4 TrueForge depth | Agent spec, MCP registration and approval loop exercised | Show the TrueForge session and explain configured features |
| C1 Video | Rehearsal script prepared | Record a legible video within the required limit |
| C2 Write-up | Architecture, context strategy, verification and limitations documented | Fill live model details, video link and timestamps |

## 7. Tools used

TypeScript and esbuild; TrueForge SDK and local server; MCP SDK; VS Code extension APIs; Vitest and DOM regression tests; vsce packaging; pallets/flask as the task repository. Runtime dependencies and source licensing are documented in the repository.

## 8. Known limitations and next steps

The automated suite and headless e2e verify extension behavior with scripted responses. Five actual VS Code Extension Host scenarios pass: partial CodeLens acceptance, undo, cancellation, a subsequent task and closing a diff. The separate real-model inline rehearsal used headless review acceptance, not editor interaction. Task B failed on free quota; full Tasks A/B/C and the recorded demonstration remain pending.

Reviews apply per file rather than as a transaction across an entire turn. Cancellation is not a rollback. User-approved commands run on the host, outside an OS sandbox. File-tool path validation does not constrain arbitrary shell commands. Retrieval is lexical; symbol lookup has a regex fallback. Next improvements would prioritize real-model evaluation, a cross-file review view, and richer subagent transcripts.
