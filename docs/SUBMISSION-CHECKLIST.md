# Submission handoff

Use the organiser's current instructions as the authority. The limits below follow this repository's recorded rubric.

## Prepared

- Installable `anvil-0.1.0.vsix`, built by `npm run package`; installed and recognized in an isolated VS Code profile.
- Reproducible npm lockfile, `npm run check`, and a runtime-only package allowlist.
- Setup guidance in the panel, native-theme styling, accessible controls, diff CodeLens enabled by default.
- Draft write-up with explicit evidence status and a click-by-click demo script.
- Automated tests and headless TrueForge scenarios; actual VS Code smoke results in `TESTLOG.md`.

## Finish before submitting

1. Configure a real primary model and distinct fallback in TrueForge Settings > Models. Start with the provider you already have access to; the example JSON includes OpenAI and Gemini. For a low-cost starting point, `trueforge/models.budget.example.json` includes GPT-4.1 mini and Gemini 2.5 Flash-Lite; copy it to `models.local.json` and fill keys locally. Keep keys local and off screen.
2. Select both models in Anvil. Run Tasks A, B and C from `DEMO-SCRIPT.md` using the pinned Flask checkout. Verify outputs, tests, review and undo. For Task B, name no files in the instruction and demonstrate at least three changed files.
3. Check individual hunk Accept/Reject and cancellation in VS Code. If per-hunk controls are missing, check `diffEditor.codeLens` (Anvil enables its default; an explicit user setting can override it).
4. Record the required <=4-minute video. Keep the instruction-to-diff interval continuous as the demo script specifies. Show the context card, verification commands and TrueForge session. Hide credentials.
5. Replace the pending live-model/cost/video fields and add scorecard timestamps in `WRITEUP.md`. Regenerate its 1-3-page PDF. The current PDF is labelled a review draft and is not evidence of a completed demo.
6. Verify repo, video and PDF links in a signed-out browser. The checklist calls for public accessibility; changing repository visibility and uploading the final submission remain team-leader actions.
7. Confirm the deadline and upload requirements in the current organiser portal, then submit the correct commit and files.

## Reproduce the software checks

```bash
npm ci
npm run check
npm run package
# Separate terminal:
./trueforge/start.sh
# Back in the project:
npm run e2e
```

The e2e suite uses mock-provider ports 8998 and 8999. Stop separately running mock servers first. It tests temporary copies of Flask. Real-model runs may incur API charges; no live-model result or cost has been claimed.

## PDF export

`python3 scripts/export-writeup.py` writes `output/pdf/anvil-writeup-draft.pdf` using ReportLab. Use the bundled Python runtime or install ReportLab in a virtual environment. Keep the draft label until the pending evidence is filled and verified.
