# Zero-spend model setup

Use this path for the current submission. Do not enable billing, purchase credits, or use a key from an already-billed project.

1. Open [Google AI Studio API keys](https://aistudio.google.com/apikey) and create/select a project eligible for the Gemini API Free Tier. Confirm that billing is not enabled. If access requires payment, stop; do not upgrade.
2. Create a key and enter it directly into TrueForge Settings > Models using the `google-gemini` provider. Add model ID `gemini-3.5-flash-lite` with display name `gemini-3-5-flash-lite`.
3. In Anvil, select `google-gemini/gemini-3-5-flash-lite` as primary and leave the fallback empty during normal testing. Do not select a paid provider.
4. To reduce free-quota consumption during rehearsal, turn subagents off, use a 4,000-token context budget, set retries to zero and start with a 20-iteration limit. The initial 8,000-token rehearsal hit the free token quota. Two safeguards now apply in every run: when Gemini answers 429 with "Please retry in Ns" (per-minute quota), Anvil waits that long and continues the same session (up to 4 times per task) instead of failing; and an identical repeated search or read within one task returns a one-line "same result" note instead of the full output, which reduces the amount of repeated text in the conversation. Daily quotas are not waited out. Expect pauses of up to a minute in Task B on the free tier; live Gemini testing observed a 56-second wait followed by more tool calls in the same session.
5. If Google rejects the account/project or reports a quota error, pause. Do not enable billing or switch to a paid model. Availability and limits depend on the account, project, model and region. If an older model returns a deprecation/unavailable error, check official pricing and supported models before replacing it.

Alternative file setup: copy `trueforge/models.free.example.json` to the git-ignored `trueforge/models.local.json`, fill the key locally, then run `node trueforge/configure-models.mjs trueforge/models.local.json` while the local TrueForge server is running.

## Second free option: NVIDIA

NVIDIA's API catalog gives free developer access at build.nvidia.com: sign in, create a key (`nvapi-…`), and add it as a `custom` OpenAI-compatible provider with base URL `https://integrate.api.nvidia.com/v1`. `trueforge/models.free.example.json` already has the entry; Anvil's FQN is `nvidia/minimax-m3-1-flash`. Forum reports put the limit at about 40 requests a minute with no daily cap, and the access is meant for development, not production.

Tested on 20 November 2026 through local TrueForge with the live harness:
- MiniMax M3.1 Flash made real tool calls in about 13 s each. Task A ran the full loop in 26 s; all 14 behavior checks passed and the docstring omitted the empty string, as Gemini's did in rehearsals.
- Task B finished in 9 min 35 s with no file names given: reviewed edits to `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst`, two agent-run `pytest` commands, and 60 passing tests in `tests/test_cli.py`. `flask config` appears in `flask --help` and masks `SECRET_KEY`; its keyword match is case-sensitive, so a lowercase `access_token` was printed and the strict check failed.
- GLM 5.3 Flash and Kimi K3.1 Pro also made correct tool calls but took 70 to 230 s for a single short request, too slow for a task with dozens of calls.

OpenCode Zen's `-free` models are not usable here: its API answered every request with `FreeUsageLimitError` ("Free models work in OpenCode"), so they are free only inside the opencode app.

## Failure demonstration without a second paid provider

For Task C, temporarily use the local failing scripted provider described in `DEMO-SCRIPT.md` as primary and the working Free Tier Gemini model as fallback. That demonstrates a failed endpoint followed by a real-model response without paid API access. Restore Gemini as primary afterward. A headless rehearsal verified the automatic switch from a local 503 to Gemini and the resulting reviewed edit. Its docstring missed the empty-string case. The recorded video instead used a primary that refuses connections, with NVIDIA's MiniMax M3.1 Flash as the fallback.

## Important distinction

The model is also offered on paid projects. This configuration does not enforce a spending cap: the Google project's Free Tier eligibility and disabled billing are what matter. Free quotas may prevent a complete uninterrupted demo.

On 19 November, `gemini-2.5-flash-lite` returned 404 because it was unavailable to new users. Google's response suggested `gemini-3.5-flash-lite`, whose Standard Free Tier input/output pricing was checked before switching. The replacement produced the inline edit and passed 13 behavior checks; its docstring omitted the empty-string case. Task B hit the 250,000-input-token-per-minute free quota before editing. That rehearsal stopped at the first quota error. Later live runs are documented in the test log.

Official sources checked on 19 November 2026:
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing): Gemini 3.5 Flash-Lite lists free Standard input/output on the Free Tier.
- [Billing](https://ai.google.dev/gemini-api/docs/billing): upgrading from Free Tier requires enabling billing.
- [Access troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting): not all accounts/projects qualify for the Free Tier.
