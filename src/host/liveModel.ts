const FREE_TIER_MODEL = 'google-gemini/gemini-3-5-flash-lite';

export function confirmedLiveModel(args: string[], configuredModel?: string): string {
  const index = args.indexOf('--model');
  const model = index >= 0 ? args[index + 1] : configuredModel ?? FREE_TIER_MODEL;
  if (!model?.trim() || model.startsWith('--')) throw new Error('Specify a provider/model after --model or in ANVIL_LIVE_MODEL.');
  if (args.includes('--cost-confirmed')) return model;
  if (!args.includes('--free-tier-confirmed')) {
    throw new Error('Confirm Gemini Free Tier with billing disabled using --free-tier-confirmed, or explicitly accept the selected model using --cost-confirmed.');
  }
  if (model !== FREE_TIER_MODEL) {
    throw new Error(`--free-tier-confirmed covers only ${FREE_TIER_MODEL}. Selected model: ${model}. Check --model and ANVIL_LIVE_MODEL.`);
  }
  return model;
}
