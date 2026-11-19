# Verification — 18 November 2026

Environment: macOS, local Flask checkout, cached TrueForge 0.185.1, scripted mock model.
TrueForge was bound to `127.0.0.1:18790` with a separate SQLite test database. No paid model was used.

## Automated results

| Check | Result |
|---|---|
| `npm test` | 49 tests passed across 7 files |
| `npm run typecheck` | Passed |
| `npm run build` | Extension, headless CLI and e2e bundles built |
| `node dist/e2e.js --root ../flask --trueforge http://localhost:18790` | All 5 scenarios passed |

End-to-end scenarios exercised the actual TrueForge session/stream/approval loop and workspace MCP server:

1. Context retrieval, file read, approval, review, and edit application.
2. Rejecting every hunk leaves the target untouched.
3. Dead primary model retries, then falls back automatically and applies the reviewed edit.
4. Dead primary without fallback reports an error and leaves the target untouched.
5. Cancelling before edit approval leaves the target untouched.

The scenarios operated on temporary copies of Flask, not the original checkout.

## Regression coverage added

- Cancellation resolves a blocked stream or review promptly; late session creation and approval cannot attach to a new turn.
- Pending review decisions and command approvals are revoked on cancellation; command approval includes the working directory.
- Model failures after an accepted edit or command stop without replaying the request on retry/fallback.
- A file changed during review, or an editor buffer changed before apply, is not overwritten.
- Partial acceptance applies only accepted hunks even if the host supplies no precomputed resulting content.
- Undo deletes newly created files, restores existing empty files, and retains history when an undo fails.
- Cancellation denies active reviews; failed saves are reported instead of silently succeeding.
- Workspace tools reject sibling-prefix traversal and outward symlinks, including new paths through symlink parents.
- Commands handle spawn errors and pre-cancellation; cancellation/timeout kill the shell process group on macOS/POSIX.
- Globstar patterns include both direct children and nested paths.

Editor review/undo tests use VS Code API doubles, not an interactive Extension Development Host.
The configuration changes also preserve the active runner until the turn ends and refresh connection settings before the next turn.

## Still needs a real-model demonstration

Run the exact Tasks A, B, and C in `docs/DEMO-SCRIPT.md` inside VS Code. Verify visual CodeLens placement,
diff tab behaviour, panel rendering, keybindings, and a complete three-file Task B using real model output.
Record the video and fill `WRITEUP.md` with the actual model/cost, video link and scorecard timestamps.
No live UI run, model cost, video evidence, or competition score is claimed by these automated results.

Cancellation is not a whole-turn rollback: previously accepted edits remain applied. Approved shell commands
run with the user's host permissions; path validation on file tools does not sandbox arbitrary shell commands.


## Interactive VS Code check — 19 November 2026

Launched the installed VS Code 1.143.1 Extension Development Host with Anvil and a disposable copy of Flask.
TrueForge 0.185.1 and the scripted `mock/mock-coder` provider ran locally. This was an actual editor run,
not the mocked VS Code API used by the automated editor tests.

Observed and verified:

- The Anvil activity-bar view rendered its model, connection, tool-call and review cards after initialization.
- The macOS inline-edit shortcut opened the instruction dialog and a native diff proposal.
- Accept All Hunks closed the review and saved the scripted change. The change was verified on disk.
- Undo Last Applied Change restored the test file byte-for-byte to the original Flask baseline.
- A second proposal was rejected through Reject All Hunks; the test file remained identical to the baseline.
- The original Flask checkout was not changed.

The UI run exposed a completion-state bug: inline turns did not emit `turn.done` to the panel, which could leave
its status at “thinking…” and controls in their previous state. Inline outcomes now use the panel's completion
message and reset pending approvals, running state and status afterward. Four regression cases cover successful,
cancelled and failed outcomes, plus unexpected exceptions. The updated suite passes 53 tests across 8 files;
typecheck and build also pass.

The desktop automation intermittently returned stale or invalid accessibility elements during this run.
Interactive cancellation and individual per-hunk CodeLens clicks were not reliably verified. No real model
provider was configured in this environment, so full real-model Tasks A/B/C and the demo recording remain open.

