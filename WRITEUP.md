# Anvil — TrueFoundry Forge-a-thon, Round 1 write-up

*(1–3 pages when exported. Fill the bracketed items after the demo recording. Export: open in VS Code → Markdown PDF, or `pandoc WRITEUP.md -o WRITEUP.pdf`.)*

## 1. Team

Team **Tokenisers**
- Mohnish Singh Rawat — [college] — GitHub @Mqhnish (team leader)
- Arnav Jain — [college] — GitHub @[handle]
- Anay Sharma — [college] — GitHub @[handle]

Repository: https://github.com/Mqhnish/anvil · Demo video: [link]

## 2. Starting point

**From scratch.** No upstream editor-agent fork. Runtime dependencies: `@truefoundry/trueforge-sdk` (TrueForge
client), `@modelcontextprotocol/sdk` (to host our MCP server), `diff`, `ignore`, `zod`. The diff *viewer* is VS Code's
own diff editor driven by a virtual document, CodeLens and decorations — we did not rebuild one.

## 3. Architecture on TrueForge

**VS Code is a client of a TrueForge agent.** On activation the extension (a) starts a Streamable-HTTP MCP server on
`127.0.0.1:<port>` that exposes the editor, (b) registers it with TrueForge under *Settings → Connectors* as
`vscode-workspace` (header auth with a per-launch secret), and (c) for every conversation creates a session with the
inline agent spec from `agent/anvil-agent.json` (model name and server name filled from settings). Turns are sent
with `sessions.createTurnStream`; events are rendered as they stream; pauses are answered with `subscribeToTurn` +
`createTurnEvents`; `sessions.cancel` implements Cancel.

**Editor capabilities as MCP tools** (`src/mcp/server.ts`): `read_file` (line ranges, numbered), `list_dir`,
`search_workspace` (text/regex/glob), `find_symbols`, `assemble_context` (§4), `get_diagnostics`, `open_editors`,
`git_status`, `propose_edit`, `run_command`. The agent — not the extension — chooses what to read and change.

**Tool approval drives the diff review.** `propose_edit` is annotated `readOnlyHint:false` (TrueForge's `@write`
class) and `run_command` `destructiveHint:true`, so TrueForge pauses with `tool.approval_required` before either runs.
On that pause Anvil opens the hunk review; the user's decisions are stored keyed by *(path, hash(before), hash(after))*;
Anvil answers `allow` (or `deny` with the reason when every hunk was rejected). When TrueForge then executes the tool,
the MCP handler looks the decision up and applies **only the accepted hunks**, then reports to the model exactly which
hunks were rejected so it does not retry them. Writes therefore happen only inside an approved tool call, atomically —
which is also why cancellation can never leave a half-applied edit.

**Harness features used and why.** *Deferred tool loading, selectively*: `preload_tools` eagerly loads the four tools
used on nearly every turn (`assemble_context`, `read_file`, `search_workspace`, `propose_edit`); the other six are
discovered on demand through TrueForge's meta tools, keeping the system prompt small. *Dynamic sub-agents* are on and
the instructions tell the agent to delegate read-heavy, small-answer sub-tasks (e.g. "find every caller of X") so raw
file contents stay out of the main context. *Compaction* is configured with an explicit 60k input-token trigger so
long agent runs on a 17k-line repo keep working. Sandbox, web search and generative UI are off: the editor is the
sandbox. [Confirm what was visible in the recorded session and cite the timestamp.]

## 4. How context is selected

The intellectual core is `src/context/`. `RepoIndex` lists files (gitignore-aware, binary/size filtered), builds a
regex outline per file (Python, TS/JS, Go, Rust, Java, Ruby, C, rst/md), chunks each file by top-level symbol, and
keeps a BM25 index over identifier-split terms plus a path-term index and an import graph. It refreshes per file on
save, so retrieval always sees the working tree.

`assemble_context(task, budget)` scores files by five signals and packs under a token budget:
1. **Explicit mentions** — `@file`, `@symbol`, `@file:12-40`, and bare paths written in the task → always included
   first, full file when it fits, else the mentioned symbol bodies, else an outline.
