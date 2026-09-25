// Tests sans dépendance : node test/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCollection, normalizeName } from '../js/parser.js';
import { detectRoles, canBeCommander } from '../js/roles.js';
import { buildDeck, deckToText } from '../js/builder.js';
import { edhrecSlug, parseEdhrec } from '../js/edhrec.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('ok -', name);
};

const card = (o) => ({
  id: o.name,
  name: o.name,
  frontName: o.name,
  typeLine: o.type,
  frontType: o.type,
  text: o.text || '',
  manaCost: o.cost || '',
  cmc: o.cmc ?? 2,
  ci: o.ci || [],
  produced: o.produced || [],
  legal: o.legal || 'legal',
  img: null,
});

test('lit le format Archidekt / Moxfield', () => {
  const text = readFileSync(new URL('../samples/kibo.txt', import.meta.url), 'utf8');
  const { entries, ignored } = parseCollection(text);
  assert.equal(ignored.length, 0);
  const kibo = entries.find((e) => e.name === 'Kibo, Uktabi Prince');
  assert.ok(kibo.commanderHint);
  assert.equal(entries.filter((e) => e.commanderHint).length, 1);
  assert.deepEqual(kibo.printings[0], { set: 'j22', cn: '40' });
  const forest = entries.find((e) => e.name === 'Forest');
  assert.equal(forest.qty, 19);
  assert.equal(entries.find((e) => e.name === 'Mountain').qty, 12);
  assert.deepEqual(entries.find((e) => e.name === 'Gorilla War Cry').printings[0], { set: 'all', cn: '73a' });
  const total = entries.reduce((a, e) => a + e.qty, 0);
  assert.equal(total, 100);
});

test('lit les variantes de lignes', () => {
  const { entries } = parseCollection('2x Sol Ring\n1 Lightning Bolt (M10) 146 *F* [Removal]\n1 Fire // Ice\n3 Island (Foundations)\nDeck\n1 Arcane Signet');
  assert.equal(entries.find((e) => e.name === 'Sol Ring').qty, 2);
  assert.deepEqual(entries.find((e) => e.name === 'Lightning Bolt').printings[0], { set: 'm10', cn: '146' });
  assert.ok(entries.find((e) => e.name === 'Fire // Ice'));
  assert.equal(entries.find((e) => e.name === 'Island').qty, 3);
  assert.equal(normalizeName('Lim-Dûl the Necromancer'), 'lim-dul the necromancer');
});

test('slug EDHREC', () => {
  assert.equal(edhrecSlug('Kibo, Uktabi Prince'), 'kibo-uktabi-prince');
  assert.equal(edhrecSlug("Atraxa, Praetors' Voice"), 'atraxa-praetors-voice');
  assert.equal(edhrecSlug('Esika, God of the Tree // The Prismatic Bridge'), 'esika-god-of-the-tree');
});

test('lecture du JSON EDHREC', () => {
  const json = {
    num_decks_avg: 1200,
    container: {
      json_dict: {
        cardlists: [
          { tag: 'highsynergycards', cardviews: [{ name: 'Monkey Cage', num_decks: 600, potential_decks: 1200, synergy: 0.45 }] },
          { tag: 'manaartifacts', cardviews: [{ name: 'Sol Ring', inclusion: 1100, potential_decks: 1200, synergy: 0.02 }] },
          { tag: 'topcards', cardviews: [{ name: 'Monkey Cage', num_decks: 600, potential_decks: 1200, synergy: 0.45 }] },
        ],
      },
    },
  };
  const { cards, numDecks } = parseEdhrec(json);
  assert.equal(numDecks, 1200);
  assert.equal(cards.get('monkey cage').pct, 0.5);
  assert.ok(cards.get('monkey cage').tags.has('topcards'));
  assert.ok(Math.abs(cards.get('sol ring').pct - 0.9167) < 0.001);
});

