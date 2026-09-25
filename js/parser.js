// Lecture d'une liste de cartes au format texte (Archidekt, Moxfield, Cardmarket, MTG Arena…)
// Exemples de lignes acceptées :
//   1 Sol Ring (TLE) 316
//   2x Forest
//   1 Gorilla War Cry (ALL) 73a *F*
//   1 Arcane Signet (TLE) 315 [Ramp]
//   4 Mountain (Foundations)

const SECTION_RE = /^(commander|commandant|deck|mainboard|main|sideboard|maybeboard|companion|about)\s*:?$/i;

export function normalizeName(name) {
  return name
    .split(' // ')[0]
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function parseCollection(text) {
  const entries = new Map();
  const ignored = [];
  let section = null;

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) {
      // Une ligne vide termine la section « commandant ».
      if (section && /command/.test(section)) section = null;
      continue;
    }

    if (line.startsWith('//') || line.startsWith('#')) {
      section = line.replace(/^[/#\s]+/, '').toLowerCase();
      continue;
    }
    if (SECTION_RE.test(line)) {
      section = line.replace(/:$/, '').toLowerCase();
      continue;
    }

    let qty = 1;
    const qm = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (qm) {
      qty = parseInt(qm[1], 10);
      line = qm[2];
    }

    // Marqueurs de fin de ligne : [Catégorie], ^tag^, *F*, *E*, (foil)
    line = line
      .replace(/\s+\[[^\]]*\]/g, '')
      .replace(/\s+\^[^^]*\^/g, '')
      .replace(/\s+\*[A-Z]+\*/g, '')
      .replace(/\s+\((foil|etched)\)\s*$/i, '')
      .trim();

    let set = null;
    let cn = null;
    const sm = line.match(/^(.*?)\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([A-Za-z0-9★†\-]+))?\s*$/);
    if (sm) {
      line = sm[1];
      set = sm[2].toLowerCase();
      cn = sm[3] || null;
    } else {
      // Format Cardmarket : "Nom (Nom de l'extension)"
      const pm = line.match(/^(.*?)\s+\(([^)]+)\)\s*$/);
      if (pm) line = pm[1];
    }

    const name = line.trim();
    if (!name || qty <= 0) {
      ignored.push(raw);
      continue;
    }

    const key = normalizeName(name);
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, name, qty: 0, printings: [], commanderHint: false };
      entries.set(key, entry);
    }
    entry.qty += qty;
    if (set && !entry.printings.some((p) => p.set === set && p.cn === cn)) {
      entry.printings.push({ set, cn });
    }
    if (section && /command/.test(section)) entry.commanderHint = true;
  }

  return { entries: [...entries.values()], ignored };
}
