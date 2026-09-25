// Classement des cartes par rôle, à partir du texte de règles (oracle).

export const ROLE_LABELS = {
  ramp: 'Accélération',
  draw: 'Pioche',
  removal: 'Gestion',
  wipe: 'Wrath',
  protection: 'Protection',
};

const BASIC_TYPES = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
export { BASIC_TYPES };

export function isLand(card) {
  return /\bLand\b/.test(card.frontType) && !/\bCreature\b/.test(card.frontType);
}

export function isBasicLand(card) {
  return /\bBasic\b/.test(card.frontType) && /\bLand\b/.test(card.frontType);
}

export function canBeCommander(card) {
  const t = card.frontType || '';
  if (/\bLegendary\b/.test(t) && /\bCreature\b/.test(t)) return true;
  return /can be your commander/i.test(card.text || '');
}

export function primaryType(card) {
  const t = card.frontType || '';
  if (/\bCreature\b/.test(t)) return 'creature';
  if (/\bLand\b/.test(t)) return 'land';
  if (/\bPlaneswalker\b/.test(t)) return 'planeswalker';
  if (/\bBattle\b/.test(t)) return 'battle';
  if (/\bInstant\b/.test(t)) return 'instant';
  if (/\bSorcery\b/.test(t)) return 'sorcery';
  if (/\bArtifact\b/.test(t)) return 'artifact';
  if (/\bEnchantment\b/.test(t)) return 'enchantment';
  return 'other';
}

export function detectRoles(card) {
  const roles = new Set();
  if (isLand(card)) return [];
  const t = (card.text || '').toLowerCase().replace(/\([^)]*\)/g, '');
  // Les effets qui ne ciblent que nos propres permanents ne sont pas de la gestion.
  const hostile = t.replace(/target [a-z\s-]*? you control/g, '').replace(/target [a-z\s-]*? card from (a|your) graveyard/g, '');

  if (/\badd \{|\badd (one|two|three|x) mana|\badd mana|mana of any (one )?(color|type)/.test(t)) roles.add('ramp');
  if (/search your library for [^.]*\b(land|forest|plains|island|swamp|mountain)s?\b( card)?/.test(t) && /onto the battlefield|put (it|them|that card) into your hand/.test(t)) roles.add('ramp');
  if (/play an additional land|put a land card from your hand onto the battlefield|create (a|one|two) treasure/.test(t)) roles.add('ramp');

  if (/\bdraws? (a|an|one|two|three|four|five|seven|x|that many|cards equal)\b[^.]*\bcards?\b|\bdraw a card\b|\bdraw cards\b/.test(t)) roles.add('draw');
  if (/exile the top [^.]*\. [^.]*you may (play|cast)/.test(t)) roles.add('draw');

  if (
    /(destroy|exile) (up to (one|two|three) )?(another )?target (?!card)/.test(hostile) ||
    /deals? (\d+|x|damage equal[^.]*) damage to (any target|target (creature|player|planeswalker|permanent|opponent))/.test(hostile) ||
    /counter target (spell|activated|noncreature|creature)/.test(hostile) ||
    /return (up to (one|two) )?target (nonland )?(creature|permanent|artifact|enchantment)s?[^.]* to (its|their) owners?'? hands?/.test(hostile) ||
    /\bfights? (target|another target|up to one target)/.test(hostile) ||
    /target (player|opponent) sacrifices/.test(hostile) ||
    /target creature [^.]*gets -\d+\/-\d+/.test(hostile)
  ) roles.add('removal');

  if (
    /(destroy|exile) (all|each) (other )?(creatures|nonland permanents|permanents|artifacts|enchantments|creature|nonland|noncreature|artifact)/.test(t) ||
    /deals? (\d+|x) damage to each (creature|other creature|creature and each planeswalker)/.test(t) ||
    /(all|each) (other )?creatures? gets? -\d+\/-\d+/.test(t) ||
    /each player sacrifices/.test(t)
  ) roles.add('wipe');

  if (
    /(gains?|has|have|gets?) [^.]*\b(hexproof|indestructible|shroud|protection from)/.test(t) &&
    /(target|equipped|enchanted|creatures you control|permanents you control|your commander)/.test(t)
  ) roles.add('protection');

  return [...roles];
}

// Types de créatures cités dans le texte du commandant (ex. « Ape and Monkey »).
export function commanderTribes(commander) {
  const text = commander.text || '';
  const words = new Set();
  for (const m of text.matchAll(/\b([A-Z][a-z]+)s?\b/g)) words.add(m[1]);
  const own = (commander.frontType.split('—')[1] || '').trim().split(/\s+/).filter(Boolean);
  own.forEach((w) => words.add(w));
  const ignore = new Set(['When', 'Whenever', 'At', 'Each', 'Put', 'Target', 'Create', 'You', 'If', 'Then', 'This', 'That', 'Until', 'Choose', 'Draw', 'Return', 'Destroy', 'Exile', 'Search', 'Counter', 'Add', 'Tap', 'Untap', 'Sacrifice', 'Flying', 'Trample', 'Haste', 'Reach', 'Legendary', 'Human', 'Banana', 'Food', 'Treasure', 'Clue']);
  return [...words].filter((w) => !ignore.has(w) && w.length > 2);
}

export function sharesTribe(card, tribes) {
  if (!tribes.length) return false;
  const sub = (card.typeLine.split('—')[1] || '');
  const text = card.text || '';
  return tribes.some((t) => new RegExp(`\\b${t}s?\\b`).test(sub) || new RegExp(`\\b${t}s?\\b`).test(text));
}

export function colorPips(manaCost) {
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const m of (manaCost || '').matchAll(/\{([^}]+)\}/g)) {
    for (const c of m[1].split('/')) if (c in pips) pips[c] += 1;
  }
  return pips;
}
