import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUsd, rateFor } from '../server/cost';

afterEach(() => { delete process.env.DOCAI_MODEL_PRICES; });

describe('cost estimates', () => {
  it('resolves provider-prefixed model ids (as reported by extractDocument)', () => {
    expect(rateFor('openai', 'openai/gpt-4.1')).toMatchObject({ inputPerM: 2, outputPerM: 8, known: true });
    expect(estimateCostUsd('openai', 'openai/gpt-4o-mini', 1_000_000, 0)).toBeCloseTo(0.15);
  });
  it('marks unknown models as estimated with the provider average', () => {
    expect(rateFor('anthropic', 'anthropic/some-new-model')).toMatchObject({ known: false, inputPerM: 3 });
  });
  it('accepts price overrides from DOCAI_MODEL_PRICES', () => {
    process.env.DOCAI_MODEL_PRICES = JSON.stringify({ 'gpt-5.6-luna': { inputPerM: 0.2, outputPerM: 0.8 } });
    expect(rateFor('openai', 'openai/gpt-5.6-luna')).toMatchObject({ inputPerM: 0.2, known: true });
    process.env.DOCAI_MODEL_PRICES = '{broken';
    expect(rateFor('openai', 'gpt-4.1').known).toBe(true);
  });
});
