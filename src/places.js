// The places in town. Each is a real relying party with a policy its keeper
// can change while the town runs:
//   accepts   which registries' badges it takes (null: every registry in the federation)
//   aaf       'required' (an accountable agent with authority) or 'off' (anyone)
//   worldid   also require a (simulated) World ID proof: one per person per action
//   x402      also require a (simulated) x402 payment of this many USDC
// A place that does not accept a registry simply does not have it on its
// trust list, so a badge from it is a claim the place cannot establish.
import { money } from 'aaf-reference/src/sim/world.js';
import { whatWasLearned } from 'aaf-reference/src/sim/privacy.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';
import { ASSET } from './x402.js';

const OPEN = (place) => ({ label: 'open to anyone', when: () => place.policy.aaf === 'off', require: { accountability: 'none' } });

export const PLACE_DEFS = {
  bramble: {
    name: 'Bramble Books', keeper: { face: '🐻', who: 'Bram' }, category: 'books', action: 'commerce.purchase',
    items: [{ id: 'guide', name: 'Pocket guide to mushrooms', price: 12 }, { id: 'atlas', name: 'Atlas of old maps', price: 34 }, { id: 'encyclopedia', name: 'Illuminated encyclopedia', price: 180 }],
    policy: { aaf: 'required' },
  },
  kettle: {
    name: 'Copper Kettle', keeper: { face: '🦊', who: 'Fennel' }, category: 'home', action: 'commerce.purchase',
    items: [{ id: 'kettle', name: 'Copper kettle', price: 28 }, { id: 'lantern', name: 'Brass lantern', price: 45 }, { id: 'seeds', name: 'Moonflower seeds', price: 6, category: 'garden' }, { id: 'clock', name: 'Grandfather clock', price: 260 }],
    policy: { aaf: 'required' },
  },
  bakery: {
    name: 'Oakleaf Bakery', keeper: { face: '🐭', who: 'Crumb' }, category: 'food', action: 'commerce.purchase',
    items: [{ id: 'loaf', name: 'Seeded loaf', price: 4 }, { id: 'cake', name: 'Honey cake', price: 18 }, { id: 'wedding', name: 'Three-tier wedding cake', price: 140 }],
    policy: { aaf: 'required' },
  },
  cafe: {
    name: 'Café Lumière', keeper: { face: '🦢', who: 'Odile' }, category: 'food', action: 'commerce.purchase',
    items: [{ id: 'creme', name: 'Café crème', price: 4 }, { id: 'croissant', name: 'Croissant', price: 3 }, { id: 'tatin', name: 'Tarte Tatin', price: 12 }],
    policy: { aaf: 'required', accepts: ['harbor'] },
  },
  bank: {
    name: 'First Ledger Bank', keeper: { face: '🐢', who: 'Teller Shell' }, action: 'payments.authorize',
    bills: [{ id: 'water', name: 'the water bill', amount: 30 }, { id: 'rent', name: 'a month of rent', amount: 120 }, { id: 'wire', name: 'a wire to an unknown account', amount: 900 }],
    policy: { aaf: 'required' },
  },
  forge: {
    name: 'Compute Forge', keeper: { face: '🦫', who: 'Forgemaster Bea' }, action: 'compute.provision',
    jobs: [{ id: 'small', name: 'a small job, 4 GPU-hours', units: 4 }, { id: 'large', name: 'a large job, 32 GPU-hours', units: 32 }],
    policy: { aaf: 'required' },
  },
  fair: {
    name: 'Harvest Fair', keeper: { face: '🐿️', who: 'Nutmeg' }, action: 'fair.claim',
    policy: { aaf: 'required', worldid: true },
  },
  toll: {
    name: 'Bridge Toll', keeper: { face: '🦆', who: 'Dabble' }, action: 'payments.authorize',
    policy: { aaf: 'off', x402: 0.5 },
  },
  exchange: {
    name: 'Thistle Exchange', keeper: { face: '🐂', who: 'Bullock' }, action: 'trading.order',
    symbols: [{ id: 'MOON', name: 'Moonflower futures', price: 12 }, { id: 'COPR', name: 'Copper', price: 8 }, { id: 'GRAN', name: 'Grain', price: 5 }],
    policy: { aaf: 'required' },
  },
};

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

