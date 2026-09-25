import { parseCollection, normalizeName } from './parser.js';
import { fetchCards, pingScryfall } from './scryfall.js';
import { fetchEdhrec, edhrecPageUrl, EDHREC_TAG_LABELS } from './edhrec.js';
import { canBeCommander, primaryType, isBasicLand, detectRoles, ROLE_LABELS } from './roles.js';
import { buildDeck, deckToText } from './builder.js';

const $ = (id) => document.getElementById(id);

// Petit utilitaire de création d'éléments (textContent uniquement, pas d'innerHTML).
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(`forge:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`forge:${k}`, JSON.stringify(v));
    } catch {}
  },
};

const state = {
  entries: [], // lignes de la collection
  entriesByKey: new Map(),
  cards: new Map(), // key -> carte Scryfall allégée
  pool: [],
  commanders: [],
  commanderKey: store.get('commander'),
  deck: null,
  edhrec: null,
  edhrecError: null,
  suggest: { filter: 'all', shown: 48, cards: new Map() },
  owned: new Set(),
};

const fmtPct = (x) => `${Math.round(x * 100)} %`;
const fmtNum = (x, d = 2) => x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const cardmarketUrl = (name) => `https://www.cardmarket.com/fr/Magic/Products/Search?searchString=${encodeURIComponent(name.split(' // ')[0])}`;

function pipIcons(colors) {
  const list = colors.length ? colors : ['C'];
  return h('span', { class: 'pips', 'aria-label': `Identité : ${list.join('')}` },
    list.map((c) => h('img', { class: 'pip', src: `https://svgs.scryfall.io/card-symbols/${c}.svg`, alt: c, width: 16, height: 16 })));
}

function cardImage(card, cls = 'tile-img') {
  const wrap = document.createDocumentFragment();
  const img = h('img', { class: cls, src: card.img || '', alt: card.name, loading: 'lazy', decoding: 'async', width: 488, height: 680 });
  const fb = h('span', { class: 'tile-fallback', text: card.name, hidden: !!card.img });
  img.addEventListener('error', () => (fb.hidden = false));
  wrap.append(img, fb);
  return wrap;
}

/* ---------- 1. Collection ---------- */

async function importCollection(text, { save = true } = {}) {
  const status = $('collection-status');
  const { entries, ignored } = parseCollection(text);
  if (!entries.length) {
    status.replaceChildren(h('span', { class: 'err', text: 'Aucune carte reconnue. Vérifie que chaque ligne commence par une quantité, par exemple « 1 Sol Ring ».' }));
    return;
  }
  if (save) store.set('collection', text);
  $('collection-import').disabled = true;

  const bar = h('span', { style: 'width:0%' });
  const label = h('span', { text: 'Recherche des cartes sur Scryfall…' });
  status.replaceChildren(label, h('div', { class: 'progress' }, bar));

  const requests = entries.map((e) => ({ key: e.key, name: e.name, set: e.printings[0] && e.printings[0].set, cn: e.printings[0] && e.printings[0].cn }));
  let result;
  try {
    result = await fetchCards(requests, (done, total) => {
      bar.style.width = `${Math.round((done / total) * 100)}%`;
      label.textContent = `Recherche des cartes sur Scryfall… ${done}/${total}`;
    });
  } catch (e) {
    const reachable = await pingScryfall();
    const msg = reachable
      ? `Scryfall a refusé la recherche (${e.message}). Réessaie dans une minute.`
      : "Ton navigateur n'arrive pas à joindre api.scryfall.com. Désactive le bloqueur de pub ou l'extension de confidentialité pour ce site, ou essaie depuis un autre réseau (certains réseaux d'école ou d'entreprise bloquent ce site).";
    status.replaceChildren(h('span', { class: 'err', text: msg }));
    $('collection-import').disabled = false;
    return;
  }
  $('collection-import').disabled = false;

  state.entries = entries;
  state.entriesByKey = new Map(entries.map((e) => [e.key, e]));
  state.cards = result.cards;
  state.pool = entries.filter((e) => result.cards.has(e.key)).map((e) => ({ key: e.key, qty: e.qty, card: result.cards.get(e.key) }));
  state.owned = new Set();
  for (const p of state.pool) {
    state.owned.add(p.key);
    state.owned.add(normalizeName(p.card.name));
  }

  const totalQty = entries.reduce((a, e) => a + e.qty, 0);
  const commanders = state.pool.filter((p) => canBeCommander(p.card) && p.card.legal === 'legal');
  commanders.sort((a, b) => {
    const ha = state.entriesByKey.get(a.key).commanderHint ? 0 : 1;
    const hb = state.entriesByKey.get(b.key).commanderHint ? 0 : 1;
    return ha - hb || a.card.name.localeCompare(b.card.name);
  });
  state.commanders = commanders;

  const summary = h('div', { class: 'chips' },
    h('span', { class: 'chip', text: `${totalQty} cartes` }),
    h('span', { class: 'chip', text: `${entries.length} différentes` }),
    h('span', { class: 'chip', text: `${commanders.length} commandant${commanders.length > 1 ? 's' : ''} possible${commanders.length > 1 ? 's' : ''}` }));
  const parts = [summary];
  if (result.notFound.length) {
    parts.push(h('details', {}, h('summary', { text: `${result.notFound.length} carte${result.notFound.length > 1 ? 's' : ''} introuvable${result.notFound.length > 1 ? 's' : ''} sur Scryfall` }),
      h('p', { text: result.notFound.join(', ') })));
  }
  if (ignored.length) parts.push(h('span', { text: `${ignored.length} ligne(s) ignorée(s).` }));
  status.replaceChildren(...parts);

  if (!state.commanders.some((c) => c.key === state.commanderKey)) {
    const hinted = state.commanders.find((c) => state.entriesByKey.get(c.key).commanderHint);
    state.commanderKey = hinted ? hinted.key : null;
  }
  renderCommanders();
  state.deck = null;
  renderDeck();
  if (state.commanderKey) generate();
}

/* ---------- 2. Commandant ---------- */

function renderCommanders() {
  const list = $('commander-list');
  const q = normalizeName($('commander-filter').value || '');
  if (!state.commanders.length) {
    list.replaceChildren(h('p', { class: 'empty', text: state.pool.length ? 'Aucune créature légendaire dans cette collection.' : 'Importe ta collection pour voir tes créatures légendaires.' }));
    $('generate').disabled = true;
    return;
  }
  const items = state.commanders.filter((c) => !q || normalizeName(c.card.name).includes(q));
  list.replaceChildren(
    ...items.map((c) =>
      h('button', {
        type: 'button',
        class: 'cmd',
        role: 'option',
        'aria-selected': String(c.key === state.commanderKey),
        onclick: () => selectCommander(c.key),
      },
      h('img', { src: c.card.img || '', alt: '', loading: 'lazy', width: 38, height: 53 }),
      h('span', { class: 'cmd-name' }, c.card.name, h('span', { class: 'cmd-type', text: (c.card.frontType.split('—')[1] || '').trim() || 'Légendaire' })),
      pipIcons(c.card.ci))
    ),
    items.length ? null : h('p', { class: 'empty', text: 'Aucun commandant ne correspond.' })
  );
  $('generate').disabled = !state.commanderKey;
}

function selectCommander(key) {
  state.commanderKey = key;
  store.set('commander', key);
  state.deck = null;
  renderCommanders();
  renderDeck();
  renderSuggestions();
}

/* ---------- 3. Génération ---------- */

async function generate() {
  const cmd = state.commanders.find((c) => c.key === state.commanderKey);
  if (!cmd) return;
  const status = $('generate-status');
  const btn = $('generate');
  btn.disabled = true;
  status.replaceChildren(h('span', { text: `Lecture des statistiques EDHREC de ${cmd.card.name}…` }));

  if (!state.edhrec || state.edhrec.key !== cmd.key) {
    try {
      const data = await fetchEdhrec(cmd.card.name);
      state.edhrec = { key: cmd.key, ...data };
      state.edhrecError = null;
    } catch (e) {
      state.edhrec = { key: cmd.key, cards: new Map(), numDecks: null, failed: true };
      state.edhrecError = e.notFound
        ? `EDHREC n'a pas de page pour ${cmd.card.name}.`
        : "EDHREC est injoignable pour l'instant.";
    }
    state.suggest = { filter: 'all', shown: 48, cards: new Map() };
  }

  const randomness = Number($('randomness').value) / 100;
  const deck = buildDeck({
    commander: cmd.card,
    commanderKey: cmd.key,
    pool: state.pool,
    edhrec: state.edhrec.failed ? null : state.edhrec,
    randomness,
  });
  if (state.edhrecError) deck.warnings.unshift(`${state.edhrecError} Le deck est construit uniquement à partir du texte des cartes.`);
  state.deck = deck;
  status.replaceChildren();
  btn.disabled = false;
  btn.textContent = 'Générer un autre deck';
  renderDeck();
  renderSuggestions();
}

/* ---------- Affichage du deck ---------- */

const GROUPS = [
  ['creature', 'Créatures'],
  ['planeswalker', 'Planeswalkers'],
  ['instant', 'Éphémères'],
  ['sorcery', 'Rituels'],
  ['artifact', 'Artefacts'],
  ['enchantment', 'Enchantements'],
  ['battle', 'Batailles'],
  ['other', 'Autres'],
  ['land', 'Terrains'],
];

function curveChart(curve) {
  const buckets = [1, 2, 3, 4, 5, 6, 7];
  const max = Math.max(4, ...buckets.map((b) => curve[b] || 0));
  const W = 320, H = 130, top = 16, bottom = 20, bw = 30, gap = (W - bw * 7) / 6;
  const scale = (v) => ((H - top - bottom) * v) / max;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Courbe de mana des sorts : ' + buckets.map((b) => `${b === 7 ? '7+' : b} : ${curve[b] || 0}`).join(', '));
  const add = (tag, attrs, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    svg.append(el);
  };
  add('line', { class: 'grid', x1: 0, x2: W, y1: H - bottom + 0.5, y2: H - bottom + 0.5 });
  buckets.forEach((b, i) => {
    const v = curve[b] || 0;
    const x = i * (bw + gap);
    const hgt = scale(v);
    add('rect', { class: 'bar', x, y: H - bottom - hgt, width: bw, height: Math.max(hgt, 0), rx: 3 });
    add('text', { class: 'val', x: x + bw / 2, y: H - bottom - hgt - 4, 'text-anchor': 'middle' }, v);
    add('text', { class: 'axis', x: x + bw / 2, y: H - 4, 'text-anchor': 'middle' }, b === 7 ? '7+' : b);
  });
  return svg;
}

function tileFor(entry, { onOpen, meta }) {
  const card = entry.card;
  return h('div', { class: 'tile' },
    h('button', { type: 'button', class: 'tile-btn', onclick: onOpen, 'aria-label': `${card.name}${entry.qty > 1 ? ` ×${entry.qty}` : ''}` },
      cardImage(card),
      entry.qty > 1 ? h('span', { class: 'qty-badge', text: `×${entry.qty}` }) : null),
    meta);
}

function deckMeta(c) {
  const role = c.roles && c.roles[0] ? ROLE_LABELS[c.roles[0]] : c.basic ? 'Terrain de base' : c.tribal ? 'Tribal' : '';
  return h('div', { class: 'tile-meta' },
    h('span', { class: 'pct', text: c.edh ? fmtPct(c.edh.pct) : '' , title: c.edh ? 'Présence dans les decks EDHREC de ce commandant' : null }),
    h('span', { class: 'tag', text: role }));
}

function renderDeck() {
  const panel = $('panel-deck');
  const cmd = state.commanders.find((c) => c.key === state.commanderKey);

  if (!state.deck) {
    const preview = cmd ? h('div', { class: 'preview' }, h('img', { src: cmd.card.img || '', alt: cmd.card.name })) : null;
    panel.replaceChildren(
      h('div', { class: 'empty-state' },
        preview,
        h('div', {},
          h('h3', { text: cmd ? `${cmd.card.name} attend son deck` : 'Trois étapes pour un deck prêt à jouer' }),
          h('p', { text: 'Le générateur prend exactement 100 cartes dans ta collection : ton commandant, environ 36 terrains et 63 sorts.' }),
          h('ol', {},
            h('li', { text: 'Il garde les cartes aux couleurs du commandant et légales en Commander.' }),
            h('li', { text: 'Il remplit les quotas : 10 accélérations, 10 pioches, 8 gestions, 3 wraths, 3 protections.' }),
            h('li', { text: 'Il complète avec les cartes les plus jouées avec ce commandant sur EDHREC, en gardant une courbe de mana jouable.' })),
          cmd ? h('p', { style: 'margin-top:12px' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: generate, text: 'Générer le deck' })) : null)));
    return;
  }

  const deck = state.deck;
  const s = deck.stats;
  const edh = state.edhrec && !state.edhrec.failed ? state.edhrec : null;

  const roles = h('div', { class: 'roles' },
    Object.keys(s.targets).map((r) => {
      const have = s.roleCount[r] || 0;
      const need = s.targets[r];
      return h('div', { class: `role-row${have < need ? ' short' : ''}` },
        h('span', { text: ROLE_LABELS[r] }),
        h('div', { class: 'role-bar' }, h('span', { style: `width:${Math.min(100, (have / need) * 100)}%` })),
        h('b', { text: `${have}/${need}` }));
    }));

  const openCommander = () => openCard(deck.commander, { edh: null, roles: detectRoles(deck.commander) });

  const head = h('div', { class: 'deck-head' },
    h('div', { class: 'commander-art' },
      h('span', { class: 'label', text: 'Commandant' }),
      h('button', { type: 'button', onclick: openCommander, 'aria-label': `Voir ${deck.commander.name}` }, h('img', { src: deck.commander.img || '', alt: deck.commander.name }))),
    h('div', { class: 'deck-info' },
      h('div', { class: 'deck-title' },
        h('div', {},
          h('h3', { text: deck.commander.name }),
          h('span', { class: 'sub' }, edh && edh.numDecks ? `Comparé à ${edh.numDecks.toLocaleString('fr-FR')} decks sur ` : 'Statistiques : ',
            h('a', { href: edhrecPageUrl(deck.commander.name), target: '_blank', rel: 'noopener', text: 'EDHREC' }))),
        pipIcons(deck.commander.ci)),
      h('div', { class: 'figures' },
        h('div', { class: `figure${s.total < 100 ? ' bad' : ''}` }, h('b', { text: s.total }), h('span', { text: 'cartes' })),
        h('div', { class: 'figure' }, h('b', { text: s.landCount }), h('span', { text: 'terrains' })),
        h('div', { class: 'figure' }, h('b', { text: fmtNum(s.avgCmc) }), h('span', { text: 'coût moyen des sorts' })),
        h('div', { class: 'figure' }, h('b', { text: s.fromEdhrec }), h('span', { text: 'cartes recommandées par EDHREC' }))),
      deck.warnings.length ? h('ul', { class: 'warnings' }, deck.warnings.map((w) => h('li', { text: w }))) : null,
      h('div', { class: 'panels' },
        h('div', { class: 'panel' }, h('h4', { text: 'Rôles' }), roles),
        h('div', { class: 'panel curve' }, h('h4', { text: 'Courbe de mana (sorts)' }), curveChart(s.curve))),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: generate, text: 'Générer un autre deck' }),
        h('button', { type: 'button', class: 'btn', onclick: copyDeck, id: 'copy-deck', text: 'Copier la liste' }),
        h('button', { type: 'button', class: 'btn', onclick: downloadDeck, text: 'Télécharger (.txt)' }))));

  const byGroup = new Map(GROUPS.map(([g]) => [g, []]));
  for (const c of deck.cards) byGroup.get(primaryType(c.card)).push(c);

  const groups = h('div', { class: 'groups' },
    GROUPS.filter(([g]) => byGroup.get(g).length).map(([g, label]) => {
      const list = byGroup.get(g).sort((a, b) => {
        if (g === 'land') return (a.basic ? 1 : 0) - (b.basic ? 1 : 0) || a.card.name.localeCompare(b.card.name);
        return a.card.cmc - b.card.cmc || a.card.name.localeCompare(b.card.name);
      });
      const count = list.reduce((a, c) => a + c.qty, 0);
      return h('section', { class: 'group' },
        h('h3', {}, label, h('span', { class: 'count', text: count })),
        h('div', { class: 'card-grid' }, list.map((c) => tileFor(c, { onOpen: () => openCard(c.card, c), meta: deckMeta(c) }))));
    }));

  panel.replaceChildren(head, groups);
}

