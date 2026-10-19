'use strict';
/**
 * Resolve a model's real context window from pi's own model config.
 *
 * Sources (later wins):
 *   1. ~/.pi/agent/models-store.json — refreshed provider catalogs
 *   2. ~/.pi/agent/models.json       — user model definitions
 *   3. ~/.pi/agent/models.json       — modelOverrides (topmost, same as pi)
 *
 * Session transcripts only record provider + model id, so legacy providers
 * that no longer exist (e.g. apikey.fun-*) fall back to normalized model-id
 * matching, then a family match, then the regex table.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PI_DIR = process.env.PI_DIR || path.join(os.homedir(), '.pi');
const AGENT_DIR = path.join(PI_DIR, 'agent');
const MODELS_JSON = path.join(AGENT_DIR, 'models.json');
const MODELS_STORE = path.join(AGENT_DIR, 'models-store.json');

const FALLBACK_WINDOWS = [
  [/claude/i, 200000],
  [/kimi/i, 256000],
  [/glm-?4\.[67]/i, 128000],
  [/gpt-?5/i, 400000],
  [/gpt-?4/i, 128000],
  [/gemini/i, 1000000],
  [/deepseek/i, 128000],
];
const DEFAULT_WINDOW = 200000;

let cache = null;

function statKey() {
  const out = [];
  for (const file of [MODELS_JSON, MODELS_STORE]) {
    try {
      const st = fs.statSync(file);
      out.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      out.push('missing');
    }
  }
  return out.join('|');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function normModelId(id) {
  return String(id || '')
    .replace(/^~/, '')
    .split('/')
    .pop()
    .trim()
    .toLowerCase();
}

function normProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function providerTokens(provider) {
  return new Set(normProvider(provider).split(/[^a-z0-9]+/).filter(Boolean));
}

// "deepseek-v4.1-flash" -> "deepseekv41"; used for legacy ids such as
// "deepseek-v4-flash" whose exact entry disappeared from the catalog.
function familyKey(id) {
  return normModelId(id)
    .split('-')
    .slice(0, 2)
    .join('')
    .replace(/\./g, '');
}

function collect() {
  const byProvider = new Map();
  const add = (provider, id, window) => {
    const mid = normModelId(id);
    if (!mid || !Number.isFinite(window) || window <= 0) return;
    byProvider.set(`${normProvider(provider)}\0${mid}`, {
      provider: normProvider(provider),
      model: mid,
      window,
    });
  };

  const store = readJson(MODELS_STORE) || {};
  const storeProviders = store.providers || store;
  for (const [provider, entry] of Object.entries(storeProviders)) {
    const models = Array.isArray(entry) ? entry : entry && entry.models;
    for (const m of models || []) add(provider, m.id, m.contextWindow);
  }

  const config = readJson(MODELS_JSON) || {};
  for (const [provider, conf] of Object.entries(config.providers || {})) {
    for (const m of conf.models || []) add(provider, m.id, m.contextWindow);
    for (const [mid, override] of Object.entries(conf.modelOverrides || {})) {
      if (override && override.contextWindow) add(provider, mid, override.contextWindow);
    }
  }

  const byModel = new Map();
  for (const entry of byProvider.values()) {
    let list = byModel.get(entry.model);
    if (!list) byModel.set(entry.model, (list = []));
    list.push(entry);
  }

  return { key: statKey(), byProvider, byModel };
}

function getCache() {
  const key = statKey();
  if (!cache || cache.key !== key) cache = { key, ...collect() };
  return cache;
}

function pickWindow(entries, provider) {
  if (!entries.length) return null;
  const requested = normProvider(provider);
  const same = entries.find((e) => e.provider === requested);
  if (same) return same.window;

  const tokens = providerTokens(provider);
  const scored = entries.map((entry) => {
    let score = 0;
    for (const token of providerTokens(entry.provider)) if (tokens.has(token)) score++;
    return { entry, score };
  });
  const bestScore = Math.max(...scored.map((s) => s.score));
  const pool = bestScore > 0 ? scored.filter((s) => s.score === bestScore).map((s) => s.entry) : entries;

  // Most common value among the closest provider candidates; ties go to the
  // larger window (the catalog's own value beats an arbitrary guess).
  const counts = new Map();
  for (const entry of pool) counts.set(entry.window, (counts.get(entry.window) || 0) + 1);
  let winner = null;
  let bestCount = -1;
  for (const [window, count] of counts) {
    if (count > bestCount || (count === bestCount && window > winner)) {
      winner = window;
      bestCount = count;
    }
  }
  return winner;
}

function getContextWindow(provider, model) {
  const id = normModelId(model);
  if (!id) return DEFAULT_WINDOW;
  const c = getCache();

  const exact = c.byProvider.get(`${normProvider(provider)}\0${id}`);
  if (exact) return exact.window;

  const requested = normProvider(provider);
  const sameModel = c.byModel.get(id) || [];
  const sameProviderModel = sameModel.filter((e) => e.provider === requested);
  if (sameProviderModel.length) {
    const window = pickWindow(sameProviderModel, provider);
    if (window) return window;
  }

  const family = familyKey(model);
  const familyEntries = [];
  if (family) {
    for (const [modelId, entries] of c.byModel) {
      const candidate = modelId
        .split('-')
        .slice(0, 2)
        .join('')
        .replace(/\./g, '');
      if (candidate.startsWith(family) || family.startsWith(candidate)) {
        familyEntries.push(...entries);
      }
    }
  }
  const sameProviderFamily = familyEntries.filter((e) => e.provider === requested);
  if (sameProviderFamily.length) {
    const window = pickWindow(sameProviderFamily, provider);
    if (window) return window;
  }

  // No entry for this provider: prefer an exact model-id hit anywhere, then a
  // same-family guess, both resolved by provider-name overlap.
  if (sameModel.length) {
    const window = pickWindow(sameModel, provider);
    if (window) return window;
  }
  if (familyEntries.length) {
    const window = pickWindow(familyEntries, provider);
    if (window) return window;
  }

  const raw = String(model);
  for (const [re, window] of FALLBACK_WINDOWS) if (re.test(raw)) return window;
  return DEFAULT_WINDOW;
}

module.exports = { getContextWindow };
