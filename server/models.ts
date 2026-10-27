export const providerIds = ['openai', 'gemini', 'anthropic', 'azure_openai', 'azure_claude'] as const;
export type Provider = (typeof providerIds)[number];

/** Display name + API id for the Settings select. */
export type ModelOption = { id: string; label: string };

/** Providers that need a resource endpoint (Azure OpenAI / Azure AI Foundry Claude). */
export const endpointProviders = ['azure_openai', 'azure_claude'] as const;
export function needsEndpoint(provider: Provider) {
  return (endpointProviders as readonly string[]).includes(provider);
}

/** Curated models for document extraction — always selectable in Settings. */
export const recommendedModelOptions: Record<Provider, ModelOption[]> = {
  openai: [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · швидка / дешева' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · баланс' },
    { id: 'gpt-5.6', label: 'GPT-5.6 Sol · флагман 5.6' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (повний id)' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra · найпотужніша' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini · сумісність' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
  ],
  gemini: [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · актуальна' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · найдешевша' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 · рекомендована' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 · швидка' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 · максимум' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 · legacy' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 · legacy' },
  ],
  // Azure: «модель» = ім’я deployment у ресурсі Azure
  azure_openai: [
    { id: 'gpt-4o-mini', label: 'Deployment: gpt-4o-mini' },
    { id: 'gpt-4o', label: 'Deployment: gpt-4o' },
    { id: 'gpt-4.1', label: 'Deployment: gpt-4.1' },
    { id: 'gpt-4.1-mini', label: 'Deployment: gpt-4.1-mini' },
  ],
  azure_claude: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Azure)' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Azure)' },
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1 (Azure)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Azure)' },
  ],
};

export const recommendedModels: Record<Provider, string[]> = {
  openai: recommendedModelOptions.openai.map((m) => m.id),
  gemini: recommendedModelOptions.gemini.map((m) => m.id),
  anthropic: recommendedModelOptions.anthropic.map((m) => m.id),
  azure_openai: recommendedModelOptions.azure_openai.map((m) => m.id),
  azure_claude: recommendedModelOptions.azure_claude.map((m) => m.id),
};

export const defaultModels: Record<Provider, string> = {
  openai: 'gpt-5.6-luna',
  gemini: 'gemini-3.8-flash',
  anthropic: 'claude-sonnet-5',
  azure_openai: 'gpt-4o-mini',
  azure_claude: 'claude-sonnet-4-5',
};

const useful: Record<Provider, RegExp> = {
  openai: /^(gpt-|o[1-9]|chatgpt-)/i,
  gemini: /^gemini-/i,
  anthropic: /^claude-/i,
  azure_openai: /./, // deployment names are arbitrary
  azure_claude: /^(claude-|[a-z0-9][a-z0-9._-]{1,80})$/i,
};

/** Merge API list with curated defaults; drop embeddings and other non-chat IDs.
 * After a successful key check (fromApi non-empty), only models the key can see are returned.
 */
export function presentModels(provider: Provider, fromApi: string[] = []) {
  const curated = recommendedModels[provider];
  const filtered = fromApi
    .map((id) => id.replace(/^models\//, ''))
    .filter((id) => useful[provider].test(id) && !/embedding|tts|whisper|realtime|transcribe|image|moderation|dall-e|babbage|davinci|ada|curie|cyber|daybreak|rosalind|instruct/i.test(id));

  // Before «Перевірити» — show curated recommendations.
  if (!fromApi.length) return curated;

  const apiSet = new Set(filtered);
  const preferred = curated.filter((id) => apiSet.has(id));
  const rest = filtered.filter((id) => !preferred.includes(id));
  const rank = (id: string) => {
    if (/^(gpt-4o|gpt-4\.1|gpt-5|gpt-6|o[1-9]|claude-sonnet-5|claude-haiku|gemini-3|gemini-2\.5)/i.test(id)) return 0;
    if (/^gpt-3\.5-turbo/i.test(id)) return 1; // often available on limited OpenAI accounts
    if (/^gpt-4/i.test(id)) return 2;
    return 3;
  };
  rest.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return preferred.length ? [...preferred, ...rest] : rest;
}

export function presentModelOptions(provider: Provider, fromApi: string[] = []) {
  const labels = new Map(recommendedModelOptions[provider].map((m) => [m.id, m.label]));
  return presentModels(provider, fromApi).map((id) => ({ id, label: labels.get(id) || id }));
}