## Submission polish verification - 19 November 2026

- 63 tests across 10 files pass; typecheck and all three bundles build.
- Five TrueForge/scripted-model end-to-end scenarios pass again.
- New panel/DOM checks cover the webview-ready handshake, preserved drafts after setup failure, command allowlisting, disposal of approvals, setup actions, main-thread rendering, escaped markup, keyboard-accessible cards and completed tool indicators.
- The actual webview assets were visually inspected in a local browser preview with representative VS Code dark/light tokens and a narrow viewport. This is a layout preview, not an additional real-model Extension Development Host run.
- `npm run package` creates a roughly 360 KB VSIX with 10 entries, restricted to runtime assets. Installation into an isolated VS Code profile succeeded and listed `tokenisers.anvil@0.1.0`.
- A clean temporary source copy passed `npm ci --ignore-scripts` and produced the VSIX, with no dependency on this workspace's node_modules. The npm dependency audit reports zero vulnerabilities.
- The 3-page review-draft PDF was exported from the eight-section write-up and visually checked. Its pending live-model/video evidence is explicit. The export source and submission checklist are in the repository; generated PDFs and VSIX files remain local artifacts.

The packaging CLI is pinned. Its minimatch dependency is overridden to the patched 11.0.1 release; packaging and clean-install checks exercised that combination. No new runtime dependency was introduced. Anvil now declares trusted local workspace requirements and enables diff CodeLens by default (explicit user configuration still takes precedence).


## Actual Extension Host regression run - 19 November 2026

`ANVIL_TEST_TRUEFORGE_URL=http://127.0.0.1:18790 npm run test:editor` passed five scenarios using the installed VS Code
1.143.1, TrueForge 0.185.1 and a local scripted multi-hunk provider. The tests run inside the real Extension Host
with a disposable workspace/profile, without the mocked vscode module:

1. Execute the first hunk's CodeLens accept action and the second hunk's reject action, finish review, and verify only the accepted hunk reaches disk.
2. Invoke Anvil undo and compare the restored file byte-for-byte with its baseline.
3. Cancel a task while its native diff review is pending; verify the task returns, the diff closes and the file remains unchanged.
4. Start a fresh task after cancellation and reject all hunks; verify the task completes and the file remains unchanged.
5. Close the native diff tab; verify it rejects the pending edit without hanging.

CodeLens actions are invoked through the same registered commands they expose in the editor. This verifies actual
editor behavior, not physical pointer interaction or real-model reasoning. The separate five-scenario headless suite
also passes after switching its mock endpoints to dynamically assigned ports and per-run provider names. Server
readiness is now explicit and providers/processes are cleaned up in finally blocks rather than reusing fixed ports.

GitHub metadata and the official competition page were checked on 19 November. The repository is still private;
visibility was not changed. The official deadline is 20 November 2026, 23:59 IST (21 November, 02:29 Singapore).
Source: https://techfest.org/competitions/forge-a-thon. Real-model credentials, exact Tasks A/B/C, video evidence,
final write-up evidence fields, repository visibility and submission remain open.


## Flask verification environment - 19 November 2026

Prepared a disposable Flask 3.1.3 checkout and a Git-ignored Python virtual environment before real-model evaluation.
All 58 existing tests in `tests/test_cli.py` pass with the verification dependencies pinned in
`scripts/flask-test-requirements.txt`. Pytest 9.2 could not collect this checkout because its internal `notset`
import was removed; pytest 8.4.2 and Click 8.1.8 provide the verified baseline. The demo setup now uses that file.
This is baseline verification, not evidence of completed model-generated Task B changes.

## Live Free Tier rehearsal - 19 November 2026

After the user confirmed Free Tier and disabled billing, the production TurnRunner and MCP tools were exercised
against disposable Flask 3.1.3 copies. The original Flask checkout and provider credentials were not committed.

- `gemini-2.5-flash-lite` returned 404, explicitly unavailable to new users. Google's suggested replacement,
  `gemini-3.5-flash-lite`, was checked against official Standard Free Tier pricing before updating local setup and examples.
