# Zero-spend model setup

Use this path for the current submission. Do not enable billing, purchase credits, or use a key from an already-billed project.

1. Open [Google AI Studio API keys](https://aistudio.google.com/apikey) and create/select a project eligible for the Gemini API Free Tier. Confirm that billing is not enabled. If access requires payment, stop; do not upgrade.
2. Create a key and enter it directly into TrueForge Settings > Models using the `google-gemini` provider. Add model ID `gemini-2.5-flash-lite` with display name `gemini-2-5-flash-lite`.
3. In Anvil, select `google-gemini/gemini-2-5-flash-lite` as primary and leave the fallback empty during normal testing. Do not select a paid provider.
4. To reduce free-quota consumption during rehearsal, turn subagents off, use an 8,000-token context budget, set retries to zero and start with a 20-iteration limit. These are rehearsal settings, not a guarantee that every task will complete.
5. If Google rejects the account/project or reports a quota error, pause. Do not enable billing or switch to a paid model. Availability and limits depend on the account, project, model and region.

Alternative file setup: copy `trueforge/models.free.example.json` to the git-ignored `trueforge/models.local.json`, fill the key locally, then run `node trueforge/configure-models.mjs trueforge/models.local.json` while the local TrueForge server is running.

## Failure demonstration without a second paid provider

For Task C, temporarily use the local failing scripted provider described in `DEMO-SCRIPT.md` as primary and the working Free Tier Gemini model as fallback. That demonstrates a failed endpoint followed by a real-model response without paid API access. Restore Gemini as primary afterward. This setup still needs to be run and recorded; it is not claimed as completed evidence.

## Important distinction

The model is also offered on paid projects. This configuration does not enforce a spending cap: the Google project's Free Tier eligibility and disabled billing are what matter. Free quotas may prevent a complete uninterrupted demo. We have not verified real-model task quality yet.

Official sources checked on 19 November 2026:
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing): Gemini 2.5 Flash-Lite lists free input/output on the Free Tier.
- [Billing](https://ai.google.dev/gemini-api/docs/billing): upgrading from Free Tier requires enabling billing.
- [Access troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting): not all accounts/projects qualify for the Free Tier.
