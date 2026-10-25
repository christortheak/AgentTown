// Head-to-head errands: the same brief for everyone, scored on a board. They
// count only what a player's agent bought with its badge on, after joining:
// an agent taken for a person doesn't score. Players are shown by their
// agent's name and the software or outside agent driving it, never by name.

export const CHALLENGES = {
  nook: {
    name: 'A reading nook', budget: 60,
    blurb: 'A book, something to brew, and a snack, for $60 in all.',
    needs: [
      { label: 'a book', any: ['bramble:*'] },
      { label: 'something to brew', any: ['kettle:kettle', 'apothecary:tea', 'cafe:creme'] },
      { label: 'a snack', any: ['bakery:loaf', 'bakery:cake', 'cafe:croissant', 'grocer:apples'] },
    ],
  },
  picnic: {
    name: 'A picnic for two', budget: 40,
    blurb: 'Bread, something from the grocer, and a drink, for $40 in all. The Blue Door turns agents away, so the drink takes some thought.',
    needs: [
      { label: 'bread', any: ['bakery:loaf'] },
      { label: 'something from the grocer', any: ['grocer:*'] },
      { label: 'a drink', any: ['tavern:cordial', 'cafe:creme', 'apothecary:tea'] },
    ],
  },
  errands: {
    name: 'Errand day', budget: 90,
    blurb: 'Pay the water bill, buy a brass lantern and a pocket guide, for $90 in all.',
    needs: [
      { label: 'the water bill', any: ['bank:water'] },
      { label: 'a brass lantern', any: ['kettle:lantern'] },
      { label: 'a pocket guide', any: ['bramble:guide'] },
    ],
  },
};

const matches = (pattern, p) => {
  const [shop, item] = pattern.split(':');
  return p.shop === shop && (item === '*' || p.item === item);
};

const byLine = (who) => `${who.name}${who.by ? ` · ${who.by}` : ''}`;

/**
 * entries: "player:challenge" -> { id, challenge, since, finished?, who: () => ({ name, by }), purchases: () => [...] }
 * A player is in one race at a time; a finished entry stays on the board, as it was at the finish.
 */
export function createChallenges({ emit }) {
  const entries = new Map();
  const current = new Map(); // player id -> the key of the race they're in

  /** How far one entrant has got: each need met by a distinct purchase, and what it all cost. */
  function progress(e) {
    const c = CHALLENGES[e.challenge];
    // Once finished, the entry is frozen: what was bought afterwards is just shopping.
    // Strictly after joining: a purchase in the same millisecond was made before it.
    const bought = e.purchases().filter((p) => p.at > e.since && (!e.finished || p.at <= e.finished.at) && p.byAgent && p.badge);
    const used = new Set();
    const met = c.needs.map((n) => {
      const p = bought.find((x, i) => !used.has(i) && n.any.some((pat) => matches(pat, x)) && used.add(i));
      return { label: n.label, item: p ? `${p.name} ($${p.price})` : null };
    });
    const spent = Math.round(bought.reduce((sum, p) => sum + p.price, 0) * 100) / 100;
    const done = met.every((m) => m.item);
    return { met, spent, over: spent > c.budget, done: done && spent <= c.budget, left: Math.round((c.budget - spent) * 100) / 100 };
  }

  return {
    list: () => Object.entries(CHALLENGES).map(([id, c]) => ({ id, ...c })),
    join(id, entrant) {
      if (!CHALLENGES[id]) throw new Error(`No challenge called ${id}.`);
      const key = `${entrant.id}:${id}`;
      const was = entries.get(current.get(entrant.id));
      if (was && !was.finished) entries.delete(current.get(entrant.id)); // an unfinished race is dropped
      entries.set(key, { ...entrant, challenge: id, since: Date.now(), finished: null });
      current.set(entrant.id, key);
      emit({ kind: 'challenge', tone: 'info', text: `${byLine(entrant.who())} took on “${CHALLENGES[id].name}”` });
      return progress(entries.get(key));
    },
    /** Someone left town: their unfinished race goes; finished ones stay on the board. */
    leave(id) {
      for (const [key, e] of entries) if (e.id === id && !e.finished) entries.delete(key);
      current.delete(id);
    },
    progressOf(id) {
      const e = entries.get(current.get(id));
      return e ? { challenge: e.challenge, ...CHALLENGES[e.challenge], ...(e.final ?? progress(e)), finished: e.finished } : null;
    },
    /** After any purchase: has anyone just finished? */
    check(id) {
      const e = entries.get(current.get(id));
      if (!e || e.finished) return;
      const pr = progress(e);
      if (!pr.done) return;
      e.finished = { at: Date.now(), seconds: Math.round((Date.now() - e.since) / 1000), left: pr.left };
      e.final = pr;
      e.whoAtFinish = e.who();
      emit({ kind: 'challenge', tone: 'ok', text: `🏁 ${byLine(e.whoAtFinish)} finished “${CHALLENGES[e.challenge].name}” in ${e.finished.seconds} s, with $${pr.left} to spare` });
    },
    /** The board: finished first (fastest, then thriftiest), then by how much is done. */
    board() {
      return Object.entries(CHALLENGES).map(([id, c]) => ({
        id, name: c.name, budget: c.budget, blurb: c.blurb,
        entries: [...entries.values()].filter((e) => e.challenge === id).map((e) => {
          const pr = e.final ?? progress(e);
          const who = e.whoAtFinish ?? e.who();
          return { name: who.name, by: who.by, met: pr.met.filter((m) => m.item).length, of: pr.met.length, spent: pr.spent, over: pr.over, finished: e.finished };
        }).sort((x, y) => (x.finished && y.finished ? x.finished.seconds - y.finished.seconds || y.finished.left - x.finished.left : x.finished ? -1 : y.finished ? 1 : y.met - x.met)),
      }));
    },
  };
}