async function copyDeck() {
  const text = deckToText(state.deck, state.entriesByKey);
  const btn = $('copy-deck');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Liste copiée';
  } catch {
    btn.textContent = 'Copie impossible, utilise le téléchargement';
  }
  setTimeout(() => (btn.textContent = 'Copier la liste'), 2500);
}

function downloadDeck() {
  const text = deckToText(state.deck, state.entriesByKey);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${state.deck.commander.name.split(',')[0].replace(/[^\w\s-]/g, '')} - deck.txt` });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

/* ---------- Suggestions EDHREC ---------- */

async function renderSuggestions() {
  const panel = $('panel-suggest');
  const cmd = state.commanders.find((c) => c.key === state.commanderKey);
  if (!cmd) {
    panel.replaceChildren(h('p', { class: 'notice', text: 'Choisis un commandant pour voir les cartes que les joueurs EDHREC lui associent le plus.' }));
    return;
  }
  if (!state.edhrec || state.edhrec.key !== cmd.key) {
    panel.replaceChildren(h('p', { class: 'notice', text: 'Génère un deck pour charger les statistiques EDHREC de ce commandant.' }));
    return;
  }
  if (state.edhrec.failed) {
    panel.replaceChildren(h('p', { class: 'notice' }, `${state.edhrecError} `, h('a', { href: edhrecPageUrl(cmd.card.name), target: '_blank', rel: 'noopener', text: 'Ouvrir la page EDHREC' })));
    return;
  }

  const sug = state.suggest;
  const all = [...state.edhrec.cards.values()]
    .filter((c) => !state.owned.has(c.key) && normalizeName(c.name) !== normalizeName(cmd.card.name))
    .sort((a, b) => b.pct - a.pct);
  const tags = [...new Set(all.flatMap((c) => [...c.tags]))].filter((t) => EDHREC_TAG_LABELS[t]);
  const order = Object.keys(EDHREC_TAG_LABELS);
  tags.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const filtered = sug.filter === 'all' ? all : all.filter((c) => c.tags.has(sug.filter));
  const visible = filtered.slice(0, sug.shown);

  // Données Scryfall (image, prix) des cartes affichées.
  const missing = visible.filter((c) => !sug.cards.has(c.key));
  const grid = h('div', { class: 'card-grid' });

  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Catégories EDHREC' },
    h('button', { type: 'button', class: 'filter', 'aria-pressed': String(sug.filter === 'all'), onclick: () => setFilter('all'), text: 'Toutes' }),
    tags.map((t) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(sug.filter === t), onclick: () => setFilter(t), text: EDHREC_TAG_LABELS[t] })));

  panel.replaceChildren(
    h('div', { class: 'suggest-head' },
      h('h3', { text: `Cartes à ajouter à ta collection pour ${cmd.card.name}` }),
      h('p', { text: `Les cartes que tu ne possèdes pas, triées par présence dans les ${state.edhrec.numDecks ? state.edhrec.numDecks.toLocaleString('fr-FR') + ' ' : ''}decks EDHREC de ce commandant. Prix indicatif Cardmarket fourni par Scryfall.` }),
      filters),
    grid,
    filtered.length > sug.shown ? h('div', { class: 'more' }, h('button', { type: 'button', class: 'btn', onclick: () => { sug.shown += 48; renderSuggestions(); }, text: `Voir plus (${filtered.length - sug.shown} restantes)` })) : null
  );

  const fill = () => {
    grid.replaceChildren(
      ...visible.map((c) => {
        const card = sug.cards.get(c.key) || { name: c.name, img: null, ci: [], frontType: '', typeLine: '', text: '' };
        const meta = h('div', { class: 'tile-meta-wrap' },
          h('div', { class: 'pct-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.round(c.pct * 100)}%` })),
          h('div', { class: 'tile-meta' },
            h('span', { class: 'pct', text: fmtPct(c.pct) }),
            h('span', { class: 'tag', text: c.synergy > 0.05 ? `synergie +${Math.round(c.synergy * 100)} %` : '' })),
          h('div', { class: 'tile-price' },
            h('span', { text: card.priceEur ? `${fmtNum(Number(card.priceEur))} €` : '' }),
            h('a', { href: cardmarketUrl(c.name), target: '_blank', rel: 'noopener', text: 'Cardmarket' })));
        return tileFor({ card, qty: 1 }, { onOpen: () => openCard(card, { edh: c, roles: card.text ? detectRoles(card) : [] }), meta });
      }),
      visible.length ? null : h('p', { class: 'notice', text: 'Tu possèdes déjà toutes les cartes de cette catégorie.' })
    );
  };
  fill();

  if (missing.length) {
    try {
      const { cards } = await fetchCards(missing.map((c) => ({ key: c.key, name: c.name })));
      for (const [k, v] of cards) sug.cards.set(k, v);
      if (panel.contains(grid)) fill();
    } catch {}
  }
}