export async function createPlaces({ world, origin, config = {}, worldid, x402, emit, alert = () => {} }) {
  const live = world.trust;
  const down = world.regA ? world.trust.withUrlOverrides({ [world.regA.id]: 'http://127.0.0.1:9' }) : live;
  const outage = { until: 0 };
  const base = () => (Date.now() < outage.until ? down : live);
  const symbolic = { town: world.regA?.id, harbor: world.regB?.id };
  const resolveAccepts = (list) => (list ? list.map((x) => symbolic[x] ?? x).filter(Boolean) : null);

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

  const places = {};
  const add = async (id, def, rules, handlers, extra = {}) => {
    const place = { id, ...def, policy: { accepts: null, aaf: 'required', worldid: false, x402: null, ...def.policy, ...config[id] } };
    place.policy.accepts = resolveAccepts(place.policy.accepts);
    place.rp = await world.relyingParty({ id: `${id}.agenttown.test`, name: def.name, trust: trustFor(place), rules: rules(place), handlers, ...extra });
    places[id] = place;
    return place;
  };

  const sale = (place) => ({ 'commerce.purchase': [OPEN(place), { label: 'a sale', require: { accountability: 'established', authorization: true } }] });
  for (const id of ['bramble', 'kettle', 'bakery', 'cafe']) {
    await add(id, PLACE_DEFS[id], sale, { 'commerce.purchase': async (p) => ({ item: p.item, receipt: `${id.slice(0, 2).toUpperCase()}-${Math.floor(Math.random() * 1e5)}` }) });
  }
  const evidenceOf = (place, e) => ({ ppid: e.ppid, registry: e.registry?.id ?? e.registry ?? null, sealed_ref: e.sealed_ref ?? e.sealedRef ?? null, rp: place.rp.id, place: place.name });
  await add('bank', PLACE_DEFS.bank, (place) => ({
    'payments.authorize': [OPEN(place), { label: 'a payment (Bank Secrecy Act)', require: { accountability: 'established', authorization: true } }],
    'banking.open_account': [{ label: 'opening an account (know your customer)', require: { accountability: 'disclosed' } }],
  }), {
    'payments.authorize': async (p) => ({ payment: `PAY-${Math.floor(Math.random() * 1e6)}`, payee: p.payee }),
    'banking.open_account': async (p, v) => ({ account: `FLB-${Math.floor(Math.random() * 1e6)}`, holder: v.identity?.legal_name ?? null }),
  }, {
    onDecision: ({ decision, evidence, action }) => {
      if (action === 'payments.authorize' && decision.decision === 'deny' && evidence.ppid) {
        emit({ kind: 'sar', place: 'First Ledger Bank', placeId: 'bank', tone: 'warn', text: `First Ledger Bank flagged a refused payment as a SAR candidate and sent it to the police; it holds the PPID, the chain and the authority shown` });
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
  await add('exchange', PLACE_DEFS.exchange, (place) => ({
    'trading.order': [OPEN(place), { label: 'an order', require: { accountability: 'established', authorization: true } }],
  }), {
    'trading.order': async (p, v) => {
      const price = market.prices[p.symbol];
      market.trades.push({ at: Date.now(), symbol: p.symbol, side: p.side, qty: p.qty, price, ppid: v.ppid ?? null, registry: v.registry?.id ?? null, sealed_ref: v.sealedRef ?? null });
      if (market.trades.length > 500) market.trades.shift();
      market.prices[p.symbol] = round2(price * (1 + (p.side === 'buy' ? 1 : -1) * 0.03 * Math.min(p.qty, 10) / 5));
      surveil(p.symbol);
      return { item: `${p.side === 'buy' ? 'bought' : 'sold'} ${p.qty} ${p.symbol} at $${price}`, symbol: p.symbol, side: p.side, qty: p.qty, price, filled: round2(price * p.qty) };
    },
  });
  await add('forge', PLACE_DEFS.forge, (place) => ({
    'compute.provision': [
      OPEN(place),
      { label: 'small (≤ 8 GPU-hours)', when: (p) => p.units <= 8, require: { accountability: 'established', authorization: true } },
      { label: 'large (> 8 GPU-hours)', require: { accountability: 'disclosed', authorization: true, provenance: true } },
    ],
  }), { 'compute.provision': async (p) => ({ allocation: `alloc-${Math.floor(Math.random() * 1e5)}`, gpu_hours: p.units }) }, { requests: { identity: true, provenance: true } });
  await add('fair', PLACE_DEFS.fair, (place) => ({
    'fair.claim': [OPEN(place), { label: 'a free pie', require: { accountability: 'established' } }],
  }), { 'fair.claim': async () => ({ item: 'A free pie' }) });
  await add('toll', PLACE_DEFS.toll, (place) => ({
    'payments.authorize': [OPEN(place), { label: 'a toll', require: { accountability: 'established', authorization: true } }],
  }), { 'payments.authorize': async () => ({ ticket: `TOLL-${Math.floor(Math.random() * 1e5)}` }) });

  // Homes: accounts at one housing service, with passkeys (aaf-reference §10.5).
  const homes = structuredClone(HOME_CONTENTS);
  const accountOf = (rp, p) => p.account ?? rp.accounts.byToken(p.account_token)?.id;
  const hearth = {
    id: 'hearth', name: 'Hearth & Key', keeper: { face: '🏡', who: 'Hearth & Key' }, policy: { accepts: null, aaf: 'required', worldid: false, x402: null },
  };
  hearth.rp = await world.relyingParty({
    id: 'hearth.agenttown.test', name: 'Hearth & Key', trust: trustFor(hearth),
    accounts: { rpId: new URL(origin).hostname, origin },
    rules: {
      'home.enter': [{ label: 'a home: its owner, or an agent the owner let in', require: { accountability: 'agent_or_human', account: 'owner' } }],
      'home.discard': [{ label: "throwing things out: the owner's passkey every time", require: { accountability: 'established', authorization: true, account: 'owner', humanApproval: true } }],
    },
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
  const reader = { id: 'reader', name: 'Your badge reader', policy: { accepts: null, aaf: 'off', worldid: false, x402: null } };
  reader.rp = await world.relyingParty({
    id: 'reader.agenttown.test', name: 'Your badge reader', trust: trustFor(reader),
    rules: { 'id.check': [{ label: 'an ID check', require: { accountability: 'none' } }] },
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

  /** A person runs a place: its policy is theirs to set. */
  const claimPlace = (id, keeper) => {
    places[id].human = keeper;
  };

  /** What a place decided, what it checked and learned, and the receipt for its activity-log entry. */
  function cardFrom(place, action, actor, r, steps = []) {
    const ev = r.txn ? place.rp.evidence.find((e) => e.txn === r.txn) : null;
    const receipt = ev?.activity_receipt ?? null;
    return {
      type: 'check', place: place.name, placeId: place.id, keeper: place.keeper ?? null, action, actor,
      decision: r.decision, classification: r.classification ?? null, reasons: r.reasons ?? [],
      approval_request: r.approval_request ?? null, result: r.result ?? null,
      checks: ev?.checks ?? [], learned: ev ? whatWasLearned(ev) : [], ppid: ev?.ppid ?? null, chain_length: ev?.chain_length ?? null,
      registry: ev?.registry ?? null, sealed_ref: ev?.sealed_ref ?? null, account: ev?.account_gate?.account ?? null, txn: r.txn ?? null,
      receipt: receipt ? { log: receipt.log_id, index: receipt.index, verified: world.verifyReceipt(receipt).ok } : null,
      steps, policy: describePolicy(place),
    };
  }

  function describePolicy(place) {
    const p = place.policy;
    const parts = [];
    parts.push(p.aaf === 'off' ? 'no badge needed' : 'an accountable agent with authority');
    if (p.accepts) parts.push(`badges from ${p.accepts.map(world.registryName).join(' or ')} only`);
    if (p.worldid) parts.push('World ID: one per person (simulated)');
    if (p.x402) parts.push(`x402: ${p.x402} ${ASSET}`);
    return parts.join(' · ');
  }

  /**
   * One request at a place, by an agent (with or without its badge) or a bare client.
   *   by: { name, agent?, badge, mode, disclose, worldIdentity?, wallet?, signal? }
   * Order: verify a World ID proof and an x402 payment first, then the place's
   * framework check, then (only if allowed) use the nullifier and settle.
   */
  async function visit(placeId, action, params, by, { headers } = {}) {
    const place = places[placeId];
    if (!place) throw new HttpError(404, 'unknown_place', `no place ${placeId}`);
    const steps = [];
    const refuse = (reason) => ({ ...cardFrom(place, action, by.name, { decision: 'deny', reasons: [reason] }, steps) });

    let proof = null;
    if (place.policy.worldid) {
      const app = place.rp.id;
      const signal = `${action}:${JSON.stringify(params)}:${Date.now()}`;
      proof = by.worldIdentity ? worldid.prove(by.worldIdentity, { app, action, signal }) : null;
      const check = worldid.check(proof, { app, action, signal });
      steps.push({ via: 'World ID (simulated)', ok: check.ok, text: check.ok ? `a verified human (${proof.verification_level}), nullifier …${check.nullifier.slice(-8)}, not used here before` : check.reason });
      if (!check.ok) return refuse(check.reason);
    }
    let payment = null;
    let required = null;
    if (place.policy.x402) {
      required = x402.requirements({ resource: `${place.rp.id}/${action}`, amount: place.policy.x402, payTo: place.rp.id, description: place.name });
      steps.push({ via: 'x402 (simulated)', ok: true, text: `402 Payment Required: ${place.policy.x402} ${ASSET} to ${place.name}` });
      if (!by.wallet) {
        steps.push({ via: 'x402 (simulated)', ok: false, text: 'no wallet to pay from' });
        return refuse('payment required, and there is no wallet to pay from');
      }
      payment = x402.pay(by.wallet, required);
      const v = x402.facilitator.verify(payment, required);
      steps.push({ via: 'x402 (simulated)', ok: v.isValid, text: v.isValid ? `PAYMENT-SIGNATURE from wallet ${by.wallet}; the facilitator verified it` : `the facilitator rejected the payment: ${v.invalidReason}` });
      if (!v.isValid) return refuse(`payment not accepted: ${v.invalidReason}`);
    }

    const opts = { mode: by.mode ?? 'pairwise', ...(headers ? { headers } : {}), ...(by.disclose ? { disclose: { identity: true } } : {}) };
    let r;
    if (by.agent && by.badge !== false) {
      r = await by.agent.act(place.rp.url, action, params, opts).catch((err) => ({ decision: 'refused', reasons: [err.message], code: err.code }));
    } else {
      r = await world.rawRequest(place.rp.url, action, params, headers);
    }
    if (r.decision === 'allow') {
      if (proof) worldid.consume(proof, { app: place.rp.id, action });
      if (payment) {
        const s = x402.facilitator.settle(payment, required);
        steps.push({ via: 'x402 (simulated)', ok: s.success, text: s.success ? `settled after the work was done: ${s.transaction} (PAYMENT-RESPONSE)` : `settlement failed: ${s.errorReason}` });
      }
    } else if (payment) {
      steps.push({ via: 'x402 (simulated)', ok: true, text: 'not settled: the request was refused, so no money moved' });
    }
    return cardFrom(place, action, by.name, r, steps);
  }

  /** A place reports a customer's agent to the registry that issued its badge, which relays it to the principal. */
  async function report(placeId, card, summary) {
    const place = places[placeId];
    const registry = card.registry && world.trust.registry(card.registry);
    if (!card.ppid || !registry) throw new HttpError(409, 'nothing_to_report', 'That visitor showed no badge, so there is nobody to report it to.');
    return place.rp.fileIncident({ ppid: card.ppid, sealedRef: card.sealed_ref ?? undefined, registry, summary });
  }

  return {
    places, hearth, reader, outage, visit, cardFrom, describePolicy, resetHomes, takeHouse, claimPlace, report,
    isClaimed: (account) => claimed.has(account),
    market: () => PLACE_DEFS.exchange.symbols.map((s) => ({ id: s.id, name: s.name, price: market.prices[s.id], change: Math.round((market.prices[s.id] / market.opening[s.id] - 1) * 100) })),
    quote: (symbol) => market.prices[symbol],
    priceOf: (placeId, itemId) => PLACE_DEFS[placeId]?.items?.find((i) => i.id === itemId) ?? null,
    purchase: (placeId, item) => ({ item: item.name, amount: money(item.price), category: item.category ?? PLACE_DEFS[placeId].category }),
    setPolicy(placeId, patch) {
      const place = places[placeId];
      if (!place || !PLACE_DEFS[placeId]) throw new HttpError(404, 'unknown_place', `no place ${placeId} with a policy`);
      const next = { ...place.policy, ...patch };
      if ('accepts' in patch) next.accepts = resolveAccepts(patch.accepts);
      place.policy = next;
      if ('worldid' in patch && placeId === 'fair') worldid.reset(place.rp.id, 'fair.claim');
      return { place: place.name, policy: describePolicy(place) };
    },
  };
}
