# Submission handoff

Official requirements checked on 19 November: [Techfest Forge-a-thon](https://techfest.org/competitions/forge-a-thon).
Round 1 is due **20 November 2026, 23:59 IST**, equivalent to **21 November 2026, 02:29 Singapore time**.
The official page requires a public repository, a 1-3-page PDF and a public demo video of at most four minutes.

## Round 1 submission

- Repository, public: https://github.com/Mqhnish/anvil
- Demo video, 3:59, narrated: https://youtu.be/Y9m8YrG-_PE
- Write-up: `WRITEUP.md`, exported to a 3-page PDF with `scripts/export-writeup.py`

The video was recorded in a real VS Code window on MiniMax M3.1 Flash through NVIDIA's free developer API,
configured in local TrueForge. Per-take results are in `TESTLOG.md`; the timed narration is in `VOICEOVER.md`.
No paid model was used. Before submission the full git history was checked for API keys and none were found;
provider keys live only in the git-ignored `trueforge/models.local.json`.

## Final checks before uploading

1. Open the repository, video and PDF links in a signed-out browser window.
2. Confirm the deadline and upload fields in the organiser portal (team leader only).
3. Submit the video link, repository URL and PDF.

## Reproduce the software checks

```bash
npm ci
npm run check
npm run package
# Separate terminal:
./trueforge/start.sh
# Back in the project:
npm run e2e
npm run test:editor  # installed VS Code required
```

The e2e and editor suites allocate their own mock ports and isolated provider names. `ANVIL_TEST_TRUEFORGE_URL` overrides the editor suite server URL; `ANVIL_CODE_BIN` selects a different VS Code CLI. It tests temporary copies of Flask. Real-model runs may incur API charges on paid projects.

## PDF export

`python3 scripts/export-writeup.py` writes `output/pdf/anvil-writeup.pdf` using ReportLab. Use the bundled Python runtime or install ReportLab in a virtual environment. Check the PDF is 1-3 pages after any edit.