2. **BM25 over symbol-level chunks** for the task's terms (identifiers split on camel/snake case, stemmed).
3. **Rarity-weighted path and symbol-name agreement** — "command" matching `routes_command` in `cli.py` is decisive;
   "flask" appearing in every path is worth nothing.
4. **Open editors / active selection** — what the user is looking at.
5. **Neighbour expansion** — for the top source files, their tests (`tests/test_<name>.py`, `<name>.test.ts`…), docs
   (`docs/<name>.rst|md`) and the files they import, each with a lower weight and an explicit reason.

Packing: default budget 12 000 tokens (setting), per-file cap budget/4 (half that for tests/docs), retrieved files
contribute only their best-matching symbol bodies, and every file carries a one-line *reason* ("tests for
src/flask/cli.py", "symbol names match (command, config)"). The pack ends with the list of files that were considered
but skipped and why. The agent is instructed to echo the chosen files and reasons before editing, and the panel renders
the pack as a card with a budget bar — this is what is visible on screen in Task B. On pallets/flask 3.1.3 the Task B
instruction selects `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`, `src/flask/config.py` (and the CLI test
runner) at 11.9k/12k tokens out of 128 candidates, in ~90 ms (unit test `test/retriever.test.ts`).

Trade-off: lexical retrieval over symbol chunks, no embeddings — it is deterministic, runs in milliseconds on a laptop
with no model calls, and is explainable per file, which the rubric rewards; it is weaker on purely semantic
paraphrases, which the agent compensates for with `search_workspace`/`find_symbols` (and sub-agents) when the pack
is insufficient.

## 5. Model setup

Models are configured only in TrueForge (*Settings → Models* or `trueforge/configure-models.mjs` with the git-ignored
`models.local.json`; `models.example.json` ships placeholders). Anvil references FQNs; **Anvil: Select Model** lists
whatever TrueForge has and writes `anvil.model.primary`; **Anvil: Select Fallback Model** sets the automatic fallback.
Switching models is a setting change — no code touches a provider.

Used for the demo: [primary model, provider, where it ran, approx cost]; fallback: [model]. Development and the
headless e2e used our scripted mock model (`scripts/mock-model.mjs`, zero cost) and [any real model, cost].
Task C was recorded with [invalid key on the primary / dead custom endpoint] and [fallback model].

## 6. Scorecard

| Criterion | Timestamp | Claim |
|---|---|---|
| A1 Inline edit | [m:ss] | diff rendered in the editor with per-hunk Accept/Reject CodeLens |
| A2 Agent mode | [m:ss] | Task B edits cli.py, test_cli.py, docs/cli.rst (+config.py) without any file named |
| A3 Streaming & cancellation | [m:ss] | tokens stream into the panel; Esc cancels mid-generation; `git status` clean |
| B1 Context assembly | [m:ss] | Context-pack card shows chosen files, reasons, 12k budget bar before edits |
| B2 Diff safety | [m:ss] | hunk rejected in review; `Anvil: Undo Last Applied Change` restores file |
| B3 Resilience | [m:ss] | primary fails → retry ×2 → automatic fallback notice → diff from fallback; variant without fallback shows one clear error, no files changed |
| B4 TrueForge depth | [m:ss] | TrueForge session shows `assemble_context`/`propose_edit` tool calls and the approval pause; selective preload visible in the agent spec |
| C1 Video | — | A → B → C, each verified on screen |
| C2 Write-up | — | this document |

## 7. Tools used

Claude Code (Opus) was used extensively to write and test the extension; TrueForge docs/OpenAPI and SDK types;
VS Code Extension API docs; `pallets/flask` 3.1.3 as the fixed repository. [Add anything else.]

## 8. Known limitations and the next month

- Retrieval is lexical; a hybrid with a small local embedding index over the same symbol chunks is the obvious next
  step, keeping the per-file reasons.
- Inline edit opens a diff editor rather than an in-place ghost-text overlay; a decoration-based inline preview
  (same hunk model) is a UI week.
- Hunk review is per file; a cross-file "change set" view with one Finish button would speed up Task-B-style runs.
- `find_symbols` uses the regex outline even when a language server could answer more precisely in VS Code.
- Sub-agent output is shown as collapsed cards; richer per-thread transcripts would help debugging.
- [Add whatever the real-model runs revealed.]