- Task A used the same inline message format as the extension, with automatic headless review acceptance.
  Gemini proposed the edit, approval completed and the file changed. Ten false-value cases and three true-value
  cases passed. The resulting docstring lists explicit false literals but omits the empty-string case, so the
  entire submission criterion is not claimed complete. This run is not a real editor recording.
- The exact Task B prompt, without file names, called context assembly and discovered CLI locations, but repeated
  searches exhausted Google's 250,000 free input tokens per minute before any edit or command. The 429 response
  was recorded locally and all further model calls stopped. Task C was not run.
- Instructions now discourage identical repeated searches and call out unset/empty values when documenting
  boolean semantics. These prompt changes have not been evaluated against the live model after the quota stop.
- The opt-in `npm run test:live` command retains prompts, tool events, outcomes and verification output under
  ignored `output/verification/`, with a 20-iteration limit, four-minute turn timeout and no retries or subagents.
  Future runs use a smaller 4,000-token context pack and also require the inline docstring to mention the empty string.
- Typecheck, all 63 tests across 10 files and production/test bundles pass after the harness changes. The first
  restricted test attempt could not bind localhost sockets; rerunning with local networking allowed passed.

Pricing reference checked during the run: https://aistudio.google.com/docs/pricing.


## Free-tier quota safeguards - 19 November 2026

Diagnosis of the live Task B stop, from the retained `output/verification/live-2026-11-19T10-33-14-952Z/` events:
14 model calls in about 60 s, each resending the conversation (3k rising to 22.6k input tokens), together over
Gemini's 250,000-input-tokens-per-minute free limit. The same `search_workspace` query ran three times with an
identical 21-match result. Gemini's 429 said "Please retry in 39.2s"; TrueForge's own short retries gave up and the
turn ended. History never reached the 60k compaction trigger, so earlier compaction would not have changed this run.

Changes:
- Runner: a per-minute 429 (`rateLimitWaitMs`: honours "retry in Ns"/Retry-After, 60 s default, 90 s cap, daily
  quotas excluded) is waited out, then the same session gets a short continue message. Up to 4 waits per task;
  they do not consume retries; cancellation during the wait returns immediately. Safe after accepted edits because
  nothing is replayed.
- MCP server: an identical read-only call (read_file, list_dir, search_workspace, find_symbols, assemble_context)
  whose result is also identical, within the same turn, returns a one-line note instead of the full output.
  Results are compared, so a file edited mid-turn is still returned in full.

Verified:
- 68 tests across 10 files pass (5 new: wait parsing, continue-not-replay after an edit, cancel during the wait,
  daily quota falls back, repeated-search collapse incl. changed result and new turn); typecheck and build pass.
- New e2e scenario against real TrueForge 0.185.1: from the 4th request the mock returns 429 for 12 s. TrueForge
  retried twice (~2 s) then failed the turn; Anvil waited 11 s, continued session `01m7sq4y…`, and finished with
  the edit applied exactly once and no fallback. All 6 e2e scenarios pass.
- Not yet run against live Gemini.

## Live check of the rate-limit and fallback changes, 19 November 2026

- With a 4,000-token context budget and an unbilled Gemini 3.5 Flash-Lite project, Task B hit a genuine per-minute limit, displayed a 56-second wait, then resumed making tool calls in the same TrueForge session. Repeated search results were shortened in the trace. Gemini identified the implementation, tests and documentation but ended with a plan and zero edit reviews. The verification correctly failed.
- In two Task C runs, the local primary returned 503 and the real Gemini fallback proposed an edit. All 14 behavior checks passed both times. Its docstring omitted the empty string, so the full check failed.
- The Task B verifier now invokes Flask's built-in CLI group with a test app. Flask's application-specific CLI group, previously used by this check, does not contain the built-ins. The rehearsal timeout for B is ten minutes to accommodate provider waits.

- A fresh Task B run with revised edit instructions and no example Flask file names reached the configured 20-iteration limit while gathering context, with zero reviewed edits. The runner now reports that limit explicitly and keeps a normal chat available for follow-up. A new fallback session also starts with fresh lookup history, so the fallback can read results that only the primary saw.
