// Données des cartes via l'API Scryfall, avec un cache IndexedDB dans le navigateur.
import { normalizeName } from './parser.js';

const API = 'https://api.scryfall.com';
const DB_NAME = 'forge-commander';
const STORE = 'cards';
const CACHE_VERSION = 2;
const CACHE_TTL = 1000 * 60 * 60 * 24 * 14; // 14 jours
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dbPromise = null;
function openDb() {
  if (!('indexedDB' in globalThis)) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function cacheGetMany(keys) {
  const db = await openDb();
  const out = new Map();
  if (!db) return out;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    for (const k of keys) {
      const r = store.get(k);
      r.onsuccess = () => {
        const v = r.result;
        if (v && v.v === CACHE_VERSION && Date.now() - v.t < CACHE_TTL) out.set(k, v.card);
      };
    }
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
  return out;
}

async function cachePutMany(pairs) {
  const db = await openDb();
  if (!db || !pairs.length) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const t = Date.now();
    for (const [k, card] of pairs) store.put({ v: CACHE_VERSION, t, card }, k);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

export async function clearCache() {
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

// On ne garde que ce dont l'application a besoin.
export function slimCard(c) {
  const faces = c.card_faces || [];
  const front = faces[0] || c;
  const img = c.image_uris || front.image_uris || {};
  const backImg = faces[1] && faces[1].image_uris;
  return {
    id: c.id,
    name: c.name,
    frontName: faces[0] ? faces[0].name : c.name,
    typeLine: c.type_line || faces.map((f) => f.type_line).join(' // '),
    frontType: front.type_line || c.type_line || '',
    text: c.oracle_text != null ? c.oracle_text : faces.map((f) => f.oracle_text || '').join('\n—\n'),
    manaCost: c.mana_cost || front.mana_cost || '',
    cmc: c.cmc != null ? c.cmc : front.cmc || 0,
    ci: c.color_identity || [],
    produced: c.produced_mana || [],
    legal: (c.legalities && c.legalities.commander) || 'not_legal',
    gameChanger: !!c.game_changer,
    img: img.normal || null,
    imgLarge: img.large || img.normal || null,
    imgBack: backImg ? backImg.normal : null,
    priceEur: (c.prices && (c.prices.eur || c.prices.eur_foil)) || null,
    set: c.set,
    cn: c.collector_number,
    uri: c.scryfall_uri,
    layout: c.layout,
  };
}

// Uniquement des requêtes GET sans en-tête particulier : le navigateur n'a pas besoin
// de demander d'autorisation préalable (CORS) à Scryfall.
async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 404 || res.status === 400) return null; // introuvable ou requête invalide
    if (!res.ok) throw new Error(`Scryfall a répondu ${res.status}`);
    return res.json();
  }
  throw new Error('Scryfall limite le nombre de requêtes, réessaie dans une minute.');
}

// Recherche Scryfall paginée ; renvoie toutes les cartes trouvées.
async function search(query, unique) {
  const out = [];
  let url = `${API}/cards/search?unique=${unique}&q=${encodeURIComponent(query)}`;
  while (url) {
    const page = await getJson(url);
    if (!page) break;
    out.push(...(page.data || []));
    url = page.has_more ? page.next_page : null;
    if (url) await sleep(110);
  }
  return out;
}

const quote = (s) => `"${s.replace(/"/g, '')}"`;

// Découpe en requêtes d'environ 1 500 caractères pour rester sous la limite d'URL.
function chunkQueries(items, toTerm) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const it of items) {
    const term = toTerm(it);
    if (cur.length && len + term.length > 1500) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push({ it, term });
    len += term.length + 4;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Vérifie si Scryfall répond (pour un message d'erreur utile).
export async function pingScryfall() {
  try {
    const res = await fetch(`${API}/cards/named?exact=Sol%20Ring`);
    return res.ok;
  } catch {
    return false;
  }
}

// requests : [{ key, name, set?, cn? }]
// Renvoie Map(key -> carte). onProgress(fait, total)
export async function fetchCards(requests, onProgress = () => {}) {
  const result = await cacheGetMany(requests.map((r) => r.key));
  let pending = requests.filter((r) => !result.has(r.key));
  const total = requests.length;
  onProgress(result.size, total);
  const toCache = [];
  const keep = (r, card) => {
    const slim = slimCard(card);
    result.set(r.key, slim);
    toCache.push([r.key, slim]);
  };
  const matchesName = (card, r) =>
    normalizeName(card.name) === r.key ||
    (card.card_faces && card.card_faces.some((f) => normalizeName(f.name) === r.key));

  // Passe 1 : l'impression exacte (extension + numéro), pour avoir la bonne illustration.
  const withPrinting = pending.filter((r) => r.set && r.cn);
  for (const chunk of chunkQueries(withPrinting, (r) => `(e:${r.set} cn:${quote(r.cn)})`)) {
    const found = await search(chunk.map((c) => c.term).join(' or '), 'prints');
    for (const { it: r } of chunk) {
      const card = found.find((c) => c.set === r.set && c.collector_number === r.cn && matchesName(c, r));
      if (card) keep(r, card);
    }
    onProgress(result.size, total);
    await sleep(110);
  }
  pending = pending.filter((r) => !result.has(r.key));

  // Passe 2 : le nom exact.
  for (const chunk of chunkQueries(pending, (r) => `!${quote(r.name.split(' // ')[0])}`)) {
    const found = await search(chunk.map((c) => c.term).join(' or '), 'cards');
    for (const { it: r } of chunk) {
      const card = found.find((c) => matchesName(c, r));
      if (card) keep(r, card);
    }
    onProgress(result.size, total);
    await sleep(110);
  }
  pending = pending.filter((r) => !result.has(r.key));

  // Passe 3 : recherche approximative, carte par carte (fautes de frappe, noms traduits…).
  const notFound = [];
  for (const [i, r] of pending.entries()) {
    const card = i < 40 ? await getJson(`${API}/cards/named?fuzzy=${encodeURIComponent(r.name)}`) : null;
    if (card) keep(r, card);
    else notFound.push(r.name);
    onProgress(result.size, total);
    if (i < 40) await sleep(110);
  }

  await cachePutMany(toCache);
  return { cards: result, notFound };
}
