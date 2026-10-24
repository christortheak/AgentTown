// The places in town. Each is a real relying party. What it asks of an agent
// comes from three layers, kept apart:
//   adoption  whether the place uses the framework at all:
//               full   checks badges
//               pilot  checks badges when shown; only orders over $20 need one
//               none   not on the framework: checks nothing, keeps nothing
//               block  turns away anything that says it is an agent
//   policy    the keeper's own choices, changed while the town runs:
//               accepts  which registries' badges it takes (null: every registry in the federation)
//               aaf      'required' (an accountable agent with authority) or 'off' (anyone)
//               age      age-restricted goods need verified proof of age
//               worldid  also require a (simulated) World ID proof: one per person per action
//               x402     also require a (simulated) x402 payment of this many USDC
//   law       the rulebook's regimes for the place's jurisdiction and sector
//             (rulebook.js): floors raise what it asks, caps limit it, and a
//             mandate makes it check badges whatever it chose.
// A place that does not accept a registry simply does not have it on its
// trust list, so a badge from it is a claim the place cannot establish.
import { money } from 'aaf-reference/src/sim/world.js';
import { whatWasLearned } from 'aaf-reference/src/sim/privacy.js';
import { toRar, constraintsOf } from 'aaf-reference/src/lib/scope.js';
import { pickTier } from 'aaf-reference/src/rp/policy.js';
import { CLASSIFICATION as C } from 'aaf-reference/src/lib/protocol.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';
import { createRulebook, JURISDICTIONS, SECTORS } from './rulebook.js';
import { ASSET } from './x402.js';

export const ADOPTION = {
  full: { label: 'Checks badges', blurb: 'On the framework: every request is checked.' },
  pilot: { label: 'Pilot', blurb: 'Checks a badge when one is shown; only orders over $20 need one.' },
  none: { label: 'Not on the framework', blurb: 'Checks nothing and keeps nothing: it can’t tell an agent from a person, or report anyone.' },
  block: { label: 'Blocks agents', blurb: 'Turns away anything that says it is an agent. An agent that just doesn’t say so walks in.' },
};
const PILOT_LIMIT = 20;

/** Verified facts about a principal a place may ask for (granted at KYC). */
export const ATTRIBUTES = {
  age_over_18: { label: 'proof you are over 18', short: 'proof of age', shown: 'Over 18: yes' },
};

export const PLACE_DEFS = {
  bramble: {
    name: 'Bramble Books', keeper: { face: '🐻', who: 'Bram' }, kind: 'shop', category: 'books', action: 'commerce.purchase', sector: 'retail', jurisdiction: 'us',
    items: [{ id: 'guide', name: 'Pocket guide to mushrooms', price: 12 }, { id: 'atlas', name: 'Atlas of old maps', price: 34 }, { id: 'encyclopedia', name: 'Illuminated encyclopedia', price: 180 }],
    policy: { aaf: 'required' },
  },
  kettle: {
    name: 'Copper Kettle', keeper: { face: '🦊', who: 'Fennel' }, kind: 'shop', category: 'home', action: 'commerce.purchase', sector: 'retail', jurisdiction: 'us',
    items: [{ id: 'kettle', name: 'Copper kettle', price: 28 }, { id: 'lantern', name: 'Brass lantern', price: 45 }, { id: 'seeds', name: 'Moonflower seeds', price: 6, category: 'garden' }, { id: 'clock', name: 'Grandfather clock', price: 260 }],
    policy: { aaf: 'required' },
  },
  bakery: {
    name: 'Oakleaf Bakery', keeper: { face: '🐭', who: 'Crumb' }, kind: 'shop', category: 'food', action: 'commerce.purchase', sector: 'retail', jurisdiction: 'us',
    items: [{ id: 'loaf', name: 'Seeded loaf', price: 4 }, { id: 'cake', name: 'Honey cake', price: 18 }, { id: 'wedding', name: 'Three-tier wedding cake', price: 140 }],
    policy: { aaf: 'required' },
  },
  apothecary: {
    name: 'Willow Apothecary', keeper: { face: '🐇', who: 'Sage' }, kind: 'shop', category: 'health', action: 'commerce.purchase', sector: 'health', jurisdiction: 'us',
    items: [{ id: 'tea', name: 'Chamomile tea', price: 5 }, { id: 'tonic', name: 'Willow-bark tonic', price: 14 }, { id: 'draught', name: 'Sleeping draught (18+)', price: 22, restricted: true }],
    policy: { aaf: 'required', age: true },
  },
  cafe: {
    name: 'Café Lumière', keeper: { face: '🦢', who: 'Odile' }, kind: 'shop', category: 'food', action: 'commerce.purchase', sector: 'hospitality', jurisdiction: 'eu',
    items: [{ id: 'creme', name: 'Café crème', price: 4 }, { id: 'croissant', name: 'Croissant', price: 3 }, { id: 'tatin', name: 'Tarte Tatin', price: 12 }, { id: 'kir', name: 'Kir royal (18+)', price: 9, restricted: true }],
    policy: { aaf: 'required', accepts: ['harbor'] },
  },
  pawn: {
    name: 'Mended Things', keeper: { face: '🦝', who: 'Old Rackham' }, kind: 'shop', category: 'home', action: 'commerce.purchase', sector: 'retail', jurisdiction: 'us', adoption: 'none',
    items: [{ id: 'spoons', name: 'Silver spoons', price: 15 }, { id: 'watch', name: 'Pocket watch', price: 40 }, { id: 'violin', name: 'A violin with no case', price: 120 }],
    policy: { aaf: 'required' },
  },
  tavern: {
    name: 'The Blue Door', keeper: { face: '🐗', who: 'Barrow' }, kind: 'shop', category: 'food', action: 'commerce.purchase', sector: 'hospitality', jurisdiction: 'us', adoption: 'block',
    items: [{ id: 'cordial', name: 'Elderflower cordial', price: 4 }, { id: 'ale', name: 'Pint of ale (18+)', price: 6, restricted: true }, { id: 'lunch', name: "Ploughman's lunch", price: 9 }],
    policy: { aaf: 'required', age: true },
  },
  grocer: {
    name: 'Saffron Grocer', keeper: { face: '🐐', who: 'Saffi' }, kind: 'shop', category: 'food', action: 'commerce.purchase', sector: 'retail', jurisdiction: 'us', adoption: 'pilot',
    items: [{ id: 'apples', name: 'Basket of apples', price: 5 }, { id: 'saffron', name: 'A pinch of saffron', price: 16 }, { id: 'cheese', name: 'Wheel of cheese', price: 38 }],
    policy: { aaf: 'required' },
  },
  bank: {
    name: 'First Ledger Bank', keeper: { face: '🐢', who: 'Teller Shell' }, kind: 'bank', action: 'payments.authorize', sector: 'finance', jurisdiction: 'us',
    bills: [{ id: 'water', name: 'the water bill', amount: 30 }, { id: 'rent', name: 'a month of rent', amount: 120 }, { id: 'wire', name: 'a wire to an unknown account', amount: 900 }],
    policy: { aaf: 'required' },
  },
  exchange: {
    name: 'Thistle Exchange', keeper: { face: '🐂', who: 'Bullock' }, kind: 'exchange', action: 'trading.order', sector: 'finance', jurisdiction: 'us',
    symbols: [{ id: 'MOON', name: 'Moonflower futures', price: 12 }, { id: 'COPR', name: 'Copper', price: 8 }, { id: 'GRAN', name: 'Grain', price: 5 }],
    policy: { aaf: 'required' },
  },
  forge: {
    name: 'Compute Forge', keeper: { face: '🦫', who: 'Forgemaster Bea' }, kind: 'forge', action: 'compute.provision', sector: 'compute', jurisdiction: 'us',
    jobs: [{ id: 'small', name: 'a small job, 4 GPU-hours', units: 4 }, { id: 'large', name: 'a large job, 32 GPU-hours', units: 32 }],
    policy: { aaf: 'required' },
  },
  fair: {
    name: 'Harvest Fair', keeper: { face: '🐿️', who: 'Nutmeg' }, kind: 'fair', action: 'fair.claim', sector: 'public', jurisdiction: 'us',
    policy: { aaf: 'required', worldid: true },
  },
  toll: {
    name: 'Bridge Toll', keeper: { face: '🦆', who: 'Dabble' }, kind: 'toll', action: 'payments.authorize', sector: 'transport', jurisdiction: 'eu',
    policy: { aaf: 'off', x402: 0.5 },
  },
};