function setFilter(t) {
  state.suggest.filter = t;
  state.suggest.shown = 48;
  renderSuggestions();
}

/* ---------- Détail d'une carte ---------- */

function openCard(card, info = {}) {
  const dlg = $('card-dialog');
  const imgs = $('dlg-images');
  const front = h('img', { src: card.imgLarge || card.img || '', alt: card.name });
  imgs.replaceChildren(front);
  if (card.imgBack) {
    let showingBack = false;
    imgs.append(h('button', {
      type: 'button',
      class: 'btn flip',
      text: 'Retourner la carte',
      onclick: () => {
        showingBack = !showingBack;
        front.src = showingBack ? card.imgBack : card.imgLarge || card.img;
      },
    }));
  }
  $('dlg-title').textContent = card.name;
  $('dlg-type').textContent = [card.typeLine, card.manaCost].filter(Boolean).join(' · ');
  $('dlg-text').textContent = card.text || '';

  const facts = $('dlg-facts');
  facts.replaceChildren();
  const fact = (k, v) => facts.append(h('dt', { text: k }), h('dd', { text: v }));
  if (info.edh) {
    fact('Présence EDHREC', fmtPct(info.edh.pct));
    if (info.edh.synergy) fact('Synergie', `${info.edh.synergy > 0 ? '+' : ''}${Math.round(info.edh.synergy * 100)} %`);
  }
  if (info.roles && info.roles.length) fact('Rôle', info.roles.map((r) => ROLE_LABELS[r]).join(', '));
  if (info.qty > 1) fact('Exemplaires', `${info.qty}`);
  const owned = state.entriesByKey.get(normalizeName(card.name));
  if (owned) fact('Dans ta collection', `${owned.qty}`);
  if (card.priceEur) fact('Prix indicatif', `${fmtNum(Number(card.priceEur))} €`);

  $('dlg-links').replaceChildren(
    card.uri ? h('a', { href: card.uri, target: '_blank', rel: 'noopener', text: 'Scryfall' }) : null,
    h('a', { href: cardmarketUrl(card.name), target: '_blank', rel: 'noopener', text: 'Cardmarket' }),
    canBeCommander(card) ? h('a', { href: edhrecPageUrl(card.name), target: '_blank', rel: 'noopener', text: 'Page EDHREC' }) : null
  );
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

/* ---------- Démarrage ---------- */

function setTab(which) {
  const deck = which === 'deck';
  $('tab-deck').setAttribute('aria-selected', String(deck));
  $('tab-suggest').setAttribute('aria-selected', String(!deck));
  $('panel-deck').hidden = !deck;
  $('panel-suggest').hidden = deck;
}

async function loadSample() {
  const res = await fetch('samples/kibo.txt');
  return res.ok ? res.text() : '';
}

async function init() {
  $('tab-deck').addEventListener('click', () => setTab('deck'));
  $('tab-suggest').addEventListener('click', () => setTab('suggest'));
  $('collection-import').addEventListener('click', () => importCollection($('collection-input').value));
  $('collection-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = await file.text();
    $('collection-input').value = text;
    e.target.value = '';
    importCollection(text);
  });
  $('commander-filter').addEventListener('input', renderCommanders);
  const setSize = (size) => {
    document.documentElement.dataset.size = size;
    document.querySelectorAll('.size-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === size)));
    store.set('size', size);
  };
  document.querySelectorAll('.size-switch button').forEach((b) => b.addEventListener('click', () => setSize(b.dataset.size)));
  setSize(store.get('size', 'm'));
  $('generate').addEventListener('click', generate);
  const range = $('randomness');
  range.value = store.get('randomness', 30);
  range.addEventListener('change', () => store.set('randomness', Number(range.value)));
  $('dlg-close').addEventListener('click', () => $('card-dialog').close());
  $('card-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });

  renderCommanders();
  renderDeck();
  renderSuggestions();

  const saved = store.get('collection');
  const text = saved || (await loadSample());
  $('collection-input').value = text || '';
  if (text) {
    await importCollection(text, { save: false });
    if (!saved) $('collection-status').prepend(h('span', { text: 'Exemple chargé (deck Kibo). Remplace-le par ta liste puis clique sur Importer.' }));
  }
}

init();
