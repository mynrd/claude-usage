// Per-million-token USD list prices.
// Source: https://platform.claude.com/docs/en/about-claude/pricing (verified 2026-05-20).
// Cache multipliers: 5m write = 1.25x input, 1h write = 2x input, cache read/refresh = 0.10x input.
export const MODEL_PRICING = {
  'fable-5':     { input: 10,   output: 50 },
  'mythos-5':    { input: 10,   output: 50 },
  'opus-4.8':    { input: 5,    output: 25 },
  'opus-4.7':    { input: 5,    output: 25 },
  'opus-4.6':    { input: 5,    output: 25 },
  'opus-4.5':    { input: 5,    output: 25 },
  'opus-4.1':    { input: 15,   output: 75 },
  'opus-4':      { input: 15,   output: 75 },
  'sonnet-4.6':  { input: 3,    output: 15 },
  'sonnet-4.5':  { input: 3,    output: 15 },
  'sonnet-4':    { input: 3,    output: 15 },
  'haiku-4.5':   { input: 1,    output: 5  },
  'haiku-3.5':   { input: 0.80, output: 4  },
};

// Fallback when a family is recognized but the version is unknown — use newest pricing.
const FAMILY_DEFAULT = {
  fable:  MODEL_PRICING['fable-5'],
  mythos: MODEL_PRICING['mythos-5'],
  opus:   MODEL_PRICING['opus-4.8'],
  sonnet: MODEL_PRICING['sonnet-4.6'],
  haiku:  MODEL_PRICING['haiku-4.5'],
};

export function getModelPricing(modelName) {
  if (!modelName) return FAMILY_DEFAULT.sonnet;
  const m = modelName.toLowerCase();

  // Match "<family>-<major>-<minor>" e.g. claude-opus-4-7, claude-sonnet-4-5-20251001.
  const match = m.match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (match) {
    const family = match[1];
    const major = match[2];
    const minor = match[3];
    const key = minor != null ? `${family}-${major}.${minor}` : `${family}-${major}`;
    if (MODEL_PRICING[key]) return MODEL_PRICING[key];
    if (FAMILY_DEFAULT[family]) return FAMILY_DEFAULT[family];
  }

  if (m.includes('fable'))  return FAMILY_DEFAULT.fable;
  if (m.includes('mythos')) return FAMILY_DEFAULT.mythos;
  if (m.includes('opus'))   return FAMILY_DEFAULT.opus;
  if (m.includes('haiku'))  return FAMILY_DEFAULT.haiku;
  return FAMILY_DEFAULT.sonnet;
}

export function estimateCost(input, output, cacheCreate, cacheRead, modelName) {
  const p = getModelPricing(modelName);
  return (input / 1_000_000) * p.input
       + (output / 1_000_000) * p.output
       + (cacheCreate / 1_000_000) * p.input * 1.25
       + (cacheRead / 1_000_000) * p.input * 0.10;
}

export function formatCost(cost) {
  if (cost < 0.01) return '<$0.01';
  return '$' + cost.toFixed(2);
}
