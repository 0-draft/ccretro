// API list prices in USD per million tokens, from Anthropic's published pricing
// as of 2026-10-06. This is an *API-equivalent* estimate: on a Pro/Max plan you
// don't pay these amounts, but they show what the usage would cost on the API.
// Override or extend with "pricing" in ~/.config/ccretro/config.json.
export const PRICING_AS_OF = '2026-10-06';

// read = cache read. Cache writes are 1.25x input (5-minute TTL) and 2x (1-hour).
export const PRICES = {
  'claude-fable-5-1': { in: 10, out: 50, read: 0.25 },
  'claude-mythos-5-1': { in: 10, out: 50, read: 0.25 },
  'claude-fable-5': { in: 10, out: 50, read: 1 },
  'claude-mythos-5': { in: 10, out: 50, read: 1 },
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2 },
  'claude-opus-5': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-7': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-6': { in: 5, out: 25, read: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.2 },
  'claude-sonnet-5': { in: 2, out: 10, read: 0.2 },
  'claude-sonnet-4-6': { in: 3, out: 15, read: 0.3 },
  // Haiku 5.5 is tiered by prompt size; the collector tags >100K prompts.
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01 },
  'claude-haiku-5-5@>100k': { in: 0.5, out: 2.5, read: 0.05 },
  'claude-haiku-4-5': { in: 1, out: 5, read: 0.1 },
  // Fast mode is billed at 2x the model's standard rates.
  'claude-opus-5-5@fast': { in: 8, out: 40, read: 0.4 },
  'claude-opus-5@fast': { in: 10, out: 50, read: 1 },
};

// "claude-haiku-4-5-20251001" → "claude-haiku-4-5"; keep "@tier" suffixes.
export function canonical(model) {
  const [base, tier] = model.split('@');
  const b = base.replace(/-\d{8}$/, '').replace(/^(us\.|eu\.|apac\.|global\.)?anthropic\./, '');
  return tier ? `${b}@${tier}` : b;
}

export function priceOf(model, overrides = {}) {
  const c = canonical(model);
  return overrides[c] || overrides[model] || PRICES[c] || null;
}

// tokens: { in, out, cr, cc5, cc1h } → USD, or null when the model has no known price.
export function costOf(model, t, overrides) {
  const p = priceOf(model, overrides);
  if (!p) return null;
  const read = p.read ?? p.in * 0.1;
  return (t.in * p.in + t.out * p.out + t.cr * read + t.cc5 * p.in * 1.25 + t.cc1h * p.in * 2) / 1e6;
}
