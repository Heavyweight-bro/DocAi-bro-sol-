/** Rough USD cost estimates per 1M tokens (list prices, for ops dashboards — not billing). */
import type { Provider } from './models';

type Rate = { inputPerM: number; outputPerM: number };

const byProvider: Record<Provider, Rate> = {
  openai: { inputPerM: 0.15, outputPerM: 0.6 },
  gemini: { inputPerM: 0.1, outputPerM: 0.4 },
  anthropic: { inputPerM: 3, outputPerM: 15 },
  azure_openai: { inputPerM: 0.15, outputPerM: 0.6 },
  azure_claude: { inputPerM: 3, outputPerM: 15 },
};

const byModel: Record<string, Rate> = {
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 },
  'gpt-4.1': { inputPerM: 2, outputPerM: 8 },
  'gpt-3.5-turbo': { inputPerM: 0.5, outputPerM: 1.5 },
  'gemini-2.5-flash': { inputPerM: 0.15, outputPerM: 0.6 },
  'gemini-2.5-flash-lite': { inputPerM: 0.05, outputPerM: 0.2 },
  'gemini-3.8-flash': { inputPerM: 0.1, outputPerM: 0.4 },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
  'claude-sonnet-5': { inputPerM: 3, outputPerM: 15 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
};

/**
 * Company-specific or newer prices without a code change:
 * DOCAI_MODEL_PRICES={"gpt-5.6-luna":{"inputPerM":0.2,"outputPerM":0.8}}
 */
function overrides(): Record<string, Rate> {
  try {
    const parsed = JSON.parse(process.env.DOCAI_MODEL_PRICES || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Accepts "gpt-4o-mini" or "openai/gpt-4o-mini" (the form extractDocument reports). */
export function rateFor(provider: Provider, model: string): Rate & { known: boolean } {
  const id = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const custom = overrides()[id];
  if (custom && Number.isFinite(custom.inputPerM) && Number.isFinite(custom.outputPerM)) return { ...custom, known: true };
  if (byModel[id]) return { ...byModel[id], known: true };
  return { ...(byProvider[provider] || { inputPerM: 1, outputPerM: 3 }), known: false };
}

export function estimateCostUsd(provider: Provider, model: string, inputTokens: number, outputTokens: number) {
  const rate = rateFor(provider, model);
  const usd = (inputTokens / 1_000_000) * rate.inputPerM + (outputTokens / 1_000_000) * rate.outputPerM;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