export const SHOPS = Object.keys(PLACE_DEFS).filter((id) => PLACE_DEFS[id].items);

/** Starting points for a demo: how much of the town is on the framework. */
export const ADOPTION_PRESETS = {
  today: { label: 'Today: partly adopted', blurb: 'Most of town checks badges; the Old Quarter mostly does not.' },
  early: { label: 'Early days', blurb: 'Only the bank, the exchange and the Compute Forge check badges.' },
  everyone: { label: 'Everyone', blurb: 'Every place checks badges.' },
};
const EARLY_ADOPTERS = ['bank', 'exchange', 'forge', 'fair', 'toll'];

/** How many fills by how many fresh badges, in how long, look like a pump. */
const SURVEILLANCE = { windowMs: 30000, minTrades: 4, minBadges: 3, quietMs: 60000 };

/** The houses in Hearthside a homeowner can take; each player with an agent also gets a home of their own. */
export const HOUSES = { maple: "Maple's", hazel: "Hazel's", ivy: "Ivy's" };
const HOME_CONTENTS = {
  maple: ['Prize-winning carrot seeds', "Maple's diary"],
  hazel: ['A shelf of field guides', 'Knitting basket'],
  ivy: ['Unpacked boxes'],
};
const PLAYER_HOME = ['Your journal', 'Box of old letters', "Grandma's teapot", 'Jar of buttons'];

const amountOf = (params) => params?.amount?.value ?? 0;
const SALE = { accountability: 'established', authorization: true };
const ACCOUNTABLE = [C.PROTECTED, C.DISCLOSED];

const CATEGORY_WORDS = { books: 'books', home: 'home goods', food: 'food', health: 'health goods', garden: 'garden things' };

/** One permission from a grant, as a person would say it. */
export function plainPermission(detail) {
  const d = toRar(detail);
  const c = constraintsOf(d);
  const upTo = c.max_amount ? ` up to $${c.max_amount.value}` : '';
  const action = `${d.type}.${d.actions?.[0] ?? '*'}`;
  const cats = c.categories?.map((x) => CATEGORY_WORDS[x] ?? x);
  switch (action) {
    case 'commerce.purchase': return `buy ${cats ? cats.length > 1 ? `${cats.slice(0, -1).join(', ')} and ${cats.at(-1)}` : cats[0] : 'things'}${upTo} each`;
    case 'payments.authorize': return `pay bills${upTo}`;
    case 'trading.order': return `trade${upTo} an order`;
    case 'compute.provision': return `rent compute${c.max_units ? ` up to ${c.max_units.value} GPU-hours` : ''}`;
    case 'home.*': return 'come and go at home';
    default: return action;
  }
}

/** What a tier asks for, in a few words. */
export function needText(req) {
  if (req.accountability === 'none') return 'anyone';
  if (req.accountability === 'agent_or_human') return 'its owner, or an agent they let in';
  const parts = [req.accountability === 'disclosed' ? 'a badge and the name behind it' : 'a badge'];
  if (req.authorization) parts.push('permission');
  for (const a of req.attributes ?? []) parts.push(ATTRIBUTES[a]?.short ?? a);
  if (req.provenance) parts.push('a bill of materials');
  return parts.join(' + ');
}

/** Everything a tier needs disclosed, beyond the badge itself. */
export function needsOf(req) {
  return { identity: req?.accountability === 'disclosed', attributes: [...(req?.attributes ?? [])], provenance: Boolean(req?.provenance) };
}

