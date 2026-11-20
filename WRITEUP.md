# Anvil - coding with context and review

## 1. Team

Tokenisers, Nanyang Technological University: Mohnish Singh Rawat (@Mqhnish, team leader), Arnav Jain (@arnavjain29), and Anay Sharma (@WgbCode7129).

Repository: https://github.com/Mqhnish/anvil

Demo video (3:59): https://youtu.be/Y9m8YrG-_PE

## 2. Starting point

Built from scratch as a TypeScript VS Code extension, under the MIT license. Anvil uses the TrueForge SDK, MCP SDK, diff, ignore, and zod. It uses VS Code's native diff editor and undoable workspace edits. No upstream coding-agent extension was forked.

## 3. Architecture on TrueForge

VS Code is the editor client; TrueForge owns the agent loop. Anvil creates TrueForge sessions, streams turns, handles approval pauses, and requests cancellation. The extension does not call a model provider directly. Primary and fallback models are configured in TrueForge and selected by name in Anvil.

Anvil hosts a local MCP server with a per-launch secret. Its tools expose file reading, search, symbols, diagnostics, open editors, context assembly, edit proposals, approved commands, and git status. The model chooses which tools to use.

Tool approval drives review. Before a proposed edit executes, Anvil opens a native diff and collects hunk decisions. The executing MCP handler applies only accepted hunks. Decisions are tied to the baseline and proposal; intervening file changes require a fresh review. Undo restores the previous content and removes newly created files when appropriate.

Cancellation denies pending reviews, revokes approvals, and stops active shell processes and their children (process group on macOS/Linux, process tree on Windows). Accepted changes remain applied. Retry and automatic fallback are available before an edit or command executes. After a side effect, a failure stops with an explanation instead of replaying the request. A provider's per-minute rate limit (HTTP 429) is different: Anvil waits the time the provider asks for, then continues the same TrueForge session with a short continue message, without resending the original task. The model can still choose to repeat a tool call. Some models, especially small local ones, sometimes write a tool call as JSON text instead of calling the tool; Anvil detects this and asks the same session, at most twice, to make the real call. It never executes the text itself, so every action stays inside TrueForge's tool loop and the review.

Four frequent tools are preloaded; the rest use TrueForge's deferred tool loading and are discovered on demand. In the recorded Task B session the agent looks up the command tool only when it needs to run tests, which keeps unused tool schemas out of the prompt (the "deferred loading" rows at 1:57, and the TrueForge session at 2:31-2:46). The agent definition also enables dynamic subagents and context compaction at 60,000 input tokens. Subagents were switched off for the free-tier runs to stay within per-minute rate limits, and no recorded task grew large enough to trigger compaction, so neither appears in the video.

## 4. How context is selected

The local repository index respects ignore rules and excludes binary and oversized files. It extracts symbol outlines, splits code into symbol-sized chunks, indexes identifier terms with BM25, and records import relationships. Files are refreshed after saves and applied changes.

Context ranking combines explicit @file/@symbol mentions, lexical relevance, path and symbol-name agreement, open editors, and related tests, documentation and imports. Tasks that add something ("add a new built-in CLI command") start from the extension point: the source file that already holds several of that kind (run_command, shell_command and routes_command in cli.py). It leads the pack with one sibling as the pattern to copy, followed by its own tests and docs, so even a 4,000-token pack carries cli.py, test_cli.py and docs/cli.rst. The default context budget is approximately 12,000 tokens. Packing chooses relevant symbol bodies or outlines instead of including every whole file. Token counts are estimates, not provider billing measurements.

Every selected file includes a reason. A visible context card shows selected files, reasons, estimated budget usage and skipped candidates. Anvil also assembles this pack itself before the first turn of every agent task and sends it with the request, so retrieval does not depend on the model choosing to call the tool. The agent is instructed to explain its intended files before a multi-file edit, and can search or read more when the initial pack is insufficient.

The trade-off is speed and explainability versus semantic recall. Retrieval uses no embeddings or additional model calls. Pure paraphrases can be weaker matches; search, symbol lookup and further reading provide recovery paths.

## 5. Model setup

All provider credentials stay in TrueForge or the git-ignored local configuration. The extension can select any supported configured model, plus a distinct fallback. The example configuration includes OpenAI, Gemini, NVIDIA's OpenAI-compatible API and a local endpoint.

