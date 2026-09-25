// Statistiques EDHREC pour un commandant : % de decks qui jouent chaque carte.
// EDHREC n'a pas d'API officielle ; on lit les fichiers JSON qui alimentent leur site.
import { normalizeName } from './parser.js';

const BASE = 'https://json.edhrec.com/pages';
const PROXIES = [
  (u) => u,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];

export const EDHREC_TAG_LABELS = {
  newcards: 'Nouveautés',
  highsynergycards: 'Haute synergie',
  topcards: 'Top cartes',
  gamechangers: 'Game Changers',
  creatures: 'Créatures',
  instants: 'Éphémères',
  sorceries: 'Rituels',
  utilityartifacts: 'Artefacts',
  enchantments: 'Enchantements',
  battles: 'Batailles',
  planeswalkers: 'Planeswalkers',
  utilitylands: 'Terrains utilitaires',
  manaartifacts: 'Artefacts de mana',
  lands: 'Terrains',
};

export function edhrecSlug(name) {
  return name
    .split(' // ')[0]
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

export function edhrecPageUrl(name) {
  return `https://edhrec.com/commanders/${edhrecSlug(name)}`;
}

async function getJson(url) {
  let lastError = null;
  for (const wrap of PROXIES) {
    try {
      const res = await fetch(wrap(url), { headers: { Accept: 'application/json' } });
      if (res.status === 404) throw Object.assign(new Error('not_found'), { notFound: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e.notFound) throw e;
      lastError = e;
    }
  }
  throw lastError || new Error('EDHREC injoignable');
}

function inclusionOf(cv) {
  const n = cv.num_decks != null ? cv.num_decks : cv.inclusion;
  if (n != null && cv.potential_decks) return n / cv.potential_decks;
  const m = typeof cv.label === 'string' && cv.label.match(/(\d+(?:\.\d+)?)%/);
  return m ? parseFloat(m[1]) / 100 : 0;
}

export function parseEdhrec(json) {
  const lists = (json && json.container && json.container.json_dict && json.container.json_dict.cardlists) || [];
  const cards = new Map();
  for (const list of lists) {
    const tag = list.tag || '';
    for (const cv of list.cardviews || []) {
      if (!cv || !cv.name) continue;
      const key = normalizeName(cv.name);
      const pct = Math.max(0, Math.min(1, inclusionOf(cv)));
      const existing = cards.get(key);
      if (existing) {
        existing.pct = Math.max(existing.pct, pct);
        existing.tags.add(tag);
        if (cv.synergy != null) existing.synergy = cv.synergy;
      } else {
        cards.set(key, {
          key,
          name: cv.name,
          pct,
          synergy: typeof cv.synergy === 'number' ? cv.synergy : 0,
          decks: cv.num_decks != null ? cv.num_decks : cv.inclusion || 0,
          tags: new Set([tag]),
        });
      }
    }
  }
  const numDecks = json.num_decks_avg || (json.container && json.container.json_dict && json.container.json_dict.card && json.container.json_dict.card.num_decks) || null;
  return { cards, numDecks };
}

const memo = new Map();

export async function fetchEdhrec(commanderName) {
  const slug = edhrecSlug(commanderName);
  if (memo.has(slug)) return memo.get(slug);

  const storageKey = `edhrec:${slug}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (cached) {
      const parsed = {
        numDecks: cached.numDecks,
        cards: new Map(cached.cards.map((c) => [c.key, { ...c, tags: new Set(c.tags) }])),
      };
      memo.set(slug, parsed);
      return parsed;
    }
  } catch {}

  let json = await getJson(`${BASE}/commanders/${slug}.json`);
  if (json && json.redirect) json = await getJson(`${BASE}${json.redirect}.json`);
  const parsed = parseEdhrec(json);
  if (!parsed.cards.size) throw new Error('Aucune donnée EDHREC pour ce commandant');
  memo.set(slug, parsed);
  try {
    const compact = {
      numDecks: parsed.numDecks,
      cards: [...parsed.cards.values()].map((c) => ({ ...c, tags: [...c.tags] })),
    };
    sessionStorage.setItem(storageKey, JSON.stringify(compact));
  } catch {}
  return parsed;
}
