// The town's law, kept apart from its infrastructure. Each jurisdiction (the
// town north of the river, the Harbor to the south) can switch on any mix of
// regimes. A regime never touches registries, record keepers or badges: it
// only changes what places must ask for, by sector, with floors (ask for at
// least this) and caps (never ask for more than this). The same agents then
// meet different outcomes on the same rails.

export const JURISDICTIONS = { us: 'the town (US rules)', eu: 'the Harbor (EU rules)' };

export const SECTORS = {
  retail: 'shops', health: 'pharmacies', hospitality: 'inns and taverns', finance: 'banks, exchanges and payments',
  compute: 'compute', public: 'public events', transport: 'tolls and transport',
};

/**
 * floors: [{ sectors, actions?, over?, require, mandate? }]
 *   over     applies only to requests above this amount ($)
 *   mandate  places in these sectors must check badges, adopted or not
 * cap: the most any place may ask for
 */
export const REGIMES = {
  aml: {
    name: 'Anti-money-laundering',
    blurb: 'Payments and trades must come from accountable agents with permission, and need the principal’s name over $100.',
    floors: [
      { sectors: ['finance'], actions: ['payments.authorize', 'trading.order'], require: { accountability: 'established', authorization: true }, mandate: true },
      { sectors: ['finance'], actions: ['payments.authorize', 'trading.order'], over: 100, require: { accountability: 'disclosed' } },
    ],
  },
  consumer: {
    name: 'Consumer protection',
    blurb: 'Shops must check that an agent has permission for each purchase, and age-restricted goods need verified proof of age.',
    floors: [
      { sectors: ['retail', 'health', 'hospitality'], require: { accountability: 'established', authorization: true }, mandate: true },
      { sectors: ['health', 'hospitality'], restricted: true, require: { attributes: ['age_over_18'] } },
    ],
  },
  highrisk: {
    name: 'High-risk AI services',
    blurb: 'Compute and finance need the principal’s name and the agent’s bill of materials (which model and tools it runs).',
    floors: [{ sectors: ['compute', 'finance'], actions: ['compute.provision', 'trading.order'], require: { accountability: 'disclosed', provenance: true }, mandate: true }],
  },
  privacy: {
    name: 'Privacy first',
    blurb: 'No place may demand a principal’s name. Badges, permissions and verified facts like “over 18” only; names come out only by court order.',
    floors: [],
    cap: { accountability: 'established' },
  },
};

const LEVEL = { none: 0, established: 1, disclosed: 2 };
const amountOf = (p) => p?.amount?.value ?? 0;

/** Ask for at least `floor` as well as `req`. */
export function raise(req, floor) {
  const out = { ...req };
  if (floor.accountability && req.accountability !== 'agent_or_human' && (LEVEL[floor.accountability] ?? 0) > (LEVEL[req.accountability] ?? 0)) out.accountability = floor.accountability;
  if (floor.authorization) out.authorization = true;
  if (floor.provenance) out.provenance = true;
  if (floor.attributes?.length) out.attributes = [...new Set([...(req.attributes ?? []), ...floor.attributes])];
  return out;
}

/** Ask for no more than `cap`. */
export function capAt(req, cap) {
  if (!cap?.accountability || (LEVEL[req.accountability] ?? 0) <= LEVEL[cap.accountability]) return req;
  return { ...req, accountability: cap.accountability };
}

export function createRulebook(initial = { us: [], eu: [] }) {
  const book = { us: [...initial.us], eu: [...initial.eu] };
  const active = (jurisdiction) => (book[jurisdiction] ?? []).map((id) => ({ id, ...REGIMES[id] })).filter((r) => r.name);

  return {
    get: () => ({ us: [...book.us], eu: [...book.eu] }),
    set(jurisdiction, regimes) {
      if (!JURISDICTIONS[jurisdiction]) throw new Error(`no jurisdiction ${jurisdiction}`);
      book[jurisdiction] = regimes.filter((id) => REGIMES[id]);
    },
    active,

    /** Does the law make this place check badges, whatever it chose? */
    mandated(place) {
      return active(place.jurisdiction).some((r) => r.floors.some((f) => f.mandate && f.sectors.includes(place.sector)));
    },

    /**
     * The tiers a place applies to one action under the law: its own tiers
     * raised by every floor that covers it, with a tier in front for each
     * amount threshold, all brought under any cap.
     */
    apply(place, action, tiers) {
      const regimes = active(place.jurisdiction);
      const floors = regimes.flatMap((r) => r.floors.map((f) => ({ ...f, regime: r.name })))
        .filter((f) => f.sectors.includes(place.sector) && (!f.actions || f.actions.includes(action)));
      let out = tiers.map((t) => ({ ...t, require: { ...t.require } }));
      for (const f of floors.filter((x) => x.over == null && !x.restricted)) {
        out = out.map((t) => (t.require.accountability === 'none' && !f.mandate ? t : { ...t, require: raise(t.require, f.require), law: [...(t.law ?? []), f.regime] }));
      }
      for (const f of floors.filter((x) => x.restricted)) {
        out = [{ label: 'age-restricted goods', when: (p) => Boolean(p?.restricted), require: raise(out.at(-1).require, f.require), law: [f.regime] }, ...out];
      }
      for (const f of floors.filter((x) => x.over != null)) {
        const base = out.at(-1);
        out = [{ label: `over $${f.over}`, when: (p) => amountOf(p) > f.over, require: raise(base.require, f.require), law: [f.regime] }, ...out];
      }
      const cap = regimes.find((r) => r.cap);
      if (cap) out = out.map((t) => ({ ...t, require: capAt(t.require, cap.cap), capped: (LEVEL[t.require.accountability] ?? 0) > LEVEL[cap.cap.accountability] ? cap.name : t.capped }));
      return out;
    },
  };
}
