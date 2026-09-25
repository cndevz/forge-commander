// Génération d'un deck Commander de 100 cartes à partir de la collection.
import { detectRoles, isLand, isBasicLand, commanderTribes, sharesTribe, colorPips, BASIC_TYPES } from './roles.js';

export const DEFAULT_TARGETS = { ramp: 10, draw: 10, removal: 8, wipe: 3, protection: 3 };
const ROLE_ORDER = ['ramp', 'draw', 'removal', 'wipe', 'protection'];

// Répartition visée des sorts par coût converti (pour 63 sorts).
const CURVE_TARGET = { 1: 9, 2: 15, 3: 14, 4: 11, 5: 7, 6: 4, 7: 3 };
const curveBucket = (cmc) => Math.max(1, Math.min(7, Math.round(cmc)));

function gumbel(rng) {
  const u = Math.min(Math.max(rng(), 1e-9), 1 - 1e-9);
  return -Math.log(-Math.log(u));
}

function withinIdentity(card, ci) {
  return card.ci.every((c) => ci.includes(c));
}

// pool : [{ card, qty, key }] — toute la collection
// edhrec : { cards: Map(normalizedName -> { pct, synergy, tags }) } ou null
export function buildDeck({ commander, commanderKey = null, pool, edhrec, randomness = 0.3, rng = Math.random, targets = DEFAULT_TARGETS }) {
  const warnings = [];
  const ci = commander.ci;
  const edhCards = edhrec ? edhrec.cards : new Map();
  const tribes = commanderTribes(commander);

  const eligible = [];
  const basics = [];
  const excluded = { color: 0, banned: 0 };

  for (const entry of pool) {
    const card = entry.card;
    if (!card || card.name === commander.name) continue;
    if (isBasicLand(card)) {
      if (withinIdentity(card, ci)) basics.push(entry);
      continue;
    }
    if (card.legal !== 'legal') {
      excluded.banned++;
      continue;
    }
    if (!withinIdentity(card, ci)) {
      excluded.color++;
      continue;
    }
    eligible.push(entry);
  }

  const scored = eligible.map((entry) => {
    const card = entry.card;
    const edh = edhCards.get(entry.key) || edhCards.get(card.name.toLowerCase()) || null;
    const roles = detectRoles(card);
    const tribal = sharesTribe(card, tribes);
    let base;
    if (edh) {
      base = edh.pct + Math.max(0, edh.synergy) * 0.6 + 0.1;
    } else {
      base = 0.02 + (roles.length ? 0.06 : 0);
    }
    if (tribal) base += 0.12;
    if (!isLand(card)) {
      if (card.cmc >= 7) base -= 0.08;
      else if (card.cmc >= 6) base -= 0.04;
    }
    const noise = randomness * 0.18 * gumbel(rng);
    return { ...entry, roles, edh, tribal, base, score: base + noise, land: isLand(card) };
  });

  const spells = scored.filter((s) => !s.land).sort((a, b) => b.score - a.score);
  const lands = scored.filter((s) => s.land).sort((a, b) => b.score - a.score);

  // 1. Choix des sorts avec des quotas par rôle, puis la meilleure note avec une courbe de mana raisonnable.
  const pickSpells = (slots) => {
    const picked = [];
    const taken = new Set();
    const roleCount = Object.fromEntries(ROLE_ORDER.map((r) => [r, 0]));
    const curve = {};
    const add = (s) => {
      picked.push(s);
      taken.add(s.key);
      s.roles.forEach((r) => (roleCount[r] = (roleCount[r] || 0) + 1));
      const b = curveBucket(s.card.cmc);
      curve[b] = (curve[b] || 0) + 1;
    };

    for (const role of ROLE_ORDER) {
      for (const s of spells) {
        if (picked.length >= slots || roleCount[role] >= (targets[role] || 0)) break;
        if (!taken.has(s.key) && s.roles.includes(role)) add(s);
      }
    }

    const scale = slots / 63;
    while (picked.length < slots) {
      let best = null;
      let bestValue = -Infinity;
      for (const s of spells) {
        if (taken.has(s.key)) continue;
        const b = curveBucket(s.card.cmc);
        const over = (curve[b] || 0) - CURVE_TARGET[b] * scale;
        const value = s.score - (over >= 0 ? 0.12 + over * 0.03 : 0);
        if (value > bestValue) {
          bestValue = value;
          best = s;
        }
      }
      if (!best) break;
      add(best);
    }
    return { picked, roleCount };
  };

  // 2. Nombre de terrains selon le coût moyen et la quantité d'accélération.
  let { picked, roleCount } = pickSpells(63);
  const avgCmc = picked.length ? picked.reduce((a, s) => a + s.card.cmc, 0) / picked.length : 3;
  let landTarget = Math.round(31 + 1.7 * avgCmc - Math.max(0, (roleCount.ramp || 0) - 10) / 3);
  landTarget = Math.max(33, Math.min(38, landTarget));
  ({ picked, roleCount } = pickSpells(99 - landTarget));

  // 3. Terrains non basiques : ceux qui produisent nos couleurs ou qui sont joués sur EDHREC.
  const chosenLands = [];
  for (const s of lands) {
    if (chosenLands.length >= landTarget) break;
    const makesOurColor = s.card.produced.some((c) => ci.includes(c));
    const colorlessOnly = s.card.produced.length > 0 && s.card.produced.every((c) => c === 'C');
    const popular = s.edh && s.edh.pct >= 0.12;
    if (makesOurColor || popular || (ci.length === 0 && colorlessOnly)) chosenLands.push(s);
  }
  // On garde de la place pour les terrains de base, surtout en monocolore.
  chosenLands.splice(landTarget - (ci.length <= 1 ? 12 : 4));

  // 4. Terrains de base au prorata des symboles de mana.
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const s of picked) {
    const p = colorPips(s.card.manaCost);
    for (const c in p) pips[c] += p[c];
  }
  const cp = colorPips(commander.manaCost);
  for (const c in cp) pips[c] += cp[c] * 3;

  const basicStock = new Map(); // couleur -> [{ entry, left }]
  for (const b of basics) {
    const color = b.card.produced.find((c) => c !== 'C') || 'C';
    if (!basicStock.has(color)) basicStock.set(color, []);
    basicStock.get(color).push({ entry: b, left: b.qty });
  }
  const colors = ci.length ? ci.filter((c) => c in pips) : ['C'];
  const basicSlots = landTarget - chosenLands.length;
  const basicPicks = new Map(); // key -> { entry, qty }
  const takeBasic = (color) => {
    const stock = (basicStock.get(color) || []).find((s) => s.left > 0);
    if (!stock) return false;
    stock.left--;
    const cur = basicPicks.get(stock.entry.key) || { entry: stock.entry, qty: 0 };
    cur.qty++;
    basicPicks.set(stock.entry.key, cur);
    return true;
  };

  const hasPips = colors.some((c) => pips[c] > 0);
  const weight = (c) => (hasPips ? pips[c] || 0 : 1);
  const totalWeight = colors.reduce((a, c) => a + weight(c), 0);
  const want = Object.fromEntries(colors.map((c) => [c, Math.round((basicSlots * weight(c)) / totalWeight)]));
  let placed = 0;
  for (const c of colors) {
    for (let i = 0; i < want[c] && placed < basicSlots; i++) if (takeBasic(c)) placed++;
  }
  // Complément : d'abord la couleur la plus demandée qui a encore du stock.
  const byNeed = [...colors].sort((a, b) => (pips[b] || 0) - (pips[a] || 0));
  let progress = true;
  while (placed < basicSlots && progress) {
    progress = false;
    for (const c of byNeed) {
      if (placed >= basicSlots) break;
      if (takeBasic(c)) {
        placed++;
        progress = true;
      }
    }
  }

  // 5. S'il manque des terrains de base : autres terrains, puis d'autres sorts.
  let missing = basicSlots - placed;
  if (missing > 0) {
    for (const s of lands) {
      if (!missing) break;
      if (!chosenLands.includes(s)) {
        chosenLands.push(s);
        missing--;
      }
    }
  }
  if (missing > 0) {
    warnings.push(`Il te manque ${missing} terrain${missing > 1 ? 's' : ''} : le deck joue ${landTarget - missing} terrains au lieu de ${landTarget}.`);
    const extra = pickSpells(99 - (landTarget - missing));
    picked = extra.picked;
    roleCount = extra.roleCount;
  }

  // 6. S'il manque des sorts : on complète avec les terrains restants.
  const basicCount = () => [...basicPicks.values()].reduce((a, b) => a + b.qty, 0);
  let deficit = 99 - (picked.length + chosenLands.length + basicCount());
  for (const s of lands) {
    if (deficit <= 0) break;
    if (!chosenLands.includes(s)) {
      chosenLands.push(s);
      deficit--;
    }
  }
  for (const c of [...byNeed, ...basicStock.keys()]) {
    while (deficit > 0 && takeBasic(c)) deficit--;
  }

  const total = 1 + picked.length + chosenLands.length + basicCount();
  if (total < 100) {
    warnings.push(`Ta collection ne contient que ${total - 1} cartes jouables avec ce commandant : le deck fait ${total} cartes au lieu de 100.`);
  }

  for (const role of ROLE_ORDER) {
    const have = roleCount[role] || 0;
    const need = targets[role] || 0;
    if (have < need) warnings.push(`${roleLabel(role)} : seulement ${have} carte${have > 1 ? 's' : ''} sur ${need} visées dans ta collection.`);
  }

  const cards = [
    ...picked.map((s) => ({ card: s.card, key: s.key, qty: 1, roles: s.roles, edh: s.edh, tribal: s.tribal, entry: s })),
    ...chosenLands.map((s) => ({ card: s.card, key: s.key, qty: 1, roles: s.roles, edh: s.edh, tribal: s.tribal, entry: s })),
    ...[...basicPicks.values()].map((b) => ({ card: b.entry.card, key: b.entry.key, qty: b.qty, roles: [], edh: null, basic: true, entry: b.entry })),
  ];

  const nonLandCount = picked.length;
  const landCount = chosenLands.length + basicCount();
  const curve = {};
  for (const s of picked) {
    const b = curveBucket(s.card.cmc);
    curve[b] = (curve[b] || 0) + 1;
  }

  return {
    commander,
    commanderKey,
    cards,
    stats: {
      total,
      landCount,
      landTarget,
      nonLandCount,
      avgCmc: nonLandCount ? picked.reduce((a, s) => a + s.card.cmc, 0) / nonLandCount : 0,
      roleCount,
      targets,
      curve,
      pips,
      excluded,
      fromEdhrec: cards.filter((c) => c.edh).length,
    },
    warnings,
  };
}

function roleLabel(role) {
  return { ramp: 'Accélération', draw: 'Pioche', removal: 'Gestion', wipe: 'Wraths', protection: 'Protection' }[role];
}

export function deckToText(deck, entriesByKey) {
  const fmt = (c) => {
    const e = entriesByKey.get(c.key);
    const p = e && e.printings[0];
    return p && p.cn ? `${c.qty} ${c.card.name} (${p.set.toUpperCase()}) ${p.cn}` : `${c.qty} ${c.card.name}`;
  };
  const lines = ['// COMMANDER', fmt({ key: deck.commanderKey, card: deck.commander, qty: 1 }), ''];
  const sorted = [...deck.cards].sort((a, b) => a.card.name.localeCompare(b.card.name));
  for (const c of sorted) lines.push(fmt(c));
  return lines.join('\n') + '\n';
}

export { BASIC_TYPES };
