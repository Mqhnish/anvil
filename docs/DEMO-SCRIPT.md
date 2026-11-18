# Demo script — Round 1 video (≤ 4 minutes, Tasks A → B → C, each followed by on-screen verification)

Rules recap: screen recording with the editor visible; do **not** cut between giving an instruction and the diff
appearing (cutting model wait time elsewhere is fine); show the TrueForge session briefly during Task B; public link
(YouTube unlisted or Drive "anyone with the link"). Narration/captions optional.

## Before recording

```bash
# 1. pinned repo
git clone --branch 3.1.3 https://github.com/pallets/flask ../flask && cd ../flask && git log -1 --oneline   # 22d9247
python3 -m venv .venv && source .venv/bin/activate && pip install -e . pytest
git status   # clean

# 2. TrueForge with a real model + a fallback configured (Settings → Models); note the FQNs
cd ../anvil && ./trueforge/start.sh

# 3. extension: F5 ("Run Anvil extension (Flask workspace)") → pick primary + fallback via the Anvil commands
```

Window layout: VS Code full screen, Anvil panel on the left (activity bar → Anvil), terminal at the bottom, a browser
tab with http://localhost:8790/sessions ready for Task B.

Keep a small sticky note with the exact instructions (copy-paste is fine on screen).

## Task A — Inline edit (single file)  ~50 s

1. Open `src/flask/helpers.py`, select the whole `get_debug_flag` function (lines 28–33).
2. Press `Ctrl+Cmd+I` (Mac) / `Ctrl+Alt+I`. Type exactly:
   > Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
3. Do not cut: the diff editor opens with the proposal. Show the per-hunk CodeLens, click **Accept** on the hunk (or
   *Accept all*). The diff closes; `helpers.py` is updated.
4. Verify in the terminal:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   Must print `False`. (Optionally also `FLASK_DEBUG=N` → `False`, `FLASK_DEBUG=1` → `True`.)
5. Say/caption: "Edit went through TrueForge tool approval; nothing was written until I accepted the hunk. Cmd+Z undoes it."

## Task B — Agent mode (≥ 3 files, none named)  ~120 s

1. `git stash` (or commit Task A) so `git status` is clean. Open the Anvil panel. Paste exactly:
   > Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
2. Do not cut while it works. Point at the **Context pack** card: files chosen with reasons and the token budget
   (expect `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`, `src/flask/config.py`…). The agent's short
   "files I will change and why" paragraph streams in.
3. For each `propose_edit` a diff opens: review hunks, accept. (If the agent offers to run pytest, **Allow** in the
   approval card — that is also a nice on-screen moment.)
4. Switch briefly to the browser: TrueForge → Sessions → the current session (the panel's *session ↗* chip opens it):
   show the turns and tool calls (`assemble_context`, `read_file`, `propose_edit`…). Back to VS Code.
5. Verify in the terminal:
   ```bash
   pytest tests/test_cli.py -q
   cd examples/tutorial && pip install -e . -q && FLASK_APP=flaskr flask config | head -20   # masked JSON
   git --no-pager diff --stat     # must list ≥ 3 files
   ```
   (Any Flask app works for `flask config`; the tutorial app is in the repo. `SECRET_KEY` must show as `"***"`.)

## Task C — Resilience  ~45 s

Two variants; the rubric's top anchor is automatic fallback, so show that, and mention the no-fallback message.

1. In TrueForge **Settings → Models**, edit the primary provider: set an invalid API key (or point a custom provider at
   `http://127.0.0.1:1`). Keep the fallback provider valid. (Alternative without touching keys: in Anvil settings set
   `anvil.model.primary` to a model of the `dead` mock provider — `node scripts/mock-model.mjs --port 8998 --fail 503`
   registered as provider `dead` — and keep your real model as fallback.)
2. `git status` → clean. Repeat Task A exactly (select `get_debug_flag`, same instruction).
3. On screen: the status line shows *model error — retry 1/2 …*, then the notice **"Primary model … failed. Falling
   back to … automatically."**, then the diff appears from the fallback model; the editor stayed responsive throughout
   (scroll/type in another file while it retries). Reject the hunk this time, or accept — either way then run:
   ```bash
   git status            # no files changed if rejected
   ```
4. Optional 10 s: remove the fallback (`Anvil: Select Fallback Model → (none)`), repeat: clear error toast
   "The model is unavailable … This turn did not apply edits or run commands.", `git status` clean.

## After recording

- Note timestamps for the scorecard table in `WRITEUP.md` §6 (one row per criterion A1–C2).
- Upload (YouTube unlisted). Put the link, the repo URL and the PDF link into the Techfest portal — **Team Leader only**.
- Flip the GitHub repo to **public** before the deadline; links not public at the deadline are not scored.