test('détection des rôles', () => {
  assert.deepEqual(detectRoles(card({ name: 'Sol Ring', type: 'Artifact', text: '{T}: Add {C}{C}.' })), ['ramp']);
  assert.ok(detectRoles(card({ name: 'Cultivate', type: 'Sorcery', text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.' })).includes('ramp'));
  assert.ok(detectRoles(card({ name: 'Beast Within', type: 'Instant', text: 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.' })).includes('removal'));
  assert.ok(detectRoles(card({ name: 'Vandalblast', type: 'Sorcery', text: 'Destroy target artifact you don\'t control.\nOverload {4}{R}' })).includes('removal'));
  assert.ok(detectRoles(card({ name: 'Slagstorm', type: 'Sorcery', text: 'Choose one —\n• Slagstorm deals 3 damage to each creature.\n• Slagstorm deals 3 damage to each player.' })).includes('wipe'));
  assert.ok(detectRoles(card({ name: 'Swiftfoot Boots', type: 'Artifact — Equipment', text: 'Equipped creature has hexproof and haste.\nEquip {1}' })).includes('protection'));
  assert.ok(detectRoles(card({ name: 'Harmonize', type: 'Sorcery', text: 'Draw three cards.' })).includes('draw'));
  assert.deepEqual(detectRoles(card({ name: 'Cloudshift', type: 'Instant', text: 'Exile target creature you control, then return that card to the battlefield under your control.' })), []);
  assert.ok(canBeCommander(card({ name: 'Kibo', type: 'Legendary Creature — Monkey Noble' })));
  assert.ok(!canBeCommander(card({ name: 'Ape', type: 'Creature — Ape' })));
});

function makePool() {
  const pool = [];
  const push = (c, qty = 1) => pool.push({ key: normalizeName(c.name), card: c, qty });
  for (let i = 0; i < 12; i++) push(card({ name: `Rock ${i}`, type: 'Artifact', text: '{T}: Add {C}.', cmc: 2, cost: '{2}' }));
  for (let i = 0; i < 12; i++) push(card({ name: `Draw ${i}`, type: 'Sorcery', text: 'Draw two cards.', cmc: 3, cost: '{2}{G}', ci: ['G'] }));
  for (let i = 0; i < 10; i++) push(card({ name: `Kill ${i}`, type: 'Instant', text: 'Destroy target creature.', cmc: 2, cost: '{1}{R}', ci: ['R'] }));
  for (let i = 0; i < 4; i++) push(card({ name: `Wrath ${i}`, type: 'Sorcery', text: 'Destroy all creatures.', cmc: 4, cost: '{2}{R}{R}', ci: ['R'] }));
  for (let i = 0; i < 60; i++) push(card({ name: `Ape ${i}`, type: 'Creature — Ape', cmc: (i % 6) + 1, cost: '{G}', ci: ['G'] }));
  for (let i = 0; i < 10; i++) push(card({ name: `Blue ${i}`, type: 'Creature — Merfolk', cmc: 2, cost: '{U}', ci: ['U'] }));
  push(card({ name: 'Banned Thing', type: 'Artifact', cmc: 1, legal: 'banned' }));
  push(card({ name: 'Rugged Highlands', type: 'Land', produced: ['R', 'G'], ci: ['R', 'G'] }));
  push(card({ name: 'Forest', type: 'Basic Land — Forest', produced: ['G'], ci: ['G'] }), 30);
  push(card({ name: 'Mountain', type: 'Basic Land — Mountain', produced: ['R'], ci: ['R'] }), 30);
  return pool;
}

const commander = card({ name: 'Kibo, Uktabi Prince', type: 'Legendary Creature — Monkey Noble', ci: ['G', 'R'], cost: '{2}{R}{G}', cmc: 4, text: 'Put a +1/+1 counter on each Ape and Monkey you control.' });

test('génère exactement 100 cartes dans les couleurs du commandant', () => {
  const pool = makePool();
  let seed = 42;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const deck = buildDeck({ commander, commanderKey: 'kibo, uktabi prince', pool, edhrec: null, rng });
  const total = 1 + deck.cards.reduce((a, c) => a + c.qty, 0);
  assert.equal(total, 100);
  assert.equal(deck.stats.total, 100);
  assert.ok(deck.cards.every((c) => c.card.ci.every((x) => ['G', 'R'].includes(x))));
  assert.ok(!deck.cards.some((c) => c.card.name === 'Banned Thing'));
  const names = deck.cards.filter((c) => !c.basic).map((c) => c.card.name);
  assert.equal(new Set(names).size, names.length, 'singleton');
  assert.ok(deck.stats.landCount >= 33 && deck.stats.landCount <= 38);
  assert.equal(deck.stats.roleCount.ramp >= 10, true);
  assert.equal(deck.stats.roleCount.removal >= 8, true);
  const basicQty = (n) => deck.cards.filter((c) => c.card.name === n).reduce((a, c) => a + c.qty, 0);
  assert.ok(basicQty('Forest') > basicQty('Mountain'), 'plus de Forêts car plus de symboles verts');
  const txt = deckToText(deck, new Map());
  assert.ok(txt.startsWith('// COMMANDER\n1 Kibo, Uktabi Prince\n'));
});

test('préfère les cartes populaires sur EDHREC', () => {
  const pool = makePool();
  const edh = new Map([['ape 59', { pct: 0.9, synergy: 0.5, tags: new Set(['highsynergycards']) }]]);
  for (let i = 0; i < 20; i++) {
    const deck = buildDeck({ commander, pool, edhrec: { cards: edh }, randomness: 0.3 });
    assert.ok(deck.cards.some((c) => c.card.name === 'Ape 59'));
  }
});

test('complète avec des sorts quand les terrains manquent', () => {
  const pool = makePool().filter((e) => !/Forest|Mountain/.test(e.card.name));
  const deck = buildDeck({ commander, pool, edhrec: null });
  assert.equal(deck.stats.total, 100);
  assert.ok(deck.warnings.some((w) => w.includes('terrain')));
});

test('utilise les terrains en trop quand les sorts manquent', () => {
  const pool = makePool().filter((e) => !/^(Ape|Blue)/.test(e.card.name));
  const deck = buildDeck({ commander, pool, edhrec: null });
  assert.equal(deck.stats.total, 100);
  assert.ok(deck.stats.landCount > 38);
});

test('signale une collection trop petite', () => {
  const pool = makePool().slice(0, 20);
  const deck = buildDeck({ commander, pool, edhrec: null });
  assert.ok(deck.stats.total < 100);
  assert.ok(deck.warnings.some((w) => w.includes('au lieu de 100')));
});

console.log(`\n${passed} tests OK`);
