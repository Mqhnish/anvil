# Anvil - coding with context and review

## 1. Team

Tokenisers, Nanyang Technological University: Mohnish Singh Rawat (@Mqhnish, team leader), Arnav Jain (@arnavjain29), and Anay Sharma (@WgbCode7129).

Repository: https://github.com/Mqhnish/anvil

Demo video (3:24): VIDEO_LINK

## 2. Starting point

Built from scratch as a TypeScript VS Code extension, under the MIT license. Anvil uses the TrueForge SDK, MCP SDK, diff, ignore, and zod. It uses VS Code's native diff editor and undoable workspace edits. No upstream coding-agent extension was forked.

## 3. Architecture on TrueForge

VS Code is the editor client; TrueForge owns the agent loop. Anvil creates TrueForge sessions, streams turns, handles approval pauses, and requests cancellation. The extension does not call a model provider directly. Primary and fallback models are configured in TrueForge and selected by name in Anvil.

Anvil hosts a local MCP server with a per-launch secret. Its tools expose file reading, search, symbols, diagnostics, open editors, context assembly, edit proposals, approved commands, and git status. The model chooses which tools to use.

Tool approval drives review. Before a proposed edit executes, Anvil opens a native diff and collects hunk decisions. The executing MCP handler applies only accepted hunks. Decisions are tied to the baseline and proposal; intervening file changes require a fresh review. Undo restores the previous content and removes newly created files when appropriate.

Cancellation denies pending reviews, revokes approvals, and stops active shell processes and their children (process group on macOS/Linux, process tree on Windows). Accepted changes remain applied. Retry and automatic fallback are available before an edit or command executes. After a side effect, a failure stops with an explanation instead of replaying the request. A provider's per-minute rate limit (HTTP 429) is different: Anvil waits the time the provider asks for, then continues the same TrueForge session with a short continue message, without resending the original task. The model can still choose to repeat a tool call. Some models, especially small local ones, sometimes write a tool call as JSON text instead of calling the tool; Anvil detects this and asks the same session, at most twice, to make the real call. It never executes the text itself, so every action stays inside TrueForge's tool loop and the review.

Four frequent tools are preloaded; the rest use TrueForge's deferred tool loading and are discovered on demand. In the recorded Task B session the agent calls list_tools, then call_tool for assemble_context, which keeps unused tool schemas out of the prompt (visible at 2:09-2:17). The agent definition also enables dynamic subagents and context compaction at 60,000 input tokens. Subagents were switched off for the free-tier runs to stay within Gemini's per-minute quota, and no recorded task grew large enough to trigger compaction, so neither appears in the video.

## 4. How context is selected

The local repository index respects ignore rules and excludes binary and oversized files. It extracts symbol outlines, splits code into symbol-sized chunks, indexes identifier terms with BM25, and records import relationships. Files are refreshed after saves and applied changes.

Context ranking combines explicit @file/@symbol mentions, lexical relevance, path and symbol-name agreement, open editors, and related tests, documentation and imports. Tasks that add something ("add a new built-in CLI command") start from the extension point: the source file that already holds several of that kind (run_command, shell_command and routes_command in cli.py). It leads the pack with one sibling as the pattern to copy, followed by its own tests and docs, so even a 4,000-token pack carries cli.py, test_cli.py and docs/cli.rst. The default context budget is approximately 12,000 tokens. Packing chooses relevant symbol bodies or outlines instead of including every whole file. Token counts are estimates, not provider billing measurements.

Every selected file includes a reason. A visible context card shows selected files, reasons, estimated budget usage and skipped candidates. Anvil also assembles this pack itself before the first turn of every agent task and sends it with the request, so retrieval does not depend on the model choosing to call the tool. The agent is instructed to explain its intended files before a multi-file edit, and can search or read more when the initial pack is insufficient.

The trade-off is speed and explainability versus semantic recall. Retrieval uses no embeddings or additional model calls. Pure paraphrases can be weaker matches; search, symbol lookup and further reading provide recovery paths.

## 5. Model setup

All provider credentials stay in TrueForge or the git-ignored local configuration. The extension can select any supported configured model, plus a distinct fallback. The example configuration includes OpenAI, Gemini and a local OpenAI-compatible endpoint.

Live rehearsal on 19 November used Google's gemini-3.5-flash-lite through local TrueForge 0.185.1, with subagents off, 4,000- and 8,000-token context budgets and no retries. The user confirmed Free Tier with billing disabled; no paid model was selected. Expected API cost is $0 on that tier, not an independently audited billing measurement. The older gemini-2.5-flash-lite returned unavailable for new users before the switch.