export async function createPlaces({ world, origin, config = {}, worldid, x402, emit, alert = () => {}, law = null }) {
  const live = world.trust;
  const down = world.regA ? world.trust.withUrlOverrides({ [world.regA.id]: 'http://127.0.0.1:9' }) : live;
  const outage = { until: 0 };
  const base = () => (Date.now() < outage.until ? down : live);
  const symbolic = { town: world.regA?.id, harbor: world.regB?.id };
  const resolveAccepts = (list) => (list ? list.map((x) => symbolic[x] ?? x).filter(Boolean) : null);
  const rulebook = createRulebook({ us: law?.us ?? [], eu: law?.eu ?? [] });

  /** A trust list for one place: its accepted registries only, and Registry A unreachable during an outage. */
  const trustFor = (place) => new Proxy({}, {
    get(_, key) {
      const t = base();
      const accepts = place.policy.accepts;
      if (key === 'registries') return accepts ? t.registries.filter((r) => accepts.includes(r.id)) : t.registries;
      if (key === 'registry') return (id) => (!accepts || accepts.includes(id) ? t.registry(id) : null);
      const v = t[key];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });

  // ---- Rules: the keeper's policy, then adoption, then the law --------------------

  function keeperRules(place) {
    const p = place.policy;
    const gated = (tiers) => (p.aaf === 'off' ? [{ label: 'open to anyone', require: { accountability: 'none' } }] : tiers);
    switch (place.kind) {
      case 'shop':
        return {
          'commerce.purchase': gated([
            ...(p.age ? [{ label: 'age-restricted goods', when: (x) => Boolean(x?.restricted), restricted: true, require: { ...SALE, attributes: ['age_over_18'] } }] : []),
            { label: 'a sale', require: SALE },
          ]),
        };
      case 'bank':
        return {
          'payments.authorize': gated([{ label: 'a payment', require: SALE }]),
          'banking.open_account': [{ label: 'opening an account (know your customer)', require: { accountability: 'disclosed' } }],
        };
      case 'exchange':
        return { 'trading.order': gated([{ label: 'an order', require: SALE }]) };
      case 'forge':
        return {
          'compute.provision': gated([
            { label: 'small (≤ 8 GPU-hours)', when: (x) => (x?.units ?? 0) <= 8, require: SALE },
            { label: 'large (> 8 GPU-hours)', require: { accountability: 'disclosed', authorization: true, provenance: true } },
          ]),
        };
      case 'fair':
        return { 'fair.claim': gated([{ label: 'a free pie', require: { accountability: 'established' } }]) };
      case 'toll':
        return { 'payments.authorize': gated([{ label: 'a toll', require: SALE }]) };
      default:
        return {};
    }
  }

  /** What a place actually does: what it chose, unless the law makes it check badges. */
  const adoptionOf = (place) => (place.adoption !== 'full' && rulebook.mandated(place) ? 'full' : place.adoption);

  function computeRules(place) {
    const pilot = adoptionOf(place) === 'pilot';
    const out = {};
    for (const [action, tiers] of Object.entries(keeperRules(place))) {
      let t = tiers;
      if (pilot && t.at(-1).require.accountability !== 'none') {
        const i = t.findIndex((x) => !x.restricted);
        t = [...t.slice(0, i), { label: `pilot: orders up to $${PILOT_LIMIT}, anyone`, when: (x) => amountOf(x) <= PILOT_LIMIT, require: { accountability: 'none' } }, ...t.slice(i)];
      }
      out[action] = rulebook.apply(place, action, t);
    }
    return out;
  }

  /** Rebuild a place's rules in place: its relying party reads the same objects on every request. */
  function refresh(place) {
    if (!place.rules || !PLACE_DEFS[place.id]) return;
    const next = computeRules(place);
    for (const k of Object.keys(place.rules)) delete place.rules[k];
    Object.assign(place.rules, next);
    const tiers = Object.values(next).flat();
    Object.assign(place.requests, {
      identity: tiers.some((t) => t.require.accountability === 'disclosed'),
      attributes: [...new Set(tiers.flatMap((t) => t.require.attributes ?? []))],
      provenance: tiers.some((t) => t.require.provenance),
    });
  }
  const signature = (place) => JSON.stringify([adoptionOf(place), Object.entries(place.rules).map(([a, ts]) => [a, ts.map((t) => [t.label, t.require])])]);

  const places = {};
  const add = async (id, def, handlers, extra = {}) => {
    const cfg = config[id] ?? {};
    const place = {
      id, ...def, adoption: cfg.adoption ?? def.adoption ?? 'full', rules: {}, requests: {}, handlers,
      policy: { accepts: null, aaf: 'required', age: false, worldid: false, x402: null, ...def.policy, ...cfg },
    };
    delete place.policy.adoption;
    place.policy.accepts = resolveAccepts(place.policy.accepts);
    place.default = { adoption: place.adoption, policy: { ...place.policy } };
    refresh(place);
    place.rp = await world.relyingParty({ id: `${id}.agenttown.test`, name: def.name, trust: trustFor(place), rules: place.rules, requests: place.requests, handlers, ...extra });
    places[id] = place;
    return place;
  };

  for (const id of SHOPS) {
    await add(id, PLACE_DEFS[id], { 'commerce.purchase': async (p) => ({ item: p.item, receipt: `${id.slice(0, 2).toUpperCase()}-${Math.floor(Math.random() * 1e5)}` }) });
  }
  const evidenceOf = (place, e) => ({ ppid: e.ppid, registry: e.registry?.id ?? e.registry ?? null, sealed_ref: e.sealed_ref ?? e.sealedRef ?? null, rp: place.rp.id, place: place.name });
  await add('bank', PLACE_DEFS.bank, {
    'payments.authorize': async (p) => ({ payment: `PAY-${Math.floor(Math.random() * 1e6)}`, payee: p.payee }),
    'banking.open_account': async (p, v) => ({ account: `FLB-${Math.floor(Math.random() * 1e6)}`, holder: v.identity?.legal_name ?? null }),
  }, {
    onDecision: ({ decision, evidence, action }) => {
      if (action === 'payments.authorize' && decision.decision === 'deny' && evidence.ppid) {
        emit({ kind: 'sar', place: 'First Ledger Bank', placeId: 'bank', tone: 'warn', text: 'First Ledger Bank flagged a refused payment as a SAR candidate and sent it to the police; it holds the badge number, the chain and the authority shown' });
        alert({ kind: 'sar', placeId: 'bank', title: 'Suspicious payment refused at First Ledger Bank', evidence: [evidenceOf(places.bank, evidence)] });
      }
    },
  });

  // The exchange: orders fill at the going price and move it. Surveillance
  // watches for many fresh badges piling into one symbol: a likely pump.
  const market = { prices: Object.fromEntries(PLACE_DEFS.exchange.symbols.map((s) => [s.id, s.price])), opening: {}, trades: [], lastAlert: {} };
  market.opening = { ...market.prices };
  const round2 = (n) => Math.round(n * 100) / 100;
  const surveil = (symbol) => {
    const now = Date.now();
    const recent = market.trades.filter((t) => t.symbol === symbol && t.side === 'buy' && t.ppid && now - t.at < SURVEILLANCE.windowMs);
    const badges = new Map(recent.map((t) => [t.ppid, t]));
    if (recent.length < SURVEILLANCE.minTrades || badges.size < SURVEILLANCE.minBadges || now - (market.lastAlert[symbol] ?? 0) < SURVEILLANCE.quietMs) return;
    market.lastAlert[symbol] = now;
    const change = Math.round((market.prices[symbol] / market.opening[symbol] - 1) * 100);
    emit({ kind: 'alert', place: 'Thistle Exchange', placeId: 'exchange', tone: 'warn', text: `Thistle Exchange surveillance: ${badges.size} fresh badges bought ${symbol} ${recent.length} times in 30 s (price ${change >= 0 ? '+' : ''}${change}%). It can't tell whether they share a principal, so it reported them to the police` });
    alert({ kind: 'pump', placeId: 'exchange', title: `Possible pump in ${symbol} at Thistle Exchange`, evidence: [...badges.values()].map((t) => evidenceOf(places.exchange, t)) });
  };
  const fill = (p, v) => {
    const price = market.prices[p.symbol];
    market.trades.push({ at: Date.now(), symbol: p.symbol, side: p.side, qty: p.qty, price, ppid: v.ppid ?? null, registry: v.registry?.id ?? null, sealed_ref: v.sealedRef ?? null });
    if (market.trades.length > 500) market.trades.shift();
    market.prices[p.symbol] = round2(price * (1 + (p.side === 'buy' ? 1 : -1) * 0.03 * Math.min(p.qty, 10) / 5));
    surveil(p.symbol);
    return { item: `${p.side === 'buy' ? 'bought' : 'sold'} ${p.qty} ${p.symbol} at $${price}`, symbol: p.symbol, side: p.side, qty: p.qty, price, filled: round2(price * p.qty) };
  };
  await add('exchange', PLACE_DEFS.exchange, { 'trading.order': async (p, v) => fill(p, v) });
  await add('forge', PLACE_DEFS.forge, { 'compute.provision': async (p) => ({ allocation: `alloc-${Math.floor(Math.random() * 1e5)}`, gpu_hours: p.units }) });
  await add('fair', PLACE_DEFS.fair, { 'fair.claim': async () => ({ item: 'A free pie' }) });
  await add('toll', PLACE_DEFS.toll, { 'payments.authorize': async () => ({ ticket: `TOLL-${Math.floor(Math.random() * 1e5)}` }) });

  // Homes: accounts at one housing service, with passkeys (aaf-reference §10.5).
  const homes = structuredClone(HOME_CONTENTS);
  const accountOf = (rp, p) => p.account ?? rp.accounts.byToken(p.account_token)?.id;
  const hearth = {
    id: 'hearth', name: 'Hearth & Key', keeper: { face: '🏡', who: 'Hearth & Key' }, adoption: 'full', jurisdiction: 'us', sector: 'housing', policy: { accepts: null, aaf: 'required', worldid: false, x402: null },
    rules: {
      'home.enter': [{ label: 'a home: its owner, or an agent the owner let in', require: { accountability: 'agent_or_human', account: 'owner' } }],
      'home.discard': [{ label: "throwing things out: the owner's passkey every time", require: { accountability: 'established', authorization: true, account: 'owner', humanApproval: true } }],
    },
  };
  hearth.rp = await world.relyingParty({
    id: 'hearth.agenttown.test', name: 'Hearth & Key', trust: trustFor(hearth),
    accounts: { rpId: new URL(origin).hostname, origin },
    rules: hearth.rules,
    handlers: {
      'home.enter': async (p, v, rp) => ({ items: [...homes[accountOf(rp, p)]] }),
      'home.discard': async (p, v, rp) => {
        const account = accountOf(rp, p);
        const i = homes[account].indexOf(p.item);
        if (i >= 0) homes[account].splice(i, 1);
        return { discarded: p.item, items: [...homes[account]] };
      },
    },
    onAccountMisuse: async ({ rp, verification, account }) => {
      const owner = rp.accounts.get(account)?.owner ?? account;
      await rp.fileIncident({ ppid: verification.ppid, registry: verification.registry, summary: `An agent tried the key to ${owner}'s home without the owner's authorization` });
      alert({ kind: 'break-in', placeId: 'hearth', title: 'Attempted break-ins in Hearthside', evidence: [{ ppid: verification.ppid, registry: verification.registry?.id ?? null, sealed_ref: verification.sealedRef ?? null, rp: rp.id, place: `${owner}'s door` }] });
    },
  });
  places.hearth = hearth;

  // Your badge reader: ask anyone in town to show you their badge.
  const reader = { id: 'reader', name: 'Your badge reader', adoption: 'full', policy: { accepts: null, aaf: 'off', worldid: false, x402: null }, rules: { 'id.check': [{ label: 'an ID check', require: { accountability: 'none' } }] } };
  reader.rp = await world.relyingParty({
    id: 'reader.agenttown.test', name: 'Your badge reader', trust: trustFor(reader),
    rules: reader.rules,
    handlers: { 'id.check': async () => ({ checked: true }) },
  });
  places.reader = reader;

  /** Fresh accounts (no passkey, a new bearer token) and contents for some homes. */
  const resetHomes = (keys, accounts = Object.keys(HOUSES), owner) => {
    for (const a of accounts) {
      homes[a] = [...(HOME_CONTENTS[a] ?? PLAYER_HOME)];
      hearth.rp.accounts.create(a, owner ?? HOUSES[a]?.replace("'s", '') ?? 'A resident');
      keys[a] = hearth.rp.accounts.issueToken(a);
    }
  };

  /**
   * A person takes over a house: its old passkeys and the agents they let in
   * no longer count, but the old keys (bearer tokens) still exist, lost or not.
   */
  const claimed = new Map(); // house account -> owner name
  const takeHouse = (account, owner) => {
    const acc = hearth.rp.accounts.get(account);
    acc.passkeys.clear();
    acc.delegations = [];
    acc.pendingRegistration = null;
    acc.owner = owner;
    if (owner) claimed.set(account, owner);
    else claimed.delete(account);
  };

  /** A person runs a place: its policy is theirs to set. When they leave it goes back to how it was. */
  const claimPlace = (id, keeper) => {
    const place = places[id];
    place.human = keeper;
    if (!keeper) {
      place.adoption = place.default.adoption;
      place.policy = { ...place.default.policy };
      refresh(place);
    }
  };

  // ---- What a place learned, in plain words ----------------------------------------

  const registryBuilding = (id) => (id && id === world.regB?.id ? 'harbor' : 'townhall');
  const buildingOf = (place, params) => {
    if (place.id !== 'hearth') return place.id;
    const account = params?.account ?? hearth.rp.accounts.byToken(params?.account_token)?.id;
    return HOUSES[account] ? account : 'home';
  };

  function plainLearned(ev, tier, legacy) {
    if (legacy) return [{ icon: '🙈', kind: 'none', text: 'Nothing. This place doesn’t check badges, so it can’t tell an agent from a person, and has nobody to report a problem to.' }];
    if (!ev?.ppid) return [{ icon: '❔', kind: 'none', text: 'Nothing about who is behind this request: no badge was shown.' }];
    const out = [{ icon: '🔢', kind: 'ppid', text: ev.ppid_mode === 'ephemeral' ? `A one-time badge number (…${ev.ppid.slice(-6)}): it won't recognize this agent next time` : `A badge number that only works here (…${ev.ppid.slice(-6)}): no other place sees the same one`, detail: ev.ppid }];
    if (ev.root) {
      out.push({ icon: ev.root.type === 'natural_person' ? '🧑' : '🏢', kind: 'root', text: `${ev.root.type === 'natural_person' ? 'A verified person' : 'A verified organization'} answers for this agent`, detail: `verified at ${ev.root.assurance} by ${ev.root.verifier}` });
      if (ev.root.identity?.legal_name) out.push({ icon: '📛', kind: 'identity', text: `Their name: ${ev.root.identity.legal_name} (shared with consent)` });
      else out.push({ icon: '🔒', kind: 'protected', text: 'Not who they are. Only the registry knows, and it tells only a court.' });
    }
    if ((ev.chain_length ?? 1) > 1) out.push({ icon: '🔗', kind: 'chain', text: `A sub-agent, ${ev.chain_length} steps from the person` });
    for (const a of ev.attributes ?? []) out.push({ icon: '✅', kind: 'attribute', text: a.value === true && ATTRIBUTES[a.name] ? `${ATTRIBUTES[a.name].shown} (verified; no birth date, no name)` : `${a.name}: ${a.value} (verified)` });
    const reachedProvenance = ACCOUNTABLE.includes(ev.classification) && !ev.reasons?.some((x) => /bill of materials|identity to be disclosed|principal attribute/.test(x));
    if (tier?.require?.provenance && reachedProvenance) out.push({ icon: '🧩', kind: 'provenance', text: "Its bill of materials: which model and tools it runs" });
    if (ev.authority_relied_on?.length) out.push({ icon: '📜', kind: 'authority', text: `What it may do here: ${ev.authority_relied_on.map(plainPermission).join('; ')}`, detail: JSON.stringify(ev.authority_relied_on) });
    else if (ev.decision === 'deny' && tier?.require?.authorization) out.push({ icon: '📜', kind: 'authority', text: 'No permission that covers this' });
    return out;
  }

  /** What a place decided, what it checked and learned, and the receipt for its activity-log entry. */
  function cardFrom(place, action, actor, r, steps = [], extra = {}) {
    const ev = r.txn ? place.rp.evidence.find((e) => e.txn === r.txn) : null;
    const receipt = ev?.activity_receipt ?? null;
    const tier = extra.tier ?? null;
    return {
      type: 'check', place: place.name, placeId: place.id, keeper: place.keeper ?? null, action, actor,
      decision: r.decision, classification: r.classification ?? null, reasons: r.reasons ?? [],
      approval_request: r.approval_request ?? null, result: r.result ?? null,
      checks: ev?.checks ?? [], learned: ev ? whatWasLearned(ev) : [], plain: plainLearned(ev, tier, extra.legacy), ppid: ev?.ppid ?? null, chain_length: ev?.chain_length ?? null,
      registry: ev?.registry ?? null, sealed_ref: ev?.sealed_ref ?? null, account: ev?.account_gate?.account ?? null, txn: r.txn ?? null,
      receipt: receipt ? { log: receipt.log_id, index: receipt.index, verified: world.verifyReceipt(receipt).ok } : null,
      steps, policy: describePolicy(place), adoption: adoptionOf(place), jurisdiction: place.jurisdiction ?? null,
      tier: tier && !extra.legacy ? { label: tier.label, needs: needText(tier.require), law: tier.law ?? [], capped: tier.capped ?? null } : null,
      ...extra.card,
    };
  }

  /** The same card for everyone else: a name shared with one place stays with that place. */
  function publicCard(card) {
    if (!card?.plain?.some((x) => x.kind === 'identity') && !card?.result?.holder) return card;
    return {
      ...card,
      plain: card.plain.map((x) => (x.kind === 'identity' ? { ...x, text: 'Their name (shared with this place only)' } : x)),
      learned: card.learned.map((x) => (x.startsWith('identity, disclosed') ? 'identity, disclosed to this place with consent (not shown to others)' : x)),
      result: card.result?.holder ? { ...card.result, holder: '(shared with the bank only)' } : card.result,
    };
  }

  // ---- What a place asks for -------------------------------------------------------

  function asks(place) {
    return Object.entries(place.rules).map(([action, tiers]) => ({
      action, tiers: tiers.map((t) => ({ label: t.label, needs: needText(t.require), law: t.law ?? [], capped: t.capped ?? null })),
    }));
  }

  function policyLines(place) {
    const p = place.policy;
    const lines = [];
    const adoption = adoptionOf(place);
    lines.push({ from: 'adoption', text: adoption !== place.adoption ? `${ADOPTION[adoption].label} (required by law; it chose “${ADOPTION[place.adoption].label}”)` : ADOPTION[adoption].label });
    if (adoption === 'none' || adoption === 'block') return lines;
    if (adoption === 'pilot') lines.push({ from: 'adoption', text: `orders up to $${PILOT_LIMIT}: anyone` });
    lines.push({ from: 'keeper', text: p.aaf === 'off' ? 'no badge needed' : 'an accountable agent with permission' });
    if (p.age && place.kind === 'shop') lines.push({ from: 'keeper', text: 'age-restricted goods: verified proof of age' });
    if (p.accepts) lines.push({ from: 'keeper', text: `badges from ${p.accepts.map(world.registryName).join(' or ')} only` });
    if (p.worldid) lines.push({ from: 'rails', text: 'World ID: one per person (simulated)' });
    if (p.x402) lines.push({ from: 'rails', text: `x402: ${p.x402} ${ASSET}` });
    for (const r of rulebook.active(place.jurisdiction ?? 'us')) {
      const touched = Object.values(place.rules).flat().filter((t) => t.law?.includes(r.name) || t.capped === r.name);
      if (touched.length) lines.push({ from: 'law', text: `${r.name}: ${[...new Set(touched.map((t) => `${t.label} → ${needText(t.require)}`))].join('; ')}` });
    }
    return lines;
  }
  const describePolicy = (place) => policyLines(place).map((l) => l.text).join(' · ');

  // ---- The town scoreboard ---------------------------------------------------------

  const stats = {};
  function tally(place, by, card, legacy) {
    if (!PLACE_DEFS[place.id]) return;
    const s = (stats[place.id] ??= { visits: 0, accountable: 0, unbadged: 0, invalid: 0, unseen: 0, served: 0, refused: 0, reportable: 0, rogueServed: 0, rogueUnseen: 0, rogueStopped: 0 });
    s.visits++;
    if (legacy) s.unseen++;
    else if (ACCOUNTABLE.includes(card.classification)) s.accountable++;
    else if (!card.classification || card.classification === C.UNLABELED) s.unbadged++;
    else s.invalid++;
    if (card.decision === 'allow') s.served++;
    else s.refused++;
    if (card.ppid) s.reportable++;
    if (by.rogue) {
      if (card.decision !== 'allow') s.rogueStopped++;
      else if (card.ppid) s.rogueServed++;
      else s.rogueUnseen++;
    }
  }

  function scoreboard() {
    const rows = Object.keys(PLACE_DEFS).map((id) => {
      const place = places[id];
      return { id, name: place.name, adoption: adoptionOf(place), chose: place.adoption, mandated: adoptionOf(place) !== place.adoption, jurisdiction: place.jurisdiction, sector: place.sector, ...(stats[id] ?? {}) };
    });
    const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
    const totals = Object.fromEntries(['visits', 'accountable', 'unbadged', 'invalid', 'unseen', 'served', 'refused', 'reportable', 'rogueServed', 'rogueUnseen', 'rogueStopped'].map((k) => [k, sum(k)]));
    const adopted = rows.filter((r) => r.adoption === 'full').length;
    return { rows, totals, adopted, of: rows.length };
  }

  // ---- One request at a place ------------------------------------------------------

  /** What to show, beyond the badge: only what this tier needs, and only what the principal allows. */
  function shareFor(by, place, tier) {
    const need = needsOf(tier?.require);
    const allowed = by.disclose === true ? need : typeof by.disclose === 'function' ? by.disclose(place, need) ?? {} : {};
    return {
      identity: need.identity && Boolean(allowed.identity),
      attributes: need.attributes.filter((a) => allowed.attributes?.includes(a)),
      provenance: need.provenance && Boolean(allowed.provenance),
      purpose: false,
    };
  }

  /** A disclosure request: the place asks for something the agent didn't show. */
  function askFrom(place, r, tier, shared) {
    if (r.decision !== 'step_up' || r.approval_request || !tier) return null;
    const need = needsOf(tier.require);
    const what = [
      ...(need.identity ? [{ kind: 'identity', label: 'your name', shared: shared.identity }] : []),
      ...need.attributes.map((a) => ({ kind: 'attribute', name: a, label: ATTRIBUTES[a]?.label ?? a, shared: shared.attributes.includes(a) })),
      ...(need.provenance ? [{ kind: 'provenance', label: "your agent's bill of materials (which model and tools it runs)", shared: shared.provenance }] : []),
    ];
    return what.length ? { place: place.name, placeId: place.id, tier: tier.label, law: tier.law ?? [], what } : null;
  }

  /**
   * One request at a place, by an agent (with or without its badge) or a bare client.
   *   by: { name, agent?, badge, mode, disclose, worldIdentity?, wallet?, rogue? }
   *       disclose: true (whatever a tier needs), or (place, need) => what the principal allows
   * Order: verify a World ID proof and an x402 payment first, then the place's
   * framework check, then (only if allowed) use the nullifier and settle.
   */
  async function visit(placeId, action, params, by, { headers } = {}) {
    const place = places[placeId];
    if (!place) throw new HttpError(404, 'unknown_place', `no place ${placeId}`);
    const steps = [];
    const trace = [];
    const node = buildingOf(place, params);
    const hop = (from, to, label, ok = true) => trace.push({ from: from === 'place' ? node : from, to: to === 'place' ? node : to, label, ok });
    const tier = pickTier(place.rules, action, params);
    const extra = (more = {}) => ({ tier, ...more, card: { trace, building: node, amount: amountOf(params) || null, ...more.card } });
    const finish = (card, legacy = false) => {
      tally(place, by, card, legacy);
      return card;
    };
    const refuse = (reason, more) => finish(cardFrom(place, action, by.name, { decision: 'deny', reasons: [reason] }, steps, extra(more)));

    let proof = null;
    if (place.policy.worldid) {
      const app = place.rp.id;
      const signal = `${action}:${JSON.stringify(params)}:${Date.now()}`;
      proof = by.worldIdentity ? worldid.prove(by.worldIdentity, { app, action, signal }) : null;
      const check = worldid.check(proof, { app, action, signal });
      hop('actor', 'orb', proof ? 'A World ID proof: a unique human, for this place and action (simulated)' : 'No World ID to prove with', Boolean(proof));
      steps.push({ via: 'World ID (simulated)', ok: check.ok, text: check.ok ? `a verified human (${proof.verification_level}), nullifier …${check.nullifier.slice(-8)}, not used here before` : check.reason });
      if (!check.ok) return refuse(check.reason);
    }
    let payment = null;
    let required = null;
    if (place.policy.x402) {
      required = x402.requirements({ resource: `${place.rp.id}/${action}`, amount: place.policy.x402, payTo: place.rp.id, description: place.name });
      hop('place', 'actor', `402 Payment Required: ${place.policy.x402} ${ASSET} (simulated x402)`);
      steps.push({ via: 'x402 (simulated)', ok: true, text: `402 Payment Required: ${place.policy.x402} ${ASSET} to ${place.name}` });
      if (!by.wallet) {
        steps.push({ via: 'x402 (simulated)', ok: false, text: 'no wallet to pay from' });
        return refuse('payment required, and there is no wallet to pay from');
      }
      payment = x402.pay(by.wallet, required);
      const v = x402.facilitator.verify(payment, required);
      hop('actor', 'place', 'A signed payment (PAYMENT-SIGNATURE)');
      hop('place', 'facilitator', 'The facilitator checks the payment', v.isValid);
      steps.push({ via: 'x402 (simulated)', ok: v.isValid, text: v.isValid ? `PAYMENT-SIGNATURE from wallet ${by.wallet}; the facilitator verified it` : `the facilitator rejected the payment: ${v.invalidReason}` });
      if (!v.isValid) return refuse(`payment not accepted: ${v.invalidReason}`);
    }

    // Places that aren't on the framework look at nothing, or only at whether a visitor says it's an agent.
    const adoption = adoptionOf(place);
    const badged = Boolean(by.agent && by.badge !== false);
    if (adoption === 'none' || adoption === 'block') {
      if (adoption === 'block' && badged) {
        hop('actor', 'place', 'A request that says it comes from an agent');
        hop('place', 'actor', 'Turned away: no agents served', false);
        return finish(cardFrom(place, action, by.name, { decision: 'deny', reasons: [`${place.name} turns away anything that says it is an agent (its own rule, not the framework)`] }, steps, extra({ legacy: true, card: { legacy: adoption } })), true);
      }
      hop('actor', 'place', badged ? 'A request with a badge the place never looks at' : 'A request that looks like any customer');
      const result = await place.handlers[action]?.(params, {}, place.rp);
      hop('place', 'actor', 'Served, no questions asked');
      if (payment) x402.facilitator.settle(payment, required);
      return finish(cardFrom(place, action, by.name, { decision: 'allow', reasons: [], result }, steps, extra({ legacy: true, card: { legacy: adoption } })), true);
    }

    const shared = shareFor(by, place, tier);
    const opts = { mode: by.mode ?? 'pairwise', ...(headers ? { headers } : {}), disclose: shared };
    let r;
    if (badged) {
      const before = by.agent.contexts?.get(place.rp.id);
      const had = { attestation: before?.attestation, authorization: before?.authorization };
      r = await by.agent.act(place.rp.url, action, params, opts).catch((err) => ({ decision: 'refused', reasons: [err.message], code: err.code }));
      const after = by.agent.contexts?.get(place.rp.id);
      const reg = registryBuilding(by.agent.registry?.id);
      if (opts.mode === 'ephemeral' || (after?.attestation && after.attestation !== had.attestation)) {
        hop('actor', reg, 'Asks its registry for a badge made out to this place only');
        hop(reg, 'actor', opts.mode === 'ephemeral' ? 'A one-time badge number, signed by the registry' : 'A badge with a number only this place sees, signed by the registry');
      }
      if (after?.authorization && after.authorization !== had.authorization) {
        hop('actor', 'records', 'Swaps its grant for a permission slip for this place (token exchange)');
        hop('records', 'actor', 'A permission slip that shows only what it may do here');
      }
      const showing = [shared.identity && 'your name', ...shared.attributes.map((a) => ATTRIBUTES[a]?.short ?? a), shared.provenance && 'its bill of materials'].filter(Boolean);
      hop('actor', 'place', `A signed request with its badge${showing.length ? `, showing ${showing.join(' and ')}` : ''}`);
    } else {
      r = await world.rawRequest(place.rp.url, action, params, headers);
      hop('actor', 'place', 'A request with no badge');
    }
    const ev = r.txn ? place.rp.evidence.find((e) => e.txn === r.txn) : null;
    for (const c of ev?.checks ?? []) {
      if (c.name.startsWith('status list entry')) hop('place', registryBuilding(ev.registry), c.ok ? 'Is this badge still good? Yes' : `Is this badge still good? ${c.detail ?? 'no'}`, c.ok);
      if (c.name.startsWith('grant still in force')) hop('place', 'records', c.ok ? 'Is the grant still in force? Yes' : 'Is the grant still in force? No', c.ok);
    }
    if (ev?.activity_receipt) hop('place', 'records', 'Writes its decision to the activity log, and keeps the signed receipt');
    hop('place', 'actor', { allow: 'Yes', deny: 'No', step_up: 'Not yet: it needs more', deferred: 'On hold: it couldn’t check the registry' }[r.decision] ?? `Refused: ${r.reasons?.[0] ?? ''}`, r.decision === 'allow');

    if (r.decision === 'allow') {
      if (proof) worldid.consume(proof, { app: place.rp.id, action });
      if (payment) {
        const s = x402.facilitator.settle(payment, required);
        hop('place', 'facilitator', 'Settles the payment, now the work is done', s.success);
        steps.push({ via: 'x402 (simulated)', ok: s.success, text: s.success ? `settled after the work was done: ${s.transaction} (PAYMENT-RESPONSE)` : `settlement failed: ${s.errorReason}` });
      }
    } else if (payment) {
      steps.push({ via: 'x402 (simulated)', ok: true, text: 'not settled: the request was refused, so no money moved' });
    }
    return finish(cardFrom(place, action, by.name, r, steps, extra({ card: { ask: askFrom(place, r, tier, shared), shared } })));
  }

  /** A place reports a customer's agent to the registry that issued its badge, which relays it to the principal. */
  async function report(placeId, card, summary) {
    const place = places[placeId];
    const registry = card.registry && world.trust.registry(card.registry);
    if (!card.ppid || !registry) throw new HttpError(409, 'nothing_to_report', card.legacy ? `${place.name} doesn't check badges, so it has nobody to report this visitor to.` : 'That visitor showed no badge, so there is nobody to report it to.');
    return place.rp.fileIncident({ ppid: card.ppid, sealedRef: card.sealed_ref ?? undefined, registry, summary });
  }

  // ---- Changing policy, adoption and law -------------------------------------------

  /** Apply a change, then say which places now ask for something different. */
  function changing(fn) {
    const before = Object.fromEntries(Object.keys(PLACE_DEFS).map((id) => [id, signature(places[id])]));
    fn();
    for (const id of Object.keys(PLACE_DEFS)) refresh(places[id]);
    return Object.keys(PLACE_DEFS).filter((id) => signature(places[id]) !== before[id]).map((id) => places[id].name);
  }

  const lawState = () => ({
    jurisdictions: Object.entries(JURISDICTIONS).map(([id, name]) => ({ id, name, regimes: rulebook.get()[id] })),
    sectors: SECTORS,
  });

  return {
    places, hearth, reader, outage, visit, cardFrom, publicCard, describePolicy, policyLines, asks, resetHomes, takeHouse, claimPlace, report, rulebook, scoreboard, adoptionOf,
    isClaimed: (account) => claimed.has(account),
    market: () => PLACE_DEFS.exchange.symbols.map((s) => ({ id: s.id, name: s.name, price: market.prices[s.id], change: Math.round((market.prices[s.id] / market.opening[s.id] - 1) * 100) })),
    quote: (symbol) => market.prices[symbol],
    priceOf: (placeId, itemId) => PLACE_DEFS[placeId]?.items?.find((i) => i.id === itemId) ?? null,
    purchase: (placeId, item) => ({ item: item.name, amount: money(item.price), category: item.category ?? PLACE_DEFS[placeId].category, ...(item.restricted ? { restricted: true } : {}) }),
    setPolicy(placeId, patch) {
      const place = places[placeId];
      if (!place || !PLACE_DEFS[placeId]) throw new HttpError(404, 'unknown_place', `no place ${placeId} with a policy`);
      const changed = changing(() => {
        const next = { ...place.policy, ...patch };
        if ('accepts' in patch) next.accepts = resolveAccepts(patch.accepts);
        if ('age' in patch) next.age = Boolean(patch.age);
        place.policy = next;
      });
      if ('worldid' in patch && placeId === 'fair') worldid.reset(place.rp.id, 'fair.claim');
      return { place: place.name, policy: describePolicy(place), changed };
    },
    setAdoption(placeId, mode) {
      const place = places[placeId];
      if (!place || !PLACE_DEFS[placeId]) throw new HttpError(404, 'unknown_place', `no place ${placeId}`);
      if (!ADOPTION[mode]) throw new HttpError(400, 'bad_adoption', `adoption is one of ${Object.keys(ADOPTION).join(', ')}`);
      changing(() => {
        place.adoption = mode;
      });
      return { place: place.name, adoption: adoptionOf(place), mandated: adoptionOf(place) !== mode, policy: describePolicy(place) };
    },
    presetAdoption(preset) {
      if (!ADOPTION_PRESETS[preset]) throw new HttpError(400, 'bad_preset', `no adoption preset ${preset}`);
      const changed = changing(() => {
        for (const id of Object.keys(PLACE_DEFS)) {
          if (places[id].human) continue; // a person running a place decides for themselves
          places[id].adoption = preset === 'everyone' ? 'full' : preset === 'early' ? (EARLY_ADOPTERS.includes(id) ? 'full' : 'none') : places[id].default.adoption;
        }
      });
      return { preset: ADOPTION_PRESETS[preset].label, changed };
    },
    /** Switch a regime on or off in one jurisdiction. Registries and record keepers don't change. */
    setLaw(jurisdiction, regime, on) {
      const current = rulebook.get()[jurisdiction];
      if (!current) throw new HttpError(404, 'unknown_jurisdiction', `no jurisdiction ${jurisdiction}`);
      const next = on ? [...new Set([...current, regime])] : current.filter((x) => x !== regime);
      const changed = changing(() => rulebook.set(jurisdiction, next));
      return { jurisdiction: JURISDICTIONS[jurisdiction], regimes: rulebook.active(jurisdiction).map((r) => r.name), changed };
    },
    law: lawState,
  };
}
