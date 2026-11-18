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
