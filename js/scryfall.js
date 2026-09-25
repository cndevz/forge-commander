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

async function postCollection(identifiers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers }),
    });
    if (res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Scryfall a répondu ${res.status}`);
    return res.json();
  }
  throw new Error('Scryfall limite le nombre de requêtes, réessaie dans une minute.');
}

async function fetchNamedFuzzy(name) {
  const res = await fetch(`${API}/cards/named?fuzzy=${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  return res.json();
}

// requests : [{ key, name, set?, cn? }]
// Renvoie Map(key -> carte). onProgress(fait, total)
export async function fetchCards(requests, onProgress = () => {}) {
  const result = await cacheGetMany(requests.map((r) => r.key));
  let pending = requests.filter((r) => !result.has(r.key));
  const total = requests.length;
  onProgress(result.size, total);
  const toCache = [];

  const matchesRequest = (card, r) =>
    normalizeName(card.name) === r.key ||
    (card.card_faces && card.card_faces.some((f) => normalizeName(f.name) === r.key));

  // Passe 1 : impression exacte (extension + numéro) quand on l'a, sinon le nom.
  // Passe 2 : le nom seul. Passe 3 : recherche approximative, carte par carte.
  for (const pass of [1, 2]) {
    const next = [];
    for (let i = 0; i < pending.length; i += 75) {
      const chunk = pending.slice(i, i + 75);
      const ids = chunk.map((r) =>
        pass === 1 && r.set && r.cn ? { set: r.set, collector_number: r.cn } : { name: r.name.split(' // ')[0] }
      );
      const data = await postCollection(ids);
      const found = data.data || [];
      const used = new Set();
      for (const r of chunk) {
        const card = found.find((c, idx) => !used.has(idx) && matchesRequest(c, r));
        if (card) {
          used.add(found.indexOf(card));
          const slim = slimCard(card);
          result.set(r.key, slim);
          toCache.push([r.key, slim]);
        } else {
          next.push(r);
        }
      }
      onProgress(result.size, total);
      await sleep(110);
    }
    pending = next;
    if (!pending.length) break;
  }

  const notFound = [];
  for (const r of pending.slice(0, 40)) {
    const card = await fetchNamedFuzzy(r.name);
    if (card) {
      const slim = slimCard(card);
      result.set(r.key, slim);
      toCache.push([r.key, slim]);
    } else {
      notFound.push(r.name);
    }
    onProgress(result.size, total);
    await sleep(110);
  }
  for (const r of pending.slice(40)) notFound.push(r.name);

  await cachePutMany(toCache);
  return { cards: result, notFound };
}