The recorded run used the same model and setup. Task A's edit lists every false value, including the empty string, and FLASK_DEBUG=off and N now read as False. In Task B, Gemini found and edited src/flask/cli.py, tests/test_cli.py and docs/cli.rst without being told the file names. Four diffs were reviewed in one task, and the agent ran the CLI tests itself through an approved command. Mid-task, the free tier returned a 429; Anvil waited and continued the same TrueForge session (visible in the session at 2:09). Afterwards, tests/test_cli.py passed (59 tests), `flask config` printed SECRET_KEY as "***", and `flask --help` lists `config` (run on the same workspace after recording). The context pack in that run ranked cli.py fifth but left it out for budget, and said so; the agent read it next. Other free-tier takes of Task B were not used: one broke an unrelated test, one changed Flask's global JSON encoding to pass its own test, one looped on searches. Task C used a local provider that always answers HTTP 503 as the primary; Anvil retried, then fell back to Gemini automatically. Earlier rehearsals stopped at a plan or hit the 20-iteration limit; the agent instructions and the rate-limit continue path were changed before recording.

## 6. Scorecard

Timestamps refer to the demo video. In the recording, a scripted Extension Host driver typed the instructions and pressed Accept or Reject; the agent, model, tools and review path are the real ones. No competition score is claimed.

| Criterion | Evidence | Video |
|---|---|---|
| A1 Inline edit | Task A on Gemini: diff with per-hunk CodeLens, accept, then off/N → False and 1 → True | 0:15-0:32 |
| A2 Agent mode | Task B: no file names given; the agent edits cli.py, its test and docs; 59 tests pass; secrets masked | 1:20-2:09 |
| A3 Streaming and cancellation | Esc mid-generation cancels in under 0.3 s; git status stays clean | 2:53-3:00 |
| B1 Context assembly | Context pack with reasons, 3,881 of 4,000 tokens, skipped files named; then targeted reads | 1:26-1:33 |
| B2 Diff safety | One diff, three hunks: one accepted, two rejected individually, only the accepted lines land; C rejected; D undone byte for byte | 0:39-1:11, 2:24-2:46, 3:00-3:17 |
| B3 Resilience | 503 primary → retry → automatic fallback, no user action (C); free-tier 429 → wait and continue (B) | 2:24-2:46, 2:09 |
| B4 TrueForge depth | Session with every tool call; deferred tool loading (list_tools → call_tool assemble_context); approval pauses drive review | 2:09-2:17 |
| C1 Video | 3:24 screen recording at 30 fps, played at 1.25×; context cards and step captions; long model waits sped up further and labelled; no cuts between instruction and diff | full |
| C2 Write-up | This document | - |

## 7. Tools used

TypeScript and esbuild; TrueForge SDK and local server; MCP SDK; VS Code extension APIs; Vitest and DOM regression tests; vsce packaging; pallets/flask as the task repository. Runtime dependencies and source licensing are documented in the repository.

AI coding assistants: Claude Code (Anthropic) was used throughout for implementation, tests, debugging and documentation; the repository's CLAUDE.md and docs/TEAMMATE-PROMPT.md are the instructions we gave it. Claude was also used to review this write-up against the brief. All design decisions, rehearsals and the recorded runs were checked by the team.

## 8. Known limitations and next steps

The automated suite and headless e2e verify extension behavior with scripted responses. Five actual VS Code Extension Host scenarios pass: partial CodeLens acceptance, undo, cancellation, a subsequent task and closing a diff. The recorded demo ran real models in a real VS Code window, with a scripted driver standing in for the person at the keyboard. Recording surfaced four bugs, fixed before the final takes: Esc did not cancel while text was selected; neighbouring changes merged into one hunk, so they could not be decided separately; panel cards shrank to thin lines once the log overflowed; and the context pack depended on the model calling the tool. The Task B take in the video predates the panel fix, so its panel rows appear squashed. The free-tier model also needed several takes for Task B.

Reviews apply per file rather than as a transaction across an entire turn. Cancellation is not a rollback. User-approved commands run on the host, outside an OS sandbox. File-tool path validation does not constrain arbitrary shell commands. Retrieval is lexical; symbol lookup has a regex fallback. Next improvements would prioritize real-model evaluation, a cross-file review view, and richer subagent transcripts.