Rehearsals used Google's gemini-3.5-flash-lite on its free tier. The recording uses MiniMax M3.1 Flash on NVIDIA's free developer API, which has no daily cap, added to local TrueForge 0.185.1 as a custom OpenAI-compatible provider, with subagents off and a 4,000-token context budget. No paid model was selected; expected API cost is $0, not an audited figure.

In Task B the context pack ranked 4 files from 128 candidates, led by src/flask/cli.py (3,928 of 4,000 tokens). Without being told any file names, the agent edited cli.py, test_cli.py, docs/cli.rst and docs/api.rst, each reviewed as a diff. NVIDIA's per-minute limit returned 429 several times; Anvil waited and continued the same session each time. Afterwards 62 CLI tests passed, `flask config` printed SECRET_KEY as "***", and `flask --help` listed `config`. Task C's primary was a provider that refuses connections; Anvil fell back to MiniMax automatically.

The two labelled cuts in Task B come after the reviews; they remove waiting time on an approval card and repeated agent steps. The final checks on screen were run by the recording driver.

## 6. Scorecard

Timestamps refer to the demo video. In the recording, a scripted Extension Host driver typed the instructions and pressed Accept or Reject; the agent, model, tools and review path are the real ones. No competition score is claimed.

| Criterion | Evidence | Video |
|---|---|---|
| A1 Inline edit | Task A: diff, accept, then off/N → False and 1 → True. Per-hunk take: three hunks, one accepted, two rejected | 0:08-0:36, 0:36-1:10 |
| A2 Agent mode | Task B: no file names given; the agent edits cli.py, test_cli.py, cli.rst and api.rst; 62 tests pass; secrets masked | 1:10-2:31 |
| A3 Streaming and cancellation | Tokens and tool calls stream into the panel; Esc mid-generation cancels in about 0.25 s; git status stays clean | 1:19-2:31, 3:19-3:27 |
| B1 Context assembly | Context pack: 4 files from 128 candidates, a reason for each, 3,928 of 4,000 tokens, skipped files named; then targeted reads | 1:19-1:43 |
| B2 Diff safety | Per-hunk accept and reject, only accepted lines land; C rejected, tree clean; D undone byte for byte | 0:46-1:10, 3:02-3:15, 3:39-3:53 |
| B3 Resilience | Primary offline → automatic fallback, no user action (C); per-minute 429 → wait and continue (B) | 2:55-3:02, 1:27-1:43 |
| B4 TrueForge depth | Approval pauses drive review; command tool loaded on demand (deferred loading); Allow card; session with every tool call in TrueForge | 1:43-2:13, 2:31-2:46 |
| C1 Video | 3:59 narrated screen recordings; waits sped up and labelled; two labelled cuts in B, after the diffs; no cut between instruction and diff | full |
| C2 Write-up | This document | - |

## 7. Tools used

TypeScript and esbuild; TrueForge SDK and local server; MCP SDK; VS Code extension APIs; Vitest and DOM regression tests; vsce packaging; pallets/flask as the task repository. Runtime dependencies and source licensing are documented in the repository.

AI coding assistants: Claude Code (Anthropic) was used throughout for implementation, tests, debugging and documentation; the repository's CLAUDE.md and docs/TEAMMATE-PROMPT.md are the instructions we gave it. Claude was also used to review this write-up against the brief. All design decisions, rehearsals and the recorded runs were checked by the team.

## 8. Known limitations and next steps

The automated suite and headless e2e verify extension behavior with scripted responses. Five actual VS Code Extension Host scenarios pass: partial CodeLens acceptance, undo, cancellation, a subsequent task and closing a diff. The recorded demo ran real models in a real VS Code window, with a scripted driver standing in for the person at the keyboard. Recording surfaced four bugs, fixed before the final takes: Esc did not cancel while text was selected; neighbouring changes merged into one hunk, so they could not be decided separately; panel cards shrank to thin lines once the log overflowed; and the context pack depended on the model calling the tool.

Reviews apply per file rather than as a transaction across an entire turn. Cancellation is not a rollback. User-approved commands run on the host, outside an OS sandbox. File-tool path validation does not constrain arbitrary shell commands. Retrieval is lexical; symbol lookup has a regex fallback. Next improvements would prioritize real-model evaluation across more models, a timeout for approvals left pending, a cross-file review view, and richer subagent transcripts.
