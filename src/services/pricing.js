const { getPricingForDate } = require('./price-history');

// Hardcoded fallback prices (per million tokens).
// Primary source is price-history.json; this is used only when history lookup fails.
const MODEL_PRICING = {
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
  opus:   MODEL_PRICING['opus-4.7'],
  sonnet: MODEL_PRICING['sonnet-4.6'],
  haiku:  MODEL_PRICING['haiku-4.5'],
};

function getModelPricing(modelName) {
  if (!modelName) return FAMILY_DEFAULT.sonnet;
  const m = modelName.toLowerCase();

  // Match "<family>-<major>-<minor>" e.g. claude-opus-4-7, claude-sonnet-4-5-20251001.
  const match = m.match(/(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (match) {
    const family = match[1];
    const major = match[2];
    const minor = match[3];
    const key = minor != null ? `${family}-${major}.${minor}` : `${family}-${major}`;
    if (MODEL_PRICING[key]) return MODEL_PRICING[key];
    if (FAMILY_DEFAULT[family]) return FAMILY_DEFAULT[family];
  }

  if (m.includes('opus'))   return FAMILY_DEFAULT.opus;
  if (m.includes('haiku'))  return FAMILY_DEFAULT.haiku;
  return FAMILY_DEFAULT.sonnet;
}

function getModelKey(modelName) {
  if (!modelName) return null;
  const m = modelName.toLowerCase();
  const match = m.match(/(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (!match) return null;
  return match[3] != null ? `${match[1]}-${match[2]}.${match[3]}` : `${match[1]}-${match[2]}`;
}

function calcCost(input, output, cacheCreate, cacheRead, modelName, date) {
  const key = getModelKey(modelName);
  const hist = getPricingForDate(key, date || null);
  if (hist) {
    return (input / 1e6) * hist.input
         + (output / 1e6) * hist.output
         + (cacheCreate / 1e6) * hist.cacheWrite5m
         + (cacheRead / 1e6) * hist.cacheRead;
  }
  // Fall back to hardcoded rates
  const p = getModelPricing(modelName);
  return (input / 1e6) * p.input
       + (output / 1e6) * p.output
       + (cacheCreate / 1e6) * p.input * 1.25
       + (cacheRead / 1e6) * p.input * 0.10;
}

module.exports = { MODEL_PRICING, getModelPricing, calcCost };
