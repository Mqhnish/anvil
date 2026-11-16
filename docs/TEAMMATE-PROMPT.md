# Prompt for a teammate's Claude (Claude Code / claude.ai Code) working on github.com/Mqhnish/anvil

Copy everything below the line into a fresh Claude Code session opened on a clone of the repo.

---

You are working with Anay Sharma (team Tokenisers) on **Anvil**, our entry for the TrueFoundry Forge-a-thon at
Techfest IIT Bombay. Anvil is a VS Code extension: a coding agent whose loop runs on TrueForge (TrueFoundry's open-source
agent harness). The repo is https://github.com/Mqhnish/anvil (branch `main`). Round 1 is due **20 Nov 2026, 23:59 IST**
and needs three public artefacts: the repo, a ≤4-minute demo video of three fixed tasks on pallets/flask 3.1.3, and a
1–3 page PDF write-up with eight fixed headings.

Start by reading, in this order: `CLAUDE.md` (rules + current state + open work), `README.md`, `docs/DEMO-SCRIPT.md`,
`docs/RUBRIC.md`, `WRITEUP.md`. Then run the project's checks so you know the baseline is green:

```bash
npm install && npm run build && npm run typecheck && npm test
git clone --branch 3.1.3 https://github.com/pallets/flask ../flask     # the fixed competition repo, next to this one
./trueforge/start.sh      # in a second terminal; TrueForge local mode on :8790 with loopback allow-listed
npm run e2e               # headless end-to-end with the mock model; all 5 scenarios must pass
```

Hard constraints you must never break (they are eligibility gates, not style):
- The agent loop runs on TrueForge. Never add a direct model-provider client. Models are configured in TrueForge only.
- Editor capabilities stay MCP tools in `src/mcp/server.ts`; the agent decides what to read/change.
- No secrets in the repo (`trueforge/models.local.json` and `.env*` are git-ignored).
- `agent/anvil-agent.json` is the shipped agent definition; keep `src/trueforge/agentSpec.ts` in sync with it.
- MIT license and attribution stay; the starting point is "from scratch".

Your job this session (work in a branch, open a PR to `main`, small commits, `npm run typecheck && npm test` before
every commit, `npm run e2e` whenever you touch `src/trueforge`, `src/mcp` or `src/edit`):

1. **Real-model verification inside VS Code.** Configure a real model in TrueForge (Settings → Models; a free Gemini
   key works, or whatever Anay has) and a fallback. Press F5 (launch config *Run Anvil extension (Flask workspace)*)
   and run the three fixed tasks exactly as written in `docs/DEMO-SCRIPT.md`: Task A (inline edit of
   `get_debug_flag`), Task B (the `flask config` command, no files named), Task C (invalid key on the primary →
   automatic fallback). For each: does the diff open, do per-hunk Accept/Reject CodeLens work, does Finish apply only
   the accepted hunks, does `Anvil: Undo Last Applied Change` restore the file, does Esc cancel cleanly with
   `git status` clean, does the Context-pack card show files + reasons, does the TrueForge session page show the
   tool calls? Log every observation in `docs/TESTLOG.md` (what you did, what happened, screenshots optional) and fix
   what breaks. The most likely rough edges are in `src/edit/reviewer.ts` (CodeLens placement, decorations, closing
   the diff tab) and `src/ui/webview/main.js` (panel rendering) — those have never been exercised by a human yet.
2. **Prompt tuning.** If the model does not call `assemble_context` first, or names files it did not read, or sends
   search blocks with line-number prefixes, tighten the instructions in `agent/anvil-agent.json` (and the tool
   descriptions in `src/mcp/server.ts`). Keep the instructions model-agnostic: judges may rerun Task A with a model of
   their choice on a live call.
3. **Demo video.** Once A/B/C work reliably, record the video following `docs/DEMO-SCRIPT.md` (QuickTime/OBS, editor
   visible, no cuts between instruction and diff, TrueForge session shown during B, verification commands on screen).
   Upload as YouTube unlisted and put the link in `WRITEUP.md` §1; fill §6 scorecard timestamps and §5 model/cost.
4. **Write-up PDF.** Finish `WRITEUP.md` (keep the eight headings in that order), export to `docs/WRITEUP.pdf`
   (`pandoc WRITEUP.md -o docs/WRITEUP.pdf` or the Markdown PDF VS Code extension), 1–3 pages.

Do not refactor for its own sake, do not add dependencies without a reason, and do not spend time on anything the
rubric lists as out of scope (tab completion, hosting models, marketplace publishing, auth). If something in
`CLAUDE.md`'s "Open work" list is already done when you read it, skip it. When you finish a step, write a short
summary of what changed and what you verified in the PR description. Coordinate with Mohnish before touching
`src/trueforge/runner.ts` or `src/mcp/server.ts` so two people don't edit the same files at once.
