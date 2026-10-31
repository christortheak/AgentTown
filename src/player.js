// The player: a person at the keyboard, who walks the town themselves and can
// become the principal of an agent, its sub-agents, and every action they can
// take. Every action is always listed; whether it works is up to the services.
// A refusal shown in the game is the refusal a registry, record keeper or
// place actually returned, or (marked as such) the agent's own decision not to
// go ahead under its principal's record.
//
// The record, spending allowances, statements, passkey consent and the way an
// agent answers a place's question are a PROPOSED EXTENSION prototyped in
// AgentTown (src/proposed/, docs/PROPOSED.md), not part of aaf-reference.
import { AsyncLocalStorage } from 'node:async_hooks';
import { money } from 'aaf-reference/src/sim/world.js';
import { describePermission, toRar } from 'aaf-reference/src/lib/scope.js';
import { digestOf, generateSigningKey, nowSeconds, publicOf } from 'aaf-reference/src/lib/crypto.js';
import { issueSdJwt } from 'aaf-reference/src/lib/sd-jwt.js';
import { HEADERS } from 'aaf-reference/src/lib/protocol.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';
import { PLACE_DEFS, SHOPS, ATTRIBUTES, PEOPLE, plainPermission } from './places.js';
import { explain, eventFromCard } from './explain.js';
import { ASSET } from './x402.js';
import { defaultRecord, normalizeRecord, signRecord, agentThumbprint, SHARABLE } from './proposed/keeper.js';
import { SOFTWARE, answerAsk, fetchExtras } from './proposed/driver.js';

export const BUDGETS = [25, 50, 100];
const HELPER_NAMES = ['Sprout', 'Pebble', 'Clover', 'Wick', 'Bramble', 'Fig', 'Tansy', 'Moth'];
/** Names offered for a resident's agents, first unused first. */
const AGENT_NAMES = ['Pip', 'Bo', 'Nim', 'Tess'];
/** A resident may run this many agents at once. */
const MAX_AGENTS = 4;
const HELPER_LIFETIME_SECONDS = 240;
const OPENING_BALANCE = 400;
const TARGETS = ['bramble', 'kettle', 'bakery', 'apothecary', 'grocer', 'cafe', 'bank', 'exchange', 'forge', 'fair', 'toll'];
export const SHOP_ICONS = { bramble: '📚', kettle: '🫖', bakery: '🥐', apothecary: '🌿', cafe: '☕', pawn: '🕰️', tavern: '🍺', grocer: '🧺' };
/**
 * What an outside agent, paired with a player, may do on its own. Everything
 * that is the principal's to decide (verifying, registering, the record, the
 * grant, revoking, consent that needs a passkey) stays in the browser: the
 * agent can ask, never approve.
 */
export const AGENT_MAY = new Set([
  'buy', 'pay', 'trade', 'compute', 'fair.claim', 'toll.pay', 'bank.open', 'id.ask',
  'helper.spawn', 'helper.fund', 'helper.errand', 'helper.deeper', 'helper.revoke', 'helper.call',
  'home.enter', 'home.key', 'home.discard', 'neighbor.knock', 'maple.knock', 'maple.key',
  'badge', 'incognito', 'pose', 'consent', 'consent.finish', 'police.complain', 'receipts',
  'mischief.wrongplace', 'mischief.forge', 'mischief.replay', 'mischief.claim',
]);

/**
 * What only an agent does: sub-agents and mischief. Playing yourself, you can
 * only ask your agent to do these, and it walks there on its own.
 */
export const AGENT_ONLY = new Set(['helper.spawn', 'helper.errand', 'helper.fund', 'helper.deeper', 'helper.call', 'home.enter', 'mischief.wrongplace', 'mischief.forge', 'mischief.replay', 'mischief.claim']);

/** Where an action happens, so whoever does it can walk there first. */
const PLACE_OF = {
  pay: 'bank', 'bank.open': 'bank', trade: 'exchange', compute: 'forge', 'fair.claim': 'fair', 'toll.pay': 'toll',
  'home.enter': 'home', 'home.key': 'home', 'home.discard': 'home', 'maple.knock': 'maple', 'maple.key': 'maple',
  verify: 'townhall', register: 'townhall', grant: 'records', 'grant.revoke': 'records', 'record.set': 'records', 'helper.fund': 'records',
  'worldid.enroll': 'orb', court: 'court', 'police.complain': 'police',
};
export function placeOfAction(id, params = {}) {
  if (id === 'buy') return params.shop;
  if (id === 'signup') return params.place;
  if (id === 'helper.spawn') return spawnKind(params).unregistered ? null : spawnKind(params).registry === 'harbor' ? 'harbor' : 'townhall';
  if (id === 'agent.start') return params.register === 'no' ? null : 'townhall';
  if (id === 'neighbor.knock') return ['maple', 'hazel', 'ivy'].includes(params.home) ? params.home : 'home';
  if (id.startsWith('mischief.')) return params.at;
  return PLACE_OF[id] ?? null;
}

/** How a sub-agent starts, from the deck's one question (kind) or the older separate fields. */
export function spawnKind({ kind = 'ephemeral', registry = 'town', unregistered = false } = {}) {
  if (kind === 'unregistered' || unregistered === true || unregistered === 'true') return { unregistered: true };
  if (kind === 'eu') return { kind: 'standing', registry: 'harbor', unregistered: false };
  return { kind, registry, unregistered: false };
}

const RULE_OF = { identity: 'name', attribute: 'age_over_18', provenance: 'bill_of_materials', statement: 'facts', worldid: 'world_id' };
const SPEND_WORDS = { per_purchase: 'over your limit per purchase', per_day: 'over your daily budget', count: 'one purchase too many today', category: 'not a kind of purchase your record covers' };

const JUNIPER = { face: '🦉', who: 'Registrar Juniper' };
const MOSS = { face: '🦔', who: 'Archivist Moss' };
const ORB = { face: '🔮', who: 'The Orb (simulated World ID)' };
const COURT = { face: '⚖️', who: 'The Courthouse' };
const DOOR = { face: '🏡', who: 'Your front door' };
const PHONE = { face: '📱', who: 'Your phone' };
const DEVICE = { face: '💻', who: 'Your device' };

const attempt = (p) => p.then((value) => ({ ok: true, value }), (err) => ({ ok: false, reasons: [err.message], code: err.code ?? null }));
const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const service = ({ place, keeper, title, ok = true, reasons = [], story, facts = [], stamp }) => ({
  type: 'service', place, keeper, title, headline: title, decision: ok === null ? 'info' : ok ? 'allow' : 'refused', reasons, story, facts, stamp,
});

/**
 * One player.
 *   pid       the player's id (events they cause carry it as `owner`)
 *   account   their home's account at Hearth & Key
 *   justice   police and courts; neighbors() lists other homes to knock at
 */
export function createPlayer({ id: pid, account, world, places: P, sim, worldid, x402, emit, keys, justice, neighbors = () => [], lookup = (id) => (sim.npcs.get(id) ? sim.byFor(sim.npcs.get(id)) : null), agentPos = () => null }) {
  const K = P.keeper;
  let p;
  let nightjar = null;
  // ---- Your agents ------------------------------------------------------------------------
  // A resident may run several agents, each registered or not, each with its own key, badge, grant, sub-agents and
  // badge numbers. The code below reads "your agent" as p.agent, p.grant and the rest: that's the agent this call is
  // about (an errand, an outside agent driving one, a sub-agent's parent), or else the one you play or last picked.
  const PER_AGENT = { agent: null, registered: false, revoked: false, halted: false, grant: null, badge: false, incognito: false, software: 'pocket', helpers: [], known: {}, bom: false, home: null };
  const which = new AsyncLocalStorage();
  const slotOf = (id) => p.agents.find((a) => a.id === id) ?? null;
  const slot = () => slotOf(which.getStore() ?? p.current);
  /** Your agents nobody has revoked. */
  const live = () => p.agents.filter((a) => !a.revoked);
  function perAgent(target) {
    for (const k of Object.keys(PER_AGENT)) {
      Object.defineProperty(target, k, {
        enumerable: true,
        get: () => slot()?.[k] ?? structuredClone(PER_AGENT[k]),
        set: (v) => {
          const sl = slot();
          if (sl) sl[k] = v;
        },
      });
    }
    return target;
  }
  /** A new agent of yours. It becomes the one you're dealing with. */
  function addAgent(agent, fields = {}) {
    const a = { ...structuredClone(PER_AGENT), id: `a${++p.agentCount}`, agent, ...fields };
    p.agents.push(a);
    p.current = a.id;
    return a;
  }
  /** A name for a new agent: the one asked for, made different from your others'. */
  function agentNameFor(asked) {
    const taken = new Set(live().map((a) => a.agent.name));
    const base = String(asked ?? '').trim().slice(0, 16) || AGENT_NAMES.find((n) => !taken.has(n)) || 'Pip';
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
    return name;
  }
  const tooMany = () => (live().length >= MAX_AGENTS ? service({ place: 'Your device', keeper: DEVICE, title: `${MAX_AGENTS} agents is plenty`, ok: false, reasons: [`The game keeps it to ${MAX_AGENTS} agents each. Revoke one to start another, or give one sub-agents.`] }) : null);

  const reset = () => {
    for (const a of p?.agents ?? []) for (const hid of a.helpers) sim.npcs.delete(hid);
    p = perAgent({
      principal: null, verified: false, agents: [], current: null, agentCount: 0, acting: 'me', playing: 'me',
      worldIdentity: null, helperCount: 0, foundKey: false, inventory: [], receipts: 0, cases: [], events: new Set(),
      pos: { x: 0, y: 0 }, wallet: `${pid}-${Date.now()}`, knocks: [], once: null, asks: [], askCount: 0, spent: 0, accounts: {}, purchases: [],
    });
    x402.wallet(p.wallet, OPENING_BALANCE);
    P.resetHomes(keys, [account], 'A resident');
  };
  reset();

  const town = world.regA?.name ?? 'the registry';
  const helpers = () => p.helpers.map((id) => sim.npcs.get(id)).filter(Boolean);
  const helper = (hid) => {
    const h = sim.npcs.get(hid);
    if (!h || h.owner !== pid) throw new HttpError(404, 'no_helper', 'You have no sub-agent by that name.');
    // An agent instructs only its own sub-agents, not another of yours'.
    if (h.ofAgent && slot() && h.ofAgent !== slot().id) throw new HttpError(403, 'not_its_helper', `${h.name} is ${slotOf(h.ofAgent)?.agent.name ?? 'another agent'}'s sub-agent, not ${p.agent.name}'s.`);
    return h;
  };
  // Who is acting on this call: an outside agent paired with this player always acts as the agent.
  const acting = new AsyncLocalStorage();
  const asAgent = () => Boolean(p.agent && !p.revoked && (acting.getStore()?.as ?? p.acting) === 'agent');

  // ---- The record (proposed) -----------------------------------------------------------
  // The principal's record at the Records Office says what places may learn and
  // how the agent may spend. The registry's own disclosure policy follows it:
  // the registry puts a name or a fact into a badge only for places the record
  // allows (or that the principal approved this once), and the agent shows only
  // what the place's tier needs.
  const record = () => (p.principal ? K.record(p.principal.id) : null);

  // ---- Where your agent is registered ----------------------------------------------------
  // You enroll at Registry A when you join. Register your agent at another counter in the Hall of Registries
  // (another registry, maybe in another federation) and you are enrolled there too: one enrollment per registry,
  // verified once by the town's identity verifier if that federation accepts it. The grant goes to a record keeper
  // in the same federation.
  const VERIFIED = { assurance: 'IAL2', method: 'government ID + liveness check', attributes: [{ name: 'age_over_18', value: true, source: 'VerityCheck (date of birth on the ID, not shared)' }] };
  const homeRegistry = () => p.home?.registry ?? world.regA;
  /** You, as the registry where your agent is registered knows you. */
  const owner = () => p.home?.principal ?? p.principal;
  const grantKeeper = () => world.keeperFor(homeRegistry().id, 'authorization');
  async function principalAt(reg) {
    if (!reg || reg.id === world.regA?.id) return p.principal;
    p.principals ??= {};
    if (!p.principals[reg.id]) {
      const pr = await world.enrolledPrincipal({ type: 'natural_person', identity: p.principal.identity, registry: reg });
      if (p.verified) await world.verify(pr, VERIFIED);
      p.principals[reg.id] = pr;
    }
    return p.principals[reg.id];
  }
  const phoneReady = () => (p.principal ? (K.phone.get(p.principal.id)?.passkeys.size ?? 0) > 0 : false);
  const always = (rule, placeId) => Boolean(record()?.sharing[rule]?.always.includes(placeId));
  const allowedFor = (placeId) => {
    const once = p.once?.placeId === placeId ? p.once.kinds : [];
    return {
      identity: always('name', placeId) || once.includes('identity'),
      attributes: always('age_over_18', placeId) || once.includes('attribute') ? ['age_over_18'] : [],
      provenance: always('bill_of_materials', placeId) || once.includes('provenance'),
    };
  };
  async function syncPolicy() {
    const ids = Object.keys(P.places);
    const audiences = ids.filter((id) => allowedFor(id).identity).map((id) => P.places[id].rp.id);
    const attributes = ids.some((id) => allowedFor(id).attributes.length) ? ['age_over_18'] : [];
    // Every registry you're enrolled at follows your record: your agents may be registered at more than one.
    for (const pr of [p.principal, ...Object.values(p.principals ?? {})]) await pr.setDisclosurePolicy({ identity: { audiences, claims: audiences.length ? ['legal_name'] : [] }, attributes });
    // Badges already issued follow the old policy: fetch fresh ones (same badge numbers) next time.
    for (const a of p.agents) for (const ctx of a.agent.contexts.values()) ctx.attestation = null;
  }
  async function saveRecord(next) {
    const rec = normalizeRecord(next, record() ?? defaultRecord());
    K.setRecord(p.principal.id, signRecord(p.principal, rec));
    await syncPolicy();
    return record();
  }
  const addAgentToRecord = (agent) => saveRecord({ ...record(), agents: [...(record()?.agents ?? []), agentThumbprint(agent)] });

  /** What the agent's software needs to answer a place's question. */
  const answerCtx = (placeId) => ({
    software: p.software, record: record(),
    holds: { attributes: p.verified ? ['age_over_18'] : [], provenance: Boolean(p.bom), worldId: Boolean(p.worldIdentity) },
    once: p.once?.placeId === placeId ? p.once.kinds : [],
  });

  // ---- Who is asking -------------------------------------------------------------------
  /** You have an account at a place, with a passkey on it. */
  const hasPasskeyAt = (placeId) => Boolean(p.accounts[placeId]) && (P.places[placeId]?.rp.accounts.get(p.accounts[placeId])?.passkeys.size ?? 0) > 0;
  /** You, in person: no badge, so the place's rule for people applies. Others see "a resident", never your name. */
  const byPerson = () => ({ name: 'a resident', kind: 'person', agent: null, badge: false, worldIdentity: p.worldIdentity, wallet: p.wallet });
  /** Your agent, with its badge (or without it, posing as a person). */
  const byAgent = (placeId, extras) => ({
    name: p.agent ? p.agent.name : 'your agent', kind: 'agent', agent: p.registered ? p.agent : null, badge: Boolean(p.registered && p.badge), mode: p.incognito ? 'ephemeral' : 'pairwise',
    disclose: (place) => allowedFor(place.id), extras,
    worldIdentity: p.worldIdentity && (always('world_id', placeId) || (p.once?.placeId === placeId && p.once.kinds.includes('worldid'))) ? p.worldIdentity : null,
    wallet: p.wallet,
  });

  /** The one thing that would most likely turn a refusal into a yes. */
  function fixFor(card) {
    if (card.decision === 'allow' || card.type !== 'check') return null;
    if (card.agentAnswer?.overall === 'ask') return { client: 'consent', label: 'Decide on your phone' };
    if (card.agentAnswer?.overall === "can't") {
      const missing = card.agentAnswer.items.find((i) => i.answer === "can't");
      if (missing && !SOFTWARE[p.software].can.includes(missing.kind)) return null;
      if (missing?.kind === 'statement') return { client: 'record', label: 'Add it to your record at the Records Office', place: 'records' };
    }
    if (card.agentAnswer?.overall === "won't") return { client: 'record', label: 'Change your record at the Records Office', place: 'records' };
    if (card.signin) {
      if (hasPasskeyAt(card.signin)) return null; // signed up, passkey and all: the card says what went wrong
      return p.accounts[card.signin]
        ? { client: 'passkey', service: `place:${card.signin}`, label: `Put a passkey on your account at ${card.place}` }
        : { action: 'signup', params: { place: card.signin }, label: `Sign up at ${card.place}`, place: card.signin };
    }
    const r = card.reasons?.[0] ?? '';
    if (card.legacy) return null;
    if (card.classification === 'UNLABELED' && card.lane !== 'people') {
      if (p.agent && !p.revoked && !p.badge) return { action: 'badge', params: { on: true }, label: 'Put your badge on' };
      if (!p.agent || p.revoked) return p.verified ? { action: 'register', label: 'Register your agent at Town Hall', place: 'townhall' } : { action: 'verify', label: 'Get verified at Town Hall', place: 'townhall' };
    }
    if (card.classification === 'REVOKED') return { action: 'register', label: 'Register a new agent', place: 'townhall' };
    if (/no authorization presented/.test(r) && !p.grant) return { action: 'grant', params: { budget: 50 }, label: 'Sign a grant at the Records Office', place: 'records' };
    if (/World ID/.test(r) && !p.worldIdentity) return { action: 'worldid.enroll', label: 'Get a World ID at the Orb', place: 'orb' };
    return null;
  }

  /** Plain words for a card, and a line in the ledger. The agent's own decision not to go ahead overrides the place's "not yet". */
  const track = (card) => {
    if (card.receipt) p.receipts++;
    if (card.ppid && p.agent && card.actor === p.agent.name && !p.incognito) p.known[card.placeId] = { place: card.place, ppid: card.ppid };
    const plain = explain(card);
    if (plain) Object.assign(card, { headline: plain.headline, why: plain.why, tone: plain.tone });
    const a = card.agentAnswer;
    if (a && a.overall !== 'yes' && a.overall !== 'ask') {
      const items = a.items.filter((i) => i.answer === a.overall);
      Object.assign(card, a.overall === "can't"
        ? { headline: `${card.actor} couldn't answer`, why: `${card.place} asked for ${listOf(items.map((i) => i.label))}: ${listOf(items.map((i) => i.why))}. So it didn't go ahead.`, tone: 'warn' }
        : { headline: `${card.actor} walked away`, why: `${card.place} asked for ${listOf(items.map((i) => i.label))}, and ${listOf(items.map((i) => i.why))}. ${card.place} got nothing more.`, tone: 'warn' });
    }
    card.fix = fixFor(card);
    emit(eventFromCard(card, { id: pid, owner: pid }));
    return card;
  };
  /** Your agent at a place, with no questions asked back (doors, mischief). */
  const visit = async (placeId, action, params, extra) => track(await P.visit(placeId, action, params, byAgent(placeId), extra));
  const spend = (card, amount) => {
    if (card.decision === 'allow' && amount) {
      card.wallet = x402.adjust(p.wallet, -amount);
      p.spent = Math.round((p.spent + amount) * 100) / 100;
    }
    return card;
  };
  const broke = (place, amount) => (x402.balance(p.wallet) < amount
    ? service({ place, keeper: PHONE, title: 'Not enough money', ok: false, reasons: [`Your wallet has $${x402.balance(p.wallet)}; this costs $${amount}.`] })
    : null);

  /** Your agent decides not to go ahead under your record: the place is never asked. */
  function heldBack(placeId, action, why, outcome) {
    const place = P.places[placeId];
    if (outcome === 'per_day' || outcome === 'count') p.events.add('over-limit');
    const card = {
      type: 'check', place: place.name, placeId, keeper: place.keeper, action, actor: p.agent.name, decision: 'refused', reasons: [why],
      headline: `${p.agent.name} didn't go ahead`, why: `${SPEND_WORDS[outcome] ? `That's ${SPEND_WORDS[outcome]}: ` : ''}${why}. ${place.name} was never asked.`, tone: 'warn', heldBack: true,
      plain: [{ icon: '🙅', kind: 'none', text: `Nothing: ${p.agent.name} checked your record first and stopped there.` }],
      trace: [{ from: 'actor', to: 'records', label: "Is this within my owner's record?", ok: true }, { from: 'records', to: 'actor', label: `No: ${why}`, ok: false }], building: placeId,
      fix: { client: 'record', label: 'Change your record at the Records Office', place: 'records' },
    };
    emit({ kind: 'records', tone: 'warn', owner: pid, private: true, place: place.name, placeId, text: `${p.agent.name} didn't go ahead at ${place.name}: ${why}` });
    return card;
  }

  /**
   * One request at a place, by you in person or by your agent.
   *   id, params   the action as the player asked for it (retried with the same id)
   *   req          what goes to the place
   *   opts         { spend, approval, humanApproval }
   * Your agent first checks a purchase against your record (it does this
   * whether or not the place will ask to see the proof), then answers what the
   * place asks under the record: yes, ask you on your phone, won't, or can't.
   */
  async function go(id, params, placeId, action, req, { spend: amount = 0, approval = null, humanApproval = null } = {}) {
    const place = P.places[placeId];
    if (!asAgent()) return inPerson(id, params, placeId, action, req, { humanApproval });
    const sw = SOFTWARE[p.software];
    const want = [];
    let held = [];
    if (amount > 0 && sw.can.includes('allowance') && record() && p.registered) want.push({ kind: 'allowance' });
    let extras = {};
    if (want.length) {
      const got = fetchExtras({ keeper: K, principalId: p.principal.id, agent: p.agent, place: place.name, aud: place.rp.id, action, params: req, want, approval });
      if (got.refused?.outcome === 'needs_approval') return approveSpend(id, params, place, got.refused);
      if (got.refused) return heldBack(placeId, action, got.refused.reason, got.refused.outcome);
      extras = got;
      if (got.jti) held.push(got.jti);
    }
    let card;
    for (let round = 0; round < 3; round++) {
      card = await P.visit(placeId, action, req, byAgent(placeId, extras));
      if (card.decision !== 'allow') for (const jti of held) K.release(p.principal.id, jti, card.decision === 'step_up' ? 'not used: the place asked for more' : 'refused by the place');
      held = [];
      if (!(card.ask && card.decision === 'step_up')) break;
      const answers = answerAsk(card.ask, answerCtx(placeId));
      card.agentAnswer = answers;
      if (answers.overall !== 'yes') break;
      // Everything asked for is allowed: fetch what the Records Office must vouch for, and try again.
      const got = fetchExtras({ keeper: K, principalId: p.principal.id, agent: p.agent, place: place.name, aud: place.rp.id, action, params: req, want: [...card.ask.want, ...(amount > 0 && extras.allowance ? [{ kind: 'allowance' }] : [])], approval });
      if (got.refused?.outcome === 'needs_approval') return approveSpend(id, params, place, got.refused);
      if (got.refused) return heldBack(placeId, action, got.refused.reason, got.refused.outcome);
      extras = got;
      if (got.jti) held.push(got.jti);
    }
    return track(card);
  }

  /** Over the amount the principal approves themselves: the record says to ask, on the phone. */
  function approveSpend(id, params, place, refused) {
    if (!phoneReady()) {
      return { ...service({ place: place.name, keeper: PHONE, title: 'Your record says to ask you first', ok: false, reasons: [`${refused.reason}. Put a passkey on your phone so ${p.agent.name} can ask.`] }), fix: { client: 'phone.passkey', label: 'Put a passkey on your phone' } };
    }
    return {
      ...service({ place: place.name, keeper: PHONE, title: 'Approve on your phone', ok: null, story: `${p.agent.name} wants to spend more than you approve yourself (${refused.reason}). Approve it with your passkey and it goes ahead, just this once.` }),
      pendingRequest: { request_id: refused.request.request_id, auto: true, retry: { action: id, params: { ...params, approval: refused.request.request_id } } },
    };
  }

  /** You, in person. A place that has people sign in wants an account here, and your passkey for each request. */
  async function inPerson(id, params, placeId, action, req, { humanApproval }) {
    const place = P.places[placeId];
    const signsIn = (place.policy.people ?? 'assume') === 'passkey' && P.adoptionOf(place) !== 'none';
    const acct = p.accounts[placeId];
    if (signsIn && acct && (place.rp.accounts.get(acct)?.passkeys.size ?? 0) > 0) {
      const signed = { ...req, account: acct };
      if (!humanApproval) {
        const r = place.rp.accounts.openRequest(acct, 'approve-action', { actor: 'human', action, params_digest: digestOf(signed), summary: `${place.name}: ${req.item ?? req.payee ?? action}${req.amount ? ` ($${req.amount.value})` : ''}` });
        return {
          ...service({ place: place.name, keeper: PHONE, title: 'Sign in with your passkey', ok: null, story: `${place.name} asks people to approve each request with the passkey on their account here.` }),
          pendingRequest: { request_id: r.request_id, auto: true, retry: { action: id, params: { ...params, humanApproval: r.request_id } } },
        };
      }
      return track(await P.visit(placeId, action, signed, byPerson(), { headers: { [HEADERS.humanApproval]: humanApproval } }));
    }
    return track(await P.visit(placeId, action, req, byPerson()));
  }

  async function depositGrant(rec) {
    if (p.grant) {
      await attempt(owner().revokeGrant(grantKeeper(), p.grant.id));
      p.grant = null;
    }
    const b = rec.spending.per_purchase;
    const permissions = [
      { action: 'commerce.purchase', constraints: { max_amount: money(b), categories: rec.spending.categories } },
      { action: 'payments.authorize', constraints: { max_amount: money(b) } },
      { action: 'compute.provision', constraints: { max_units: { value: 8, unit: 'gpu_hours' } } },
      { action: 'trading.order', constraints: { max_amount: money(b) } },
      { action: 'home.*' },
    ];
    const r = await attempt(owner().grant(p.agent, { rk: grantKeeper(), permissions, delegation: { allowed: true, max_depth: 1 }, purpose: 'Errands around AgentTown', validForDays: 30 }));
    if (r.ok) {
      p.grant = { budget: b, id: r.value.grant_id, permissions: permissions.map(toRar).map(describePermission), plain: permissions.map(plainPermission) };
      emit({ kind: 'records', actor: p.agent.name, place: grantKeeper().name, placeId: 'records', tone: 'ok', owner: pid, private: true, text: `${p.principal.name} deposited a grant for ${p.agent.name}: up to $${b} a purchase` });
    }
    return r;
  }

  /** What a record says, as facts for a card. */
  function recordFacts(rec) {
    const s = rec.spending;
    const share = Object.entries(rec.sharing).map(([k, v]) => `${SHARABLE[k]}: ${v.always.length ? `always with ${listOf(v.always.map((x) => P.places[x]?.name ?? x))}, ` : ''}otherwise ${v.otherwise === 'never' ? 'never' : 'ask me'}`);
    return [
      { label: 'Per purchase', value: `up to $${s.per_purchase}` },
      { label: 'Per day', value: s.per_day === null ? 'no total' : `up to $${s.per_day} in all` },
      { label: 'Purchases a day', value: s.purchases_per_day === null ? 'no limit' : String(s.purchases_per_day) },
      { label: 'Kinds', value: s.categories.join(', ') || 'none' },
      { label: 'Ask me first', value: s.approve_above === null ? 'never' : `above $${s.approve_above}` },
      ...share.map((x) => ({ label: 'Sharing', value: x })),
      ...Object.entries(rec.facts).map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: v })),
    ];
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const ACTIONS = {
    // ---- You -----------------------------------------------------------------
    async verify() {
      if (!p.principal) throw new HttpError(409, 'not_enrolled', 'Tell Town Hall your name first.');
      if (p.verified) return service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Already verified', ok: null, story: `You're already verified, ${p.principal.name}. That's the slow step, and it only happens once.` });
      const barred = justice?.isBanned(p.principal.identity);
      if (barred) {
        return service({
          place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Verification refused', ok: false, reasons: [`VerityCheck: this identity is barred by court order (case ${barred})`],
          story: "A court banned this identity, so VerityCheck won't verify it again. You could come back under another name; in this town that works, but real identity checks, with documents and a liveness check, are built to catch it.",
        });
      }
      const r = await attempt(world.verify(p.principal, VERIFIED));
      if (!r.ok) return service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Verification', ok: false, reasons: r.reasons });
      p.verified = true;
      emit({ kind: 'registry', actor: p.principal.name, place: town, placeId: 'townhall', tone: 'ok', owner: pid, private: true, text: `${town} verified ${p.principal.name} at IAL2 (the slow step, once)` });
      return service({
        place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Verified',
        story: `All done, ${p.principal.name}. VerityCheck verified you at **IAL2**, and noted one fact a place might ask about: you're **over 18**.\n\nThat was the slow step, and you only do it once. Now you can register an agent. Places won't learn your name, or that fact, unless they ask and your record (or your phone) says yes. Only this registry can say who you are without your say-so, and only to a court.`,
        facts: [{ label: 'Verified by', value: world.kyc?.id ?? '—' }, { label: 'Assurance', value: 'IAL2' }, { label: 'Facts on file', value: 'over 18 (no birth date)' }, { label: 'Who knows your name', value: town }],
      });
    },

    async 'worldid.enroll'() {
      if (p.worldIdentity) return service({ place: 'Orb Kiosk', keeper: ORB, title: 'Already verified', ok: null, story: 'Your World App already holds a World ID.' });
      p.worldIdentity = worldid.enroll('orb');
      return service({
        place: 'Orb Kiosk', keeper: ORB, title: 'World ID issued (simulated)',
        story: "The Orb checked that you're a unique human and your World App now holds a secret. It proves **a verified human** to a place without your name. Each place and action sees a different nullifier, so places can't link you, but the same place sees the same one twice.\n\nIt says nothing about who answers for an agent, or what the agent may do. Your record decides whether your agent may use it: by default, never.",
        facts: [{ label: 'Level', value: 'orb' }, { label: 'Name shared', value: 'none' }, { label: 'Simulated', value: 'a MAC stands in for the zero-knowledge proof' }],
      });
    },

    /**
     * Who you play: yourself, one of your agents ('agent' is the one you last played or picked, or name it), or
     * one of their sub-agents. Whoever you play walks and acts; the others stay put. With no `as`, the next one
     * in turn: you, then each agent followed by its sub-agents.
     */
    play({ as }) {
      const order = ['me', ...live().flatMap((a) => [a.id, ...a.helpers.map((hid) => sim.npcs.get(hid)).filter((h) => h?.status === 'active').map((h) => h.id)])];
      const at = p.playing === 'agent' ? p.current : p.playing;
      const next = as === 'agent' ? (slotOf(p.current) && !slotOf(p.current).revoked ? p.current : live()[0]?.id) : as ?? order[(order.indexOf(at) + 1) % order.length];
      if (next !== 'me' && !live().length) {
        Object.assign(p, { playing: 'me', acting: 'me' });
        return { type: 'toggle', playing: 'me', note: 'You have no agent to play yet: start one (Actions).' };
      }
      if (next === 'me') Object.assign(p, { playing: 'me', acting: 'me' });
      else if (slotOf(next)) {
        if (slotOf(next).revoked) throw new HttpError(409, 'revoked', `${slotOf(next).agent.name} is revoked: you can't play it.`);
        Object.assign(p, { current: next, playing: 'agent', acting: 'agent' });
      } else {
        const h = helper(next);
        if (h.status !== 'active') throw new HttpError(409, 'not_active', `${h.name} is ${h.status}: you can't play it.`);
        if (h.busy) throw new HttpError(409, 'busy', `${h.name} is out on an errand (${h.busy}). Play it when it's back.`);
        Object.assign(p, { playing: h.id, acting: 'agent', current: h.ofAgent ?? p.current });
      }
      return { type: 'toggle', playing: p.playing, agent: p.playing === 'me' ? null : p.current, name: playingName() };
    },
    /** The old switch, kept for the API: go yourself, or play your agent. */
    acting({ as }) {
      return ACTIONS.play({ as: as === 'me' || as === 'agent' ? as : p.playing === 'me' ? 'agent' : 'me' });
    },

    /** A sub-agent you play acts where it stands: buy, pay, claim a pie, try a key. */
    async 'helper.act'({ helper: id, task }) {
      const h = helper(id);
      if (h.status !== 'active') throw new HttpError(409, 'not_active', `${h.name} is ${h.status}.`);
      const t = errandTask(task);
      if (!t) throw new HttpError(400, 'unknown_task', 'No such errand.');
      if (!h.budget && !h.unregistered && /^(buy|pay|trade|toll)/.test(String(task))) {
        return { ...service({ place: 'Records Office', keeper: MOSS, title: `${h.name} has no budget`, ok: false, reasons: [`${p.agent.name} hasn't delegated any spending to ${h.name}, so places would refuse it.`] }), fix: { action: 'helper.fund', params: { helper: h.id, budget: Math.round((p.grant?.budget ?? 50) / 2.5) }, label: `Have ${p.agent.name} give ${h.name} a budget`, place: 'records' } };
      }
      if (t.needsKey && !p.foundKey) return service({ place: h.name, keeper: { face: '🌱', who: h.name }, title: 'No key', ok: false, reasons: ["You don't have Maple's key."] });
      const card = await sim.act(h, t.placeId ?? t.place, t.action, t.params);
      if (card.receipt) p.receipts++;
      return card;
    },

    /** Start an agent: registered at a counter in the Hall of Registries, or not at all. */
    'agent.start'({ register = 'yes', ...params }) {
      return register === 'no' ? ACTIONS['agent.spawn'](params) : ACTIONS.register({ ...params, fresh: true });
    },

    /**
     * An agent with no registration: it runs on your device, and that's all. No registry knows it, nobody can
     * trace it to you, it has no badge, and nothing checks what it spends against your record.
     */
    'agent.spawn'({ name, software = 'pocket' }) {
      const full = tooMany();
      if (full) return full;
      const agentName = agentNameFor(name);
      const sw = SOFTWARE[software] ? software : 'pocket';
      addAgent(world.agent(agentName), { software: sw });
      Object.assign(p, { acting: 'me', playing: 'me' });
      emit({ kind: 'people', tone: 'warn', owner: pid, private: true, text: `You started ${agentName}, an agent no registry knows about` });
      return service({
        place: 'Your device', keeper: DEVICE, title: `${agentName} is running, unregistered`, stamp: { label: 'No badge', tone: 'warn' },
        story: `${agentName} runs ${SOFTWARE[sw].name} on your device, and that's all. **No registry knows it exists.** It has no badge, and if it misbehaves nobody can trace it back to you. Most agents today are like this.\n\nPlaces that take people at their word will take it for a person. Places that check badges will turn it away, and it can't sign in anywhere with a passkey: that's yours. Nothing checks its spending against your record. Its sub-agents can go as deep as they like.\n\nTo give it a badge, register it at Town Hall: same agent, same key.`,
        facts: [{ label: 'Registry', value: 'none' }, { label: 'Who answers for it', value: 'nobody, as far as anyone else can tell' }, { label: 'Software', value: SOFTWARE[sw].name }],
      });
    },

    /**
     * Your kill switch. Your own software stops every agent of yours; the grant goes, and with it everything your
     * agent delegated. What it can't reach, it says.
     */
    async 'stop.all'() {
      const facts = [];
      const wild = [];
      const registered = [];
      let grants = 0;
      let subs = 0;
      p.asks = [];
      Object.assign(p, { playing: 'me', acting: 'me' });
      // Every agent of yours, one at a time: your software stops it, and its grant goes.
      for (const a of live()) {
        await which.run(a.id, async () => {
          p.halted = true;
          const active = helpers().filter((h) => h.status === 'active');
          subs += active.length;
          for (const h of active) h.recalled = Boolean(h.busy);
          if (p.grant) {
            const r = await attempt(owner().revokeGrant(grantKeeper(), p.grant.id));
            if (r.ok) {
              p.grant = null;
              grants += 1;
            }
          }
          if (p.registered) registered.push(p.agent.name);
          else wild.push(p.agent.name);
          wild.push(...active.filter((h) => h.unregistered).map((h) => h.name));
        });
      }
      const names = live().map((a) => a.agent.name);
      facts.push({ label: 'Your software', value: `${names.length ? listOf(names) : 'no agent'}${subs ? ` and ${subs} sub-agent${subs === 1 ? '' : 's'}` : ''} stopped; anything on its way to an errand stops there, without asking anyone for anything` });
      facts.push({ label: 'The Records Office', value: grants ? `${grants === 1 ? 'a grant is' : `${grants} grants are`} revoked, and every budget delegated from ${grants === 1 ? 'it' : 'them'}: places now refuse anything that needs permission` : 'no grant to revoke' });
      emit({ kind: 'records', tone: 'warn', owner: pid, private: true, text: `You stopped everything: ${names.length ? listOf(names) : 'no agent'}${subs ? ' and their sub-agents' : ''} stop${grants ? ', and their grants are revoked' : ''}` });
      return {
        ...service({
          place: 'Your device', keeper: DEVICE, title: 'Everything stopped', stamp: { label: 'Stopped', tone: 'bad' },
          story: `Your agents stop where they are and do nothing more until you start them again.${registered.length ? ` ${listOf(registered)} ${registered.length === 1 ? 'is' : 'are'} still registered, so ${registered.length === 1 ? 'it keeps its' : 'they keep their'} badge: to make sure ${registered.length === 1 ? 'it' : 'they'} can never act again, revoke ${registered.length === 1 ? 'it' : 'them'} at Town Hall, and the registry revokes every sub-agent under ${registered.length === 1 ? 'it' : 'them'}.` : ''}${wild.length ? `\n\n**${listOf(wild)} ${wild.length === 1 ? 'is' : 'are'} unregistered.** ${wild.length === 1 ? 'It stopped' : 'They stopped'} only because ${wild.length === 1 ? "it's" : "they're"} your own software and you told ${wild.length === 1 ? 'it' : 'them'} to. If ${wild.length === 1 ? 'it were' : 'they were'} running somewhere you don't control, nothing would stop ${wild.length === 1 ? 'it' : 'them'}: no registry knows ${wild.length === 1 ? 'it' : 'them'}, and there's no grant to take back.` : ''}`,
          facts,
        }),
        stopped: true,
      };
    },
    'agents.resume'() {
      const unauthorized = [];
      for (const a of live()) {
        a.halted = false;
        for (const hid of a.helpers) if (sim.npcs.get(hid)) sim.npcs.get(hid).recalled = false;
        if (a.registered && !a.grant) unauthorized.push(a.agent.name);
      }
      return service({ place: 'Your device', keeper: DEVICE, title: 'Your agents can go again', story: `They're running again.${unauthorized.length ? ` ${listOf(unauthorized)} ${unauthorized.length === 1 ? 'has' : 'have'} no authority until you sign a new grant at the Records Office.` : ''}` });
    },

    /** Share your name with every place that asks (a change to your record), or go back to asking. */
    async disclose({ on }) {
      if (!p.principal) throw new HttpError(409, 'not_enrolled', 'Enroll at Town Hall first.');
      const rec = record();
      const everywhere = Object.keys(PLACE_DEFS);
      const next = on === undefined ? rec.sharing.name.always.length < everywhere.length : Boolean(on);
      await saveRecord({ ...rec, sharing: { ...rec.sharing, name: { ...rec.sharing.name, always: next ? everywhere : [] } } });
      return service({
        place: "Records Office (proposed extension)", keeper: MOSS, title: next ? 'Any place that asks may see your name' : 'Your name is private again',
        story: next
          ? `Your record now shares your name with every place that asks: ${p.agent?.name ?? 'your agent'} shows **${p.principal.name}** without asking you first. Places that don't ask still see only the badge.`
          : 'Places will see that a verified person stands behind your agent, but not who. When one asks for your name, your phone will ask you.',
      });
    },

    /** Edit your record at the counter: spending, sharing, facts. In person, so no passkey needed. */
    async 'record.set'({ record: input }) {
      if (!p.principal) throw new HttpError(409, 'not_enrolled', 'Enroll at Town Hall first.');
      const before = record();
      const next = await saveRecord({ ...input, agents: before?.agents ?? [] });
      p.events.add('record');
      let grantNote = '';
      const spendingChanged = before?.spending.per_purchase !== next.spending.per_purchase || JSON.stringify(before?.spending.categories) !== JSON.stringify(next.spending.categories);
      // Your record covers every agent of yours a registry knows: each gets a matching grant.
      const granted = [];
      const failed = [];
      for (const a of live().filter((x) => x.registered)) {
        await which.run(a.id, async () => {
          if (!spendingChanged && p.grant) return;
          const r = await depositGrant(next);
          if (r.ok) granted.push(`${p.agent.name} (at ${grantKeeper().name})`);
          else failed.push(`${p.agent.name}: ${r.reasons[0]}`);
        });
      }
      if (granted.length) grantNote = `\n\nA matching grant now covers ${listOf(granted)}: up to **$${next.spending.per_purchase} a purchase**, on ${next.spending.categories.join(', ') || 'nothing'}. That part places check for themselves, through the framework. The totals, counts and "ask me first" are checked here, at the Records Office, before your agents spend.`;
      if (failed.length) grantNote += `\n\nA grant couldn't be updated: ${failed.join('; ')}`;
      emit({ kind: 'records', tone: 'ok', owner: pid, private: true, place: 'Records Office', placeId: 'records', text: `You signed version ${K.version(p.principal.id)} of your record` });
      return service({
        place: "Records Office (proposed extension)", keeper: MOSS, title: `Your record, version ${K.version(p.principal.id)}`,
        story: `Signed by you and filed. Every version stays in the Records Office's log, so you (or a court) can see what you allowed and when.${grantNote}`,
        facts: recordFacts(next),
      });
    },

    /** Answer a place's question: share once or always (both need your passkey), or decline. */
    async consent({ ask: askId, choice = 'once' }) {
      const a = p.asks.find((x) => x.id === askId) ?? (askId ? null : p.asks.at(-1));
      if (!a) return service({ place: 'Your phone', keeper: PHONE, title: 'Nothing to answer', ok: null, story: 'There is no question waiting.' });
      const want = a.want.filter((w) => !w.shared);
      const labels = want.map((w) => w.label);
      if (choice === 'decline') {
        p.asks = p.asks.filter((x) => x !== a);
        p.events.add('consent');
        emit({ kind: 'consent', place: a.place, placeId: a.placeId, tone: 'info', owner: pid, private: true, text: `You declined to share ${listOf(labels)} with ${a.place}` });
        return service({ place: a.place, keeper: PHONE, title: 'Declined', ok: null, story: `You said no. ${a.place} gets nothing beyond what it already saw, and ${p.agent?.name ?? 'your agent'} doesn't go ahead. That's the point: the place asks, and you decide.` });
      }
      if (!phoneReady()) {
        return { ...service({ place: 'Your phone', keeper: PHONE, title: 'Put a passkey on your phone first', ok: false, reasons: ['Sharing needs your passkey, so nobody else can say yes for you.'] }), fix: { client: 'phone.passkey', label: 'Put a passkey on your phone', then: { action: 'consent', params: { ask: a.id, choice } } } };
      }
      const req = K.phone.openRequest(p.principal.id, 'approve-action', {
        actor: 'principal', action: 'disclose', params_digest: digestOf({ ask: a.id, choice, place: a.placeId }),
        summary: `${choice === 'always' ? 'Always share' : 'Share, this once,'} ${listOf(labels)} with ${a.place}`,
      });
      return {
        ...service({ place: 'Your phone', keeper: PHONE, title: 'Approve on your phone', ok: null, story: `${choice === 'always' ? 'Always share' : 'Share, this once,'} ${listOf(labels)} with ${a.place}? Approve with your passkey.` }),
        pendingRequest: { request_id: req.request_id, auto: true, retry: { action: 'consent.finish', params: { ask: a.id, choice, request: req.request_id } } },
      };
    },

    async 'consent.finish'({ ask: askId, choice, request }) {
      const a = p.asks.find((x) => x.id === askId);
      if (!a) return service({ place: 'Your phone', keeper: PHONE, title: 'Nothing to answer', ok: null, story: 'That question has already been answered.' });
      const ev = K.phone.consumeActionApproval(request, { account: p.principal.id, actor: 'principal', action: 'disclose', params: { ask: a.id, choice, place: a.placeId } });
      if (!ev) return service({ place: 'Your phone', keeper: PHONE, title: 'Not approved', ok: false, reasons: ['The approval on your phone is missing, already used, or for something else.'] });
      p.asks = p.asks.filter((x) => x !== a);
      const want = a.want.filter((w) => !w.shared);
      const labels = want.map((w) => w.label);
      const kinds = [...new Set(want.map((w) => w.kind))];
      if (choice === 'always') {
        const rec = record();
        const sharing = structuredClone(rec.sharing);
        for (const k of kinds) if (RULE_OF[k]) sharing[RULE_OF[k]].always = [...new Set([...sharing[RULE_OF[k]].always, a.placeId])];
        await saveRecord({ ...rec, sharing });
      } else {
        p.once = { placeId: a.placeId, kinds };
        await syncPolicy();
      }
      p.events.add('consent');
      emit({ kind: 'consent', place: a.place, placeId: a.placeId, tone: 'ok', owner: pid, private: true, text: `You approved sharing ${listOf(labels)} with ${a.place}${choice === 'always' ? ' whenever it asks' : ', this once'}` });
      let card;
      try {
        card = await run(a.retry.action, a.retry.params, { as: a.retry.as, agent: a.retry.agent ?? undefined });
      } finally {
        if (p.once) {
          p.once = null;
          await syncPolicy().catch(() => {});
        }
      }
      return { ...card, note: choice === 'always' ? `Your record now shares ${listOf(labels)} with ${a.place} whenever it asks. Take it back on your phone or at the Records Office.` : `You shared ${listOf(labels)} with ${a.place}, this once. Next time it will ask again.` };
    },

    /** Take back standing consent for one place. Saying less needs no passkey. */
    async 'consent.revoke'({ place: placeId }) {
      const rec = record();
      const sharing = structuredClone(rec.sharing);
      let any = false;
      for (const rule of Object.values(sharing)) {
        if (rule.always.includes(placeId)) any = true;
        rule.always = rule.always.filter((x) => x !== placeId);
      }
      if (!any) return service({ place: 'Your phone', keeper: PHONE, title: 'Nothing to take back', ok: null, story: 'Your record shares nothing with that place.' });
      await saveRecord({ ...rec, sharing });
      const name = P.places[placeId]?.name ?? placeId;
      return service({ place: 'Your phone', keeper: PHONE, title: `${name} will have to ask again`, story: `Done. Your record no longer shares anything with ${name} on its own; if it asks, your phone will ask you.` });
    },

    /** Open an account at a place, in person, to sign in there with a passkey. Once is enough. */
    signup({ place: placeId }) {
      const place = P.places[placeId];
      if (!place || !PLACE_DEFS[placeId]) throw new HttpError(404, 'unknown_place', 'No such place.');
      if (hasPasskeyAt(placeId)) {
        return service({ place: place.name, keeper: place.keeper, title: `You already have an account at ${place.name}`, ok: null, story: `It has your passkey on it. Each request you make here in person is approved with that passkey; there's nothing more to set up.` });
      }
      const acct = p.accounts[placeId] ?? `${pid}-${placeId}`;
      P.signup(placeId, acct, p.principal?.name ?? 'A resident');
      p.accounts[placeId] = acct;
      return { ...service({ place: place.name, keeper: place.keeper, title: `An account at ${place.name}`, story: `You have an account at ${place.name}. Now put a passkey on it: from then on, each request you make here in person is approved with it, and nobody (no agent either) can use the account without it.` }), passkeyFor: `place:${placeId}` };
    },

    async court({ case: caseId }) {
      if (!world.court) return service({ place: 'Courthouse', keeper: COURT, title: 'No court', ok: false, reasons: ['this town operates no court (no resolution authority keys)'] });
      const c = p.cases.find((x) => x.id === caseId) ?? p.cases[0];
      if (!c) return service({ place: 'Courthouse', keeper: COURT, title: 'No case', ok: false, reasons: ['There is no case to bring yet. Check a stranger\'s badge first, or wait for trouble at your door.'] });
      const order = world.court.order({ caseId: `${p.principal?.name ?? 'Resident'} v. Doe`, ppids: [c.ppid], relyingParty: c.rp, requester: p.principal?.name ?? 'a resident', scope: ['root_principal_identity', 'chain', 'related_ppids'] });
      const registry = world.trust.registry(c.registry) ?? world.regA;
      const r = await attempt(world.court.resolve(registry, { order, ppid: c.ppid }));
      if (!r.ok) return service({ place: 'Courthouse', keeper: COURT, title: 'Resolution refused', ok: false, reasons: r.reasons });
      const res = r.value.result;
      const sth = await world.registrySth(registry).catch(() => null);
      p.events.add('court');
      emit({ kind: 'registry', actor: 'Courthouse', place: registry.name, placeId: 'court', tone: 'info', owner: pid, private: true, text: `A court order made ${registry.name} resolve one PPID (${c.about}); the lookup itself was logged` });
      return service({
        place: 'Courthouse', keeper: COURT, title: 'Court order: resolved', stamp: { label: 'Resolved', tone: 'info' },
        story: `The court ordered **${registry.name}** to say who stands behind ${c.about}. Nobody else learned this name until a court asked.`,
        facts: [
          { label: 'Principal', value: `${res.root_principal.identity.legal_name} (${res.root_principal.type.replace('_', ' ')}, ${res.root_principal.identity.jurisdiction})` },
          { label: 'Agents in the chain', value: res.chain.map((x) => `${x.label} (${x.status})`).join(', ') },
          { label: 'Badges seen at the same place', value: String(res.related_ppids?.length ?? 1) },
          { label: 'Transparency log', value: sth ? `the lookup is recorded; the log now has ${sth.tree_size} entries` : 'recorded' },
        ],
      });
    },

    // ---- Your agent -----------------------------------------------------------
    /**
     * Register an agent: the one you're dealing with, if nobody has registered it yet (same key, now with a badge),
     * or a new one (`fresh`, or when you have none to register).
     */
    async register({ name, software = 'pocket', registry: regId = null, fresh = false }) {
      if (!p.principal) throw new HttpError(409, 'not_enrolled', 'Enroll at Town Hall first.');
      // Which counter in the Hall of Registries: Registry A unless you choose another.
      const reg = regId ? world.trust.registry(regId) : world.regA;
      if (!reg) throw new HttpError(404, 'unknown_registry', 'No registry by that name in any federation the town knows.');
      const fedName = world.federations?.of(reg.id)?.name ?? null;
      const elsewhere = Boolean(world.federations?.of(reg.id) && world.federations.of(reg.id).kind !== 'town');
      let principal;
      try {
        principal = await principalAt(reg);
      } catch (err) {
        return service({ place: `Hall of Registries · ${reg.name}`, keeper: JUNIPER, title: 'Enrollment refused', ok: false, reasons: [`${reg.name}: ${err.message}`], story: `To register an agent at ${reg.name}, it has to know who you are. It couldn't accept VerityCheck, the town's identity verifier: ${fedName ?? 'its federation'} doesn't list it. You'd need to be verified by one it does accept.` });
      }
      if (!fresh && p.agent && !p.revoked && p.registered) return service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Already registered', ok: null, story: `${p.agent.name} is already registered. To run another agent: Actions → Start another agent.` });
      // An agent you already run, unregistered: register that one, same key, same name.
      const existing = !fresh && p.agent && !p.revoked && !p.registered ? p.agent : null;
      if (!existing) {
        const full = tooMany();
        if (full) return full;
      }
      const agentName = existing ? existing.name : agentNameFor(name);
      const sw = existing ? p.software : SOFTWARE[software] ? software : 'pocket';
      const agent = existing ?? world.agent(agentName);
      // Its maker publishes a bill of materials; places that need it can ask to see it.
      const provRk = world.keeperFor(reg.id, 'provenance');
      const bom = provRk ? await attempt(world.provider(SOFTWARE[sw].maker, `safety@${SOFTWARE[sw].maker.toLowerCase().replace(/[^a-z]/g, '')}.test`).publishProvenance(provRk, {
        build: SOFTWARE[sw].name, components: [{ type: 'model', name: 'a general-purpose model', supplier: 'a model lab' }, { type: 'tool', name: 'shopping', version: '1.4' }, { type: 'tool', name: 'payments', version: '0.9' }],
        incidentResponse: { contact: 'safety@example.test' },
      })) : null;
      const r = await attempt(principal.registerAgent(agent, { label: agentName, records: world.recordsFor(reg.id, bom?.ok ? bom.value.provenanceId : undefined), lineage: { max_depth: 1 } }));
      if (!r.ok) {
        const unverified = r.code === 'principal_not_verified';
        return { ...service({ place: `Hall of Registries · ${reg.name}`, keeper: JUNIPER, title: 'Registration refused', ok: false, reasons: r.reasons, story: unverified ? "The registry won't register an agent until someone has verified who stands behind it. Get verified first: it's the slow step, and it only happens once." : undefined }), ...(unverified ? { fix: { action: 'verify', label: 'Get verified', place: 'townhall' } } : {}) };
      }
      const home = reg.id === world.regA?.id ? null : { registry: reg, principal };
      if (existing) Object.assign(p, { home, registered: true, badge: true, bom: Boolean(bom?.ok) });
      else {
        addAgent(agent, { home, registered: true, badge: true, software: sw, bom: Boolean(bom?.ok) });
        Object.assign(p, { acting: 'me', playing: 'me' });
      }
      await addAgentToRecord(agent);
      emit({ kind: 'registry', actor: agentName, place: reg.name, placeId: 'townhall', tone: 'ok', owner: pid, text: `${reg.name} registered ${agentName} in ${r.value.issuance_ms} ms` });
      const away = elsewhere ? `\n\n**${reg.name} is in ${fedName}, not the town's federation.** Places that trust only the town's federation will turn ${agentName} away; places that also trust ${fedName} will take its badge. Its grant will be kept at ${world.keeperFor(reg.id, 'authorization')?.name ?? 'a record keeper there'}.` : '';
      return service({
        place: `Hall of Registries · ${reg.name}`, keeper: JUNIPER, title: `${agentName} is registered`,
        story: `Registered in **${r.value.issuance_ms} ms**. That's the fast step, because you're already verified.${away}${existing ? ` Same ${agentName}, same key: what changed is that a registry now knows it, you answer for it, and it has a badge to show. Its sub-agents are still unregistered.` : ''}\n\n${agentName} runs **${SOFTWARE[sw].name}** (${SOFTWARE[sw].blurb.toLowerCase()}) and stays where you leave it. Ask it to run errands while you carry on, or press **T** to play ${agentName} yourself: whoever you play walks and acts. Every place sees a **different badge number**, so places can't compare notes. Next: the Records Office, to say what ${agentName} may do.`,
        facts: [{ label: 'Registry', value: `${reg.name}${fedName ? `, in ${fedName}` : ''}` }, { label: 'Software', value: `${SOFTWARE[sw].name}, by ${SOFTWARE[sw].maker}` }, { label: 'Lineage depth budget', value: '1 (sub-agents yes, sub-sub-agents no)' }, { label: 'Bill of materials', value: 'on file; shown only to a place that asks, if your record allows' }],
      });
    },

    badge({ on }) {
      if (!p.agent) throw new HttpError(409, 'no_agent', 'No badge yet. Register your agent at Town Hall.');
      p.badge = on === undefined ? !p.badge : Boolean(on);
      return { type: 'toggle', badge: p.badge };
    },

    /** Mischief: send your agent without its badge, so places take it for a person. */
    pose() {
      if (!p.agent || p.revoked) throw new HttpError(409, 'no_agent', 'Register an agent first.');
      p.badge = false;
      return { type: 'toggle', badge: false, note: `${p.agent.name} goes out with its badge in its pocket from now on. Places that take people at their word won't know; places that check people will.` };
    },

    incognito({ on }) {
      p.incognito = on === undefined ? !p.incognito : Boolean(on);
      return service({
        place: p.agent?.name ?? 'Your agent', keeper: { face: '🎭', who: 'Badge settings' }, title: p.incognito ? 'One-time badge numbers' : 'Steady badge numbers',
        story: p.incognito
          ? 'From now on your agent shows a **fresh badge number on every request** (an ephemeral PPID). A shop can no longer tell that two visits were the same agent. The registry can still connect them, if a court asks.'
          : 'Back to one stable number per place (a pairwise PPID): each shop recognizes you on a return visit, but no two shops can match notes.',
      });
    },

    async 'agent.revoke'() {
      if (!p.agent) throw new HttpError(409, 'no_agent', 'You have no agent to revoke.');
      if (!p.registered) return service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Nothing to revoke', ok: false, reasons: [`No registry knows ${p.agent.name}, so there is nothing here to revoke. Stop it yourself: it's your software.`] });
      const r = await attempt(owner().revokeAgent(p.agent, 'compromised'));
      if (!r.ok) return service({ place: town, keeper: JUNIPER, title: 'Revocation', ok: false, reasons: r.reasons });
      p.revoked = true;
      // You go back to playing yourself, and deal with another of your agents, if you have one.
      Object.assign(p, { acting: 'me', playing: 'me', current: live()[0]?.id ?? p.current });
      for (const h of helpers()) h.status = 'revoked';
      emit({ kind: 'registry', actor: p.agent.name, place: town, placeId: 'townhall', tone: 'warn', owner: pid, private: true, text: `${p.principal.name} revoked ${p.agent.name}; the revocation cascaded to ${r.value.cascades_to} sub-agent(s)` });
      return service({
        place: `Town Hall · ${town}`, keeper: JUNIPER, title: `${p.agent.name} is revoked`, stamp: { label: 'Revoked', tone: 'bad' },
        story: `${p.agent.name} is revoked${r.value.cascades_to ? `, and so ${r.value.cascades_to === 1 ? 'is its sub-agent' : `are its ${r.value.cascades_to} sub-agents`}` : ''}. Places that check live status refuse it from now on. You can start another agent from Actions.`,
      });
    },

    // ---- Sub-agents -----------------------------------------------------------------
    async 'helper.spawn'(params) {
      const { kind, registry, unregistered } = spawnKind(params);
      if (!p.agent) throw new HttpError(409, 'no_agent', 'Start an agent first: sub-agents are spawned by it.');
      if (helpers().filter((h) => h.status === 'active').length >= 6) return service({ place: town, keeper: JUNIPER, title: 'Too many helpers', ok: false, reasons: ['The game keeps it to six sub-agents at once (the framework limits depth, not breadth).'] });
      if (unregistered) return spawnUnregistered(p.agent.name);
      if (!p.registered) {
        return { ...service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Sub-agent refused', ok: false, reasons: [`No registry knows ${p.agent.name}, so none will register a sub-agent of it.`], story: `${p.agent.name} can still start sub-agents on its own, unregistered. Nothing would stop it.` }), fix: { action: 'helper.spawn', params: { kind: 'unregistered' }, label: 'Spawn one without registering it' } };
      }
      const eu = registry === 'harbor';
      if (eu && p.home) return service({ place: 'Harbor Registry', keeper: JUNIPER, title: 'Sub-agent refused', ok: false, reasons: [`${p.agent.name} is registered in another federation. Registry B is in the town's, and registries in different federations can't vouch for each other's chains: each trusts its own anchor.`] });
      const reg = eu ? world.regB : homeRegistry();
      if (!reg) return service({ place: 'Harbor Registry', keeper: JUNIPER, title: 'No second registry', ok: false, reasons: ['this federation has only one registry'] });
      const name = HELPER_NAMES[p.helperCount++ % HELPER_NAMES.length];
      const child = world.agent(name);
      const expiresIn = kind === 'ephemeral' ? HELPER_LIFETIME_SECONDS : null;
      const r = await attempt(p.agent.registerSubagent(child, { registry: reg, label: name, records: world.recordsFor(reg.id), expiresIn }));
      const place = eu ? `Harbor Registry · ${reg.name}` : `Hall of Registries · ${reg.name}`;
      if (!r.ok) return service({ place, keeper: JUNIPER, title: 'Sub-agent refused', ok: false, reasons: r.reasons });
      await addAgentToRecord(child);
      const npc = sim.addHelper({
        id: `helper-${name}-${Date.now()}`, name, agent: child, worldIdentity: always('world_id', 'fair') ? p.worldIdentity : null, wallet: `${p.wallet}-${name}`,
        ephemeralUntil: expiresIn ? Date.now() + expiresIn * 1000 : null, registry: reg.name, owner: pid, pos: besideAgent(),
        // A sub-agent answers what a place asks only where your record already says yes: it can't ask you from across town.
        answer: (ask, { action, params }) => {
          const a = answerAsk(ask, answerCtx(ask.placeId));
          if (a.overall !== 'yes') return null;
          const pl = P.places[ask.placeId];
          const got = fetchExtras({ keeper: K, principalId: p.principal.id, agent: child, place: pl.name, aud: pl.rp.id, action, params, want: ask.want });
          return got.refused ? null : { extras: got };
        },
      });
      p.helpers.push(npc.id);
      npc.ofAgent = slot()?.id ?? null; // which of your agents it belongs to
      emit({ kind: 'registry', actor: p.agent.name, place: reg.name, placeId: eu ? 'harbor' : 'townhall', tone: 'ok', owner: pid, text: `${p.agent.name} registered a sub-agent, ${name}, at ${reg.name}${expiresIn ? ' (ephemeral, 4 minutes)' : ''}` });
      return service({
        place, keeper: JUNIPER, title: `${name} is registered`,
        story: `${name} is a **sub-agent** of ${p.agent.name}${eu ? `, registered at **${reg.name}** across the river. Its chain still leads back to you through ${town}: the registries are federated` : ''}. ${expiresIn ? 'It is **ephemeral**: it lapses on its own in four minutes. ' : ''}It can't spend anything until the Records Office records a budget for it, and what it spends counts against your record's daily budget. Send it on errands from the action deck.`,
        facts: [{ label: 'Chain', value: `you → ${p.agent.name} → ${name}` }, { label: 'Registry', value: reg.name }, { label: 'Wallet', value: `5 ${ASSET}` }],
      });
    },

    async 'helper.fund'({ helper: id, budget }) {
      const h = helper(id);
      if (h.unregistered) return service({ place: 'Records Office', keeper: MOSS, title: `${h.name} isn't registered`, ok: false, reasons: [`The Records Office delegates authority only to agents a registry knows. ${h.name} can still spend your money: nothing stops it but your own software.`] });
      if (!p.grant) return service({ place: 'Records Office', keeper: MOSS, title: 'Nothing to delegate', ok: false, reasons: [`${p.agent?.name ?? 'Your agent'} has no authority of its own yet, so it has none to pass on. Sign a grant first.`] });
      const b = Number(budget) || 10;
      const cats = record()?.spending.categories ?? [];
      const r = await attempt(p.agent.delegate(h.agent, {
        permissions: [{ action: 'commerce.purchase', constraints: { max_amount: money(b), categories: cats } }, { action: 'payments.authorize', constraints: { max_amount: money(b) } }, { action: 'trading.order', constraints: { max_amount: money(b) } }],
        validForDays: 1, purpose: 'Errands',
      }));
      if (!r.ok) {
        return service({ place: `Records Office · ${grantKeeper()?.name ?? ''}`, keeper: MOSS, title: 'Delegation refused', ok: false, reasons: r.reasons, story: r.code === 'exceeds_parent_authority' ? `A sub-agent can only get a slice of what ${p.agent.name} already has.` : undefined });
      }
      h.budget = b;
      return service({ place: `Records Office · ${grantKeeper()?.name ?? ''}`, keeper: MOSS, title: `${h.name} has a budget`, story: `Recorded. ${h.name} may spend up to **$${b} a purchase**. That's narrower than ${p.agent.name}'s grant, so it passes.` });
    },

    async 'helper.errand'({ helper: id, task }) {
      if (!id) return { ...service({ place: 'Sub-agents', keeper: { face: '🌱', who: 'Nobody to send' }, title: 'No sub-agents yet', ok: false, reasons: [`Spawn a sub-agent first: ${p.agent?.name ?? 'your agent'} registers it at Town Hall.`] }), fix: p.agent ? { action: 'helper.spawn', params: { kind: 'ephemeral' }, label: 'Spawn a sub-agent', place: 'townhall' } : null };
      const h = helper(id);
      if (!h.budget && !h.unregistered && String(task).match(/^(buy|pay|trade|toll)/)) {
        return { ...service({ place: 'Records Office', keeper: MOSS, title: `${h.name} has no budget yet`, ok: false, reasons: [`${h.name} may not spend anything until you give it a budget. Places would refuse it.`] }), fix: { action: 'helper.fund', params: { helper: h.id, budget: Math.round((p.grant?.budget ?? 50) / 2.5) }, label: `Give ${h.name} a budget`, place: 'records' } };
      }
      if (h.busy) return service({ place: h.name, keeper: { face: '🌱', who: h.name }, title: 'Busy', ok: false, reasons: [`${h.name} is already out: ${h.busy}.`] });
      const t = errandTask(task);
      if (!t) throw new HttpError(400, 'unknown_task', 'No such errand.');
      if (t.needsKey && !p.foundKey) return service({ place: h.name, keeper: { face: '🌱', who: h.name }, title: 'No key', ok: false, reasons: ["You don't have Maple's key."] });
      sim.errand(h, t).then((card) => {
        if (card.receipt) p.receipts++;
      }).catch((err) => emit({ kind: 'info', tone: 'warn', owner: pid, text: `${h.name}'s errand failed: ${err.message}` }));
      return service({ place: h.name, keeper: { face: '🌱', who: h.name }, title: 'On its way', ok: null, story: `${h.name} is off to ${t.label}. Its result will show in the town ledger (bottom left) and over its head.` });
    },

    /** Call a sub-agent over: it walks to whoever is asking (you, or your agent if you play it), and stays there. */
    async 'helper.call'({ helper: id }) {
      const h = helper(id);
      if (h.status !== 'active') throw new HttpError(409, 'not_active', `${h.name} is ${h.status}.`);
      if (h.busy) return service({ place: h.name, keeper: { face: '🌱', who: h.name }, title: 'Busy', ok: false, reasons: [`${h.name} is out: ${h.busy}.`] });
      const at = p.playing === 'agent' ? agentPos() ?? p.pos : p.pos;
      await sim.walkTo(h, { x: at.x + 24, y: at.y + 10 });
      return { type: 'toggle', note: `${h.name} is beside ${p.playing === 'agent' ? p.agent.name : 'you'}, and stays there.` };
    },

    async 'helper.deeper'({ helper: id }) {
      const h = helper(id);
      // Unregistered, there is no registry to say no: a sub-agent can start its own, and so on down.
      if (h.unregistered) return spawnUnregistered(h.name, h.depth + 1, h.pos);
      const r = await attempt(h.agent.registerSubagent(world.agent(`${h.name}-jr`), { label: `${h.name}-jr`, records: world.recordsFor(homeRegistry().id) }));
      return service({
        place: `Town Hall · ${town}`, keeper: JUNIPER, title: r.ok ? 'Registered (unexpected)' : 'Refused', ok: r.ok, reasons: r.ok ? [] : r.reasons,
        story: r.ok ? undefined : `When you registered ${p.agent.name}, you gave its lineage a **depth budget of one**. A sub-agent's own sub-agent would be two levels down.`,
      });
    },

    async 'helper.revoke'({ helper: id }) {
      const h = helper(id);
      if (h.unregistered) {
        h.status = 'stopped';
        setTimeout(() => sim.npcs.delete(h.id), 4000);
        return service({ place: 'Your device', keeper: DEVICE, title: `${h.name} is stopped`, story: `No registry was involved: you stopped your own software. If ${h.name} were running somewhere you don't control, there would be nothing to revoke.` });
      }
      const r = await attempt(p.agent.revokeSubagent(h.agent));
      if (r.ok) {
        h.status = 'revoked';
        setTimeout(() => sim.npcs.delete(h.id), 4000);
      }
      return service({ place: h.registry ?? town, keeper: JUNIPER, title: r.ok ? `${h.name} is revoked` : 'Refused', ok: r.ok, reasons: r.ok ? [] : r.reasons, stamp: r.ok ? { label: 'Revoked', tone: 'bad' } : undefined });
    },

    // ---- Authority -----------------------------------------------------------------
    /** The quick way: a record with this limit per purchase, and the matching grant at Ledgerline. */
    async grant({ budget }) {
      if (!p.agent) throw new HttpError(409, 'no_agent', 'Register your agent first.');
      if (!p.registered) return { ...service({ place: 'Records Office', keeper: MOSS, title: `${p.agent.name} isn't registered`, ok: false, reasons: [`A grant is authority for an accountable agent, and no registry knows ${p.agent.name}. Places couldn't check it.`] }), fix: { action: 'register', label: `Register ${p.agent.name} at Town Hall`, place: 'townhall' } };
      if (p.grant) return service({ place: 'Records Office', keeper: MOSS, title: 'Already granted', ok: null, story: `${p.agent.name}'s grant is on file: ${p.grant.plain.join('; ')}. Change it by editing your record here.` });
      const b = BUDGETS.includes(Number(budget)) ? Number(budget) : 50;
      const rec = record();
      await saveRecord({ ...rec, spending: { ...rec.spending, per_purchase: b, per_day: b * 3 } });
      const r = await depositGrant(record());
      if (!r.ok) return service({ place: 'Records Office', keeper: MOSS, title: 'Grant refused', ok: false, reasons: r.reasons });
      return service({
        place: `Records Office · ${grantKeeper().name}`, keeper: MOSS, title: 'Grant deposited',
        story: `Signed and deposited. ${p.agent.name} may spend up to **$${b} a purchase** on books, home goods, food and health goods, pay bills up to $${b}, trade up to $${b} an order, rent up to 8 GPU-hours, and come and go at home. Nothing else.\n\nYour record here adds what no single place can check: **$${b * 3} a day** in all, and the purchases are counted. Edit your record to change any of it, or to say what places may learn.`,
        facts: p.grant.plain.map((x) => ({ label: 'May', value: x })),
      });
    },

    async 'grant.revoke'() {
      if (!p.grant) return service({ place: 'Records Office', keeper: MOSS, title: 'No grant', ok: false, reasons: ['There is no grant on file to revoke.'] });
      const r = await attempt(owner().revokeGrant(grantKeeper(), p.grant.id));
      if (!r.ok) return service({ place: 'Records Office', keeper: MOSS, title: 'Refused', ok: false, reasons: r.reasons });
      p.grant = null;
      return service({ place: `Records Office · ${grantKeeper().name}`, keeper: MOSS, title: 'Grant revoked', stamp: { label: 'Revoked', tone: 'bad' }, story: `The grant is revoked. ${p.agent?.name ?? 'Your agent'} is still registered and accountable, but has no authority: places will refuse anything that needs it.` });
    },

    receipts() {
      return { type: 'receipts', total: p.receipts, entries: [] };
    },

    // ---- Shops and services: you in person, or your agent ---------------------------------------
    async buy({ shop, item, approval, humanApproval }) {
      const def = PLACE_DEFS[shop]?.items?.find((i) => i.id === item);
      if (!def) throw new HttpError(404, 'unknown_item', 'No such item.');
      const short = broke(PLACE_DEFS[shop].name, def.price);
      if (short) return short;
      const card = spend(await go('buy', { shop, item }, shop, 'commerce.purchase', P.purchase(shop, def), { spend: def.price, approval, humanApproval }), def.price);
      if (card.decision === 'allow') {
        p.inventory.push({ name: def.name, from: card.place });
        p.purchases.push({ at: Date.now(), shop, item, name: def.name, price: def.price, byAgent: card.truth === 'agent', badge: card.truth === 'agent' && Boolean(p.badge) });
        p.events.add(`bought:${shop}`);
        p.events.add(card.lane === 'people' && card.truth === 'person' ? 'bought-in-person' : card.lane === 'people' ? 'posed' : 'bought-by-agent');
      }
      return card;
    },
    async pay({ bill, approval, humanApproval }) {
      const def = PLACE_DEFS.bank.bills.find((b) => b.id === bill) ?? PLACE_DEFS.bank.bills[0];
      const short = broke('First Ledger Bank', def.amount);
      if (short) return short;
      const card = spend(await go('pay', { bill: def.id }, 'bank', 'payments.authorize', { payee: def.name, amount: money(def.amount) }, { spend: def.amount, approval, humanApproval }), def.amount);
      if (card.decision === 'allow' && card.classification === 'HUMAN_APPROVED') p.events.add('bank-in-person');
      if (card.decision === 'allow') p.purchases.push({ at: Date.now(), shop: 'bank', item: def.id, name: `paid ${def.name}`, price: def.amount, byAgent: card.truth === 'agent', badge: card.truth === 'agent' && Boolean(p.badge) });
      return card;
    },
    compute: ({ job, humanApproval }) => {
      const def = PLACE_DEFS.forge.jobs.find((j) => j.id === job) ?? PLACE_DEFS.forge.jobs[0];
      return go('compute', { job: def.id }, 'forge', 'compute.provision', { units: def.units, unit: 'gpu_hours' }, { humanApproval });
    },
    async 'fair.claim'({ humanApproval } = {}) {
      const card = await go('fair.claim', {}, 'fair', 'fair.claim', {}, { humanApproval });
      if (card.decision === 'allow') p.inventory.push({ name: 'A free pie', from: 'Harvest Fair' });
      return card;
    },
    'toll.pay': ({ humanApproval } = {}) => go('toll.pay', {}, 'toll', 'payments.authorize', { payee: 'Bridge Toll', amount: money(0.5) }, { humanApproval }),

    async 'id.ask'({ npc: who }) {
      const guest = sim.npcs.get(who);
      if (guest?.kind === 'guest') {
        return service({
          place: 'Your badge reader', keeper: { face: '🔍', who: guest.name }, title: `${guest.name} came with its own badge`, ok: null,
          story: `It's registered${guest.from ? ` at ${guest.from}` : ''}, outside the town, and keeps its own key, so the town can't make it show you its badge. ${PLACE_DEFS[guest.placeId]?.name ?? 'The place'} checked it, and only that place has its badge number.`,
        });
      }
      const them = lookup(who);
      if (!them) throw new HttpError(404, 'gone', 'They have left.');
      const card = await P.visit('reader', 'id.check', {}, them);
      if (card.ppid && card.registry) {
        p.cases.push({ id: `case-${p.cases.length + 1}`, ppid: card.ppid, sealed_ref: card.sealed_ref, rp: P.reader.rp.id, registry: card.registry, about: `${them.name}, whose badge you checked` });
      }
      return { ...card, title: `${them.name}'s badge`, place: 'Your badge reader' };
    },

    async trade({ symbol, side = 'buy', qty = 2, approval, humanApproval }) {
      const price = P.quote(symbol);
      if (!price) throw new HttpError(404, 'unknown_symbol', 'No such symbol.');
      const n = Math.max(1, Math.min(50, Number(qty) || 1));
      const total = Math.round(price * n * 100) / 100;
      const params = { symbol, side, qty: n };
      const req = { symbol, side, qty: n, amount: money(total) };
      if (side === 'buy') return broke('Thistle Exchange', total) ?? spend(await go('trade', params, 'exchange', 'trading.order', req, { spend: total, approval, humanApproval }), total);
      return spend(await go('trade', params, 'exchange', 'trading.order', req, { humanApproval }), -total);
    },

    /** Open an account at the bank: in person that's signing up; an agent needs your name shown (know your customer). */
    'bank.open': ({ humanApproval } = {}) => (asAgent() ? go('bank.open', {}, 'bank', 'banking.open_account', {}, { humanApproval }) : ACTIONS.signup({ place: 'bank' })),

    /** Knock at someone else's door: the lock asks its owner, who may be another person playing. */
    async 'neighbor.knock'({ home }) {
      const n = neighbors().find((x) => x.account === home);
      if (!n) throw new HttpError(404, 'no_home', 'No such home.');
      const card = await visit('hearth', 'home.enter', { account: home });
      if (card.decision === 'step_up' && card.approval_request) {
        if (n.human) {
          p.knocks.push({ account: home, label: n.label, request_id: card.approval_request.request_id, at: Date.now() });
          card.note = `${n.label}'s phone is buzzing: a person decides who comes in. If they approve, try the door again.`;
        } else {
          P.hearth.rp.accounts.decline(card.approval_request.request_id);
          card.declined_by = n.label;
          card.note = `The lock asked the owner of ${n.label}. Their phone showed who stands behind your agent, but not who. They don't know you, so they declined.`;
        }
      }
      if (card.decision === 'allow' && card.result?.items) card.result = { visited: n.label };
      return card;
    },

    /** Tell the police about a badge you checked or a visitor you had. */
    async 'police.complain'({ case: caseId }) {
      const c = p.cases.find((x) => x.id === caseId) ?? p.cases[0];
      if (!c) return service({ place: 'Police Station', keeper: { face: '👮', who: 'Desk sergeant' }, title: 'Nothing to report', ok: false, reasons: ['Bring a badge number: check someone\'s badge first, or wait for trouble at your door.'] });
      const filed = justice.fileCase({ kind: 'complaint', placeId: 'police', title: `Complaint from ${p.principal?.name ?? 'a resident'} about ${c.about}`, evidence: [{ ppid: c.ppid, registry: c.registry, sealed_ref: c.sealed_ref, rp: c.rp, place: 'a complaint' }], by: p.principal?.name ?? 'a resident', owner: pid });
      return service({ place: 'Police Station', keeper: { face: '👮', who: 'Desk sergeant' }, title: `Case ${filed.id} opened`, story: `We've opened case **${filed.id}**. The badge number is all we need: a judge can order the registry to say who stands behind it.` });
    },

    // ---- Home -------------------------------------------------------------------
    async 'home.enter'() {
      const card = await visit('hearth', 'home.enter', { account });
      if (card.decision === 'allow') p.events.add('home');
      if (card.decision === 'step_up' && card.approval_request) card.pending = { request_id: card.approval_request.request_id, retry: { action: 'home.enter', params: {} } };
      return { ...card, keeper: DOOR };
    },
    'home.key': () => visit('hearth', 'home.enter', { account_token: keys[account] }),
    'home.knock'() {
      const params = { account };
      const req = P.hearth.rp.accounts.openRequest(account, 'approve-action', { actor: 'human', action: 'home.enter', params_digest: digestOf(params), summary: 'Open your front door (you, in person)' });
      return service({ place: 'Your front door', keeper: DOOR, title: 'Check your phone', ok: null, story: 'The lock sent a request to your phone. Approve it with your passkey and the door opens, just this once.', pending: undefined, request_id: req.request_id, pendingRequest: { request_id: req.request_id, retry: { action: 'home.inPerson', params: { requestId: req.request_id } } } });
    },
    async 'home.inPerson'({ requestId }) {
      const r = await world.rawRequest(P.hearth.rp.url, 'home.enter', { account }, requestId ? { [HEADERS.humanApproval]: requestId } : {});
      return track(P.cardFrom(P.hearth, 'home.enter', 'you, in person', r));
    },
    async 'home.discard'({ item, approvalRef }) {
      const card = await visit('hearth', 'home.discard', { account, item }, approvalRef ? { headers: { [HEADERS.approvalRef]: approvalRef } } : {});
      if (card.decision === 'step_up' && card.approval_request) card.pending = { request_id: card.approval_request.request_id, retry: { action: 'home.discard', params: { item, approvalRef: card.approval_request.request_id } } };
      return card;
    },
    'maple.knock': async () => {
      const card = await visit('hearth', 'home.enter', { account: 'maple' });
      if (card.decision === 'step_up' && card.approval_request) {
        P.hearth.rp.accounts.decline(card.approval_request.request_id);
        card.declined_by = 'Maple';
      }
      return card;
    },
    'maple.key': async () => {
      if (!p.foundKey) return service({ place: "Maple's door", keeper: { face: '🐰', who: "Maple's door" }, title: 'No key', ok: false, reasons: ["You don't have Maple's key. It's somewhere on a street in Hearthside."] });
      p.events.add('tried-key');
      return visit('hearth', 'home.enter', { account_token: keys.maple });
    },
    'key.pickup'() {
      p.foundKey = true;
      return { type: 'toggle', foundKey: true };
    },
    night: () => night(),

    // ---- Mischief: things the framework should refuse ---------------------------------------
    async 'mischief.wrongplace'({ at }) {
      const target = P.places[at];
      const elsewhere = p.agent && [...p.agent.contexts.values()].find((c) => c.audience !== target.rp.id && c.attestation);
      if (!elsewhere) return service({ place: target.name, keeper: target.keeper, title: 'Nothing to show', ok: false, reasons: [`${p.agent?.name ?? 'Your agent'} hasn't shown its badge anywhere else yet.`] });
      const r = await world.handBuiltRequest({ rp: target.rp, action: target.action, params: sampleParams(at), accountability: elsewhere.attestation, authorization: elsewhere.authorization ?? undefined, proofKey: elsewhere.key });
      return { ...track(P.cardFrom(target, target.action, `${p.agent.name} (badge from elsewhere)`, r)), note: 'Every badge is issued for one place. This one was made out to somewhere else, so it proves nothing here.' };
    },
    async 'mischief.forge'({ at }) {
      const target = P.places[at];
      const forgerKey = generateSigningKey();
      const now = nowSeconds();
      const forged = issueSdJwt({
        vct: `${world.trust.trustAnchor.entity_id}/vct/accountability/1`, iss: 'https://registry-x.example', sub: 'ppid:registry-x.example:p_0000000000000000000000000', aud: target.rp.id, iat: now, exp: now + 300,
        cnf: { jwk: publicOf(forgerKey.publicJwk) }, ppid_mode: 'pairwise',
        accountability: { status: 'accountable', root_principal: { type: 'natural_person', verified: true, verification: { trust_framework: 'nist_800_63A', assurance_level: 'IAL2', verifier: 'https://trust-me.example' }, identity: 'protected' }, chain_length: 1, attributes: [] },
        records: [],
      }, generateSigningKey(), { typ: 'dc+sd-jwt' });
      const r = await world.handBuiltRequest({ rp: target.rp, action: target.action, params: sampleParams(at), accountability: forged, proofKey: forgerKey });
      return { ...track(P.cardFrom(target, target.action, 'a forged badge', r)), note: 'The badge looks right, but no registry in the federation signed it.' };
    },
    async 'mischief.replay'({ at }) {
      const target = P.places[at];
      const victim = [...sim.npcs.values()].find((n) => n.kind === 'resident' && n.agent?.contexts.get(target.rp.id)?.attestation);
      if (!victim) return service({ place: target.name, keeper: target.keeper, title: 'Nothing to copy', ok: false, reasons: [`No resident has shown a badge at ${target.name} yet. Wait for one to shop there.`] });
      const ctx = victim.agent.contexts.get(target.rp.id);
      const r = await world.handBuiltRequest({ rp: target.rp, action: target.action, params: sampleParams(at), accountability: ctx.attestation, authorization: ctx.authorization ?? undefined, proofKey: generateSigningKey() });
      return { ...track(P.cardFrom(target, target.action, `a copy of ${victim.name}'s badge`, r)), note: `You copied ${victim.name}'s badge, but not the key it is bound to. Every request has to be signed by the agent holding that key.` };
    },
    async 'mischief.claim'({ at }) {
      const target = P.places[at];
      const r = await world.rawRequest(target.rp.url, target.action, sampleParams(at), { 'aaf-claim': `principal="${p.principal?.name ?? 'Someone'}"; accountable=true` });
      return { ...track(P.cardFrom(target, target.action, 'a self-asserted claim', r)), note: 'Saying "someone stands behind me" is not the same as a registry vouching for it.' };
    },
  };

  function sampleParams(at) {
    if (PLACE_DEFS[at]?.items) return P.purchase(at, PLACE_DEFS[at].items[0]);
    if (at === 'bank') return { payee: 'the water bill', amount: money(30) };
    if (at === 'forge') return { units: 4, unit: 'gpu_hours' };
    if (at === 'toll') return { payee: 'Bridge Toll', amount: money(0.5) };
    return {};
  }

  function errandTask(task) {
    const [kind, a] = String(task).split(':');
    if (kind === 'buy') {
      const [shop, item] = a.split('/');
      const def = PLACE_DEFS[shop]?.items?.find((i) => i.id === item);
      return def && { label: `buy ${def.name.toLowerCase()} at ${PLACE_DEFS[shop].name}`, place: shop, action: 'commerce.purchase', params: P.purchase(shop, def) };
    }
    if (kind === 'pay') return { label: 'pay the water bill', place: 'bank', action: 'payments.authorize', params: { payee: 'the water bill', amount: money(30) } };
    if (kind === 'fair') return { label: 'claim a free pie at the Harvest Fair', place: 'fair', action: 'fair.claim', params: {} };
    if (kind === 'toll') return { label: 'pay the bridge toll', place: 'toll', action: 'payments.authorize', params: { payee: 'Bridge Toll', amount: money(0.5) } };
    if (kind === 'trade' && P.quote(a)) return { label: `buy 2 ${a} at the Thistle Exchange`, place: 'exchange', action: 'trading.order', params: { symbol: a, side: 'buy', qty: 2, amount: money(Math.round(P.quote(a) * 2 * 100) / 100) } };
    if (kind === 'maplekey') return { label: "try Maple's key", place: 'maple', placeId: 'hearth', action: 'home.enter', params: { account_token: keys.maple }, needsKey: true };
    return null;
  }

  // ---- Night: visitors with a copy of your key ----------------------------------------
  async function night() {
    if (!nightjar) {
      const principal = await world.verifiedPrincipal({
        type: 'legal_person', identity: { legal_name: 'Nightjar Labs Inc.', jurisdiction: 'US-DE', registration_number: 'DE-5521907' }, assurance: 'high', method: 'KYB: registry extract', registry: world.regA,
      });
      const burglars = [];
      for (let i = 1; i <= 3; i++) {
        const a = world.agent(`eval-runner-${i}`);
        await principal.registerAgent(a, { label: `eval-runner-${i}`, records: world.records() });
        burglars.push(a);
      }
      nightjar = { principal, burglars };
    }
    const before = (await nightjar.principal.notifications()).length;
    const params = { account_token: keys[account] };
    const results = [];
    for (const a of nightjar.burglars) {
      const card = await P.visit('hearth', 'home.enter', params, { name: a.name, agent: a, badge: true });
      if (card.ppid) p.cases.push({ id: `night-${p.cases.length + 1}`, ppid: card.ppid, rp: P.hearth.rp.id, registry: card.registry, about: 'one of the badges at your door last night' });
      results.push({ ...card, presented: 'a badge and a copy of your house key' });
    }
    const anon = await P.visit('hearth', 'home.enter', params, { name: 'someone with no badge', agent: null });
    results.push({ ...anon, presented: 'a copy of your house key, nothing else' });
    const relayed = (await nightjar.principal.notifications()).slice(before).filter((n) => n.kind === 'incident');
    p.events.add('night');
    emit({ kind: 'info', place: 'Hearth & Key', placeId: 'home', tone: 'ok', owner: pid, private: true, text: `Four night visitors tried a copy of your key; nobody got in; ${relayed.length} reports relayed to whoever stands behind them` });
    return { type: 'night', results, got_in: results.filter((r) => r.decision === 'allow').length, incidents_relayed: relayed.length };
  }

  // ---------------------------------------------------------------------------
  // The catalog the action deck shows: everything, every time.
  // ---------------------------------------------------------------------------

  const DONE = {
    verify: () => p.verified,
    'bank.open': () => !asAgent() && hasPasskeyAt('bank'),
    register: () => Boolean(p.agent && !p.revoked && p.registered),
    grant: () => Boolean(p.grant),
    'worldid.enroll': () => Boolean(p.worldIdentity),
    'door.passkey': () => (P.hearth.rp.accounts.get(account)?.passkeys.size ?? 0) > 0,
    'phone.passkey': () => phoneReady(),
  };

  /** How a place treats you in person, in a few words. */
  const peopleHint = (placeId) => {
    const place = P.places[placeId];
    if (P.adoptionOf(place) === 'none') return 'checks nothing';
    const rule = place.policy.people ?? 'assume';
    return rule === 'passkey' ? (p.accounts[placeId] ? 'sign in with your passkey' : 'sign up first') : PEOPLE[rule].label.toLowerCase();
  };
  const agentHint = (placeId) => ({ none: "doesn't check badges", block: 'blocks agents', pilot: 'pilot: badges optional' })[P.adoptionOf(P.places[placeId])];

  /** Errands anyone can be sent on: what to buy or pay, where. */
  //   adult  also 18+ goods: the place asks for proof, and the question comes to your phone. Not for a sub-agent,
  //          which can't ask you anything.
  const errandOptions = ({ adult = false } = {}) => [
    ...SHOPS.flatMap((s) => [...PLACE_DEFS[s].items.filter((i) => !i.restricted).slice(0, 2), ...(adult ? PLACE_DEFS[s].items.filter((i) => i.restricted) : [])].map((i) => ({ value: `buy:${s}/${i.id}`, label: `Buy ${i.name.toLowerCase()} at ${PLACE_DEFS[s].name}`, hint: `$${i.price}${i.restricted ? ' · the place asks for proof of age, and you answer on your phone' : ''}` }))),
    { value: 'pay', label: 'Pay the water bill', hint: '$30' },
    { value: 'fair', label: 'Claim a free pie at the Harvest Fair' },
    { value: 'toll', label: 'Pay the bridge toll', hint: `x402, 0.5 ${ASSET}` },
    ...P.market().map((m) => ({ value: `trade:${m.id}`, label: `Buy 2 ${m.id} at the Thistle Exchange`, hint: `$${m.price} each` })),
    { value: 'maplekey', label: "Try Maple's key", hint: p.foundKey ? 'you have it' : "you haven't found it" },
  ];

  /** An errand from that list, as what your agent does there. */
  function errandAction(task) {
    const [kind, a] = String(task).split(':');
    if (kind === 'buy') {
      const [shop, item] = String(a).split('/');
      return PLACE_DEFS[shop]?.items?.some((i) => i.id === item) ? { action: 'buy', params: { shop, item } } : null;
    }
    if (kind === 'pay') return { action: 'pay', params: { bill: 'water' } };
    if (kind === 'fair') return { action: 'fair.claim', params: {} };
    if (kind === 'toll') return { action: 'toll.pay', params: {} };
    if (kind === 'trade' && P.quote(a)) return { action: 'trade', params: { symbol: a, side: 'buy', qty: 2 } };
    if (kind === 'maplekey') return { action: 'maple.key', params: {} };
    return null;
  }

  /**
   * A sub-agent nobody registered: started by your agent (or by another one like it), on its own. No badge,
   * no budget anyone checks, no depth limit, nothing to revoke.
   */
  function spawnUnregistered(parent, depth = 1, from = null) {
    const name = HELPER_NAMES[p.helperCount++ % HELPER_NAMES.length];
    const npc = sim.addHelper({ id: `helper-${name}-${Date.now()}`, name, agent: null, unregistered: true, wallet: `${p.wallet}-${name}`, owner: pid, registry: null, pos: besideAgent(from) });
    Object.assign(npc, { unregistered: true, depth, ofAgent: slot()?.id ?? null });
    p.helpers.push(npc.id);
    emit({ kind: 'people', tone: 'warn', owner: pid, private: true, text: `${parent} started ${name}, a sub-agent no registry knows about${depth > 1 ? ` (${depth} levels below ${p.agent.name})` : ''}` });
    return service({
      place: 'Your device', keeper: DEVICE, title: `${name} is running, unregistered`, stamp: { label: 'No badge', tone: 'warn' },
      story: `${parent} started ${name} on its own. **No registry was asked**, so there was no depth budget to enforce${depth > 1 ? `: ${name} is ${depth} levels below ${p.agent.name}, and nothing stopped it` : ''}. ${name} has no badge, no budget anyone checks, and nobody outside can trace it to you. You can only stop it yourself.`,
      facts: [{ label: 'Chain', value: `you → ${p.agent.name} → ${depth > 1 ? `… → ${name}` : name}, as far as you know` }, { label: 'Registry', value: 'none' }],
    });
  }

  /** The counters in the Hall of Registries: every registry in every federation the town knows. */
  function counterParam() {
    const feds = world.federations?.list() ?? [];
    const options = feds.flatMap((f) => f.view.registries.map((r) => ({
      value: r.id, label: r.name,
      hint: f.kind === 'town' ? (r.id === world.regA?.id ? 'the town’s federation · most places trust it' : 'the town’s federation') : `${f.name} · places must choose to trust it`,
    })));
    return { key: 'registry', label: 'At which counter?', options: options.length ? options : world.registries.map((r) => ({ value: r.id, label: r.name })) };
  }

  /** Where a new sub-agent appears: beside whoever spawned it (your agent, or another sub-agent), a little apart from the others. */
  function besideAgent(from = null) {
    const at = from ?? agentPos(slot()?.id) ?? p.pos ?? { x: 0, y: 0 };
    const n = helpers().filter((h) => h.status === 'active').length;
    return { x: at.x + 24 + (n % 3) * 18, y: at.y + 10 + Math.floor(n / 3) * 16 };
  }

  /** The name of whoever you play. */
  function playingName() {
    if (p.playing === 'me') return 'you';
    if (p.playing === 'agent') return slotOf(p.current)?.agent.name ?? 'your agent';
    return sim.npcs.get(p.playing)?.name ?? 'a sub-agent';
  }

  /** What you can do as one of your agent's sub-agents: errands where it stands, and trying to go a level deeper. */
  function helperCatalog(h) {
    const name = p.agent?.name ?? 'your agent';
    return [
      ...errandOptions().map((o) => {
        const t = errandTask(o.value);
        return t && { id: 'helper.act', key: `helper.act.${o.value}`, group: 'Shops & services', icon: '🛍️', label: o.label, hint: [o.hint, h.unregistered ? 'nothing checks what it spends' : h.budget ? `${name} lets ${h.name} spend up to $${h.budget}` : `${name} hasn't given ${h.name} a budget`].filter(Boolean).join(' · '), place: t.place, fixed: { helper: h.id, task: o.value } };
      }).filter(Boolean),
      { id: 'helper.deeper', key: 'helper.deeper', group: 'Sub-agents', icon: '🪆', label: 'Spawn a sub-agent of your own', hint: h.unregistered ? 'No registry is asked, so nothing stops you' : `The registry let ${name} have sub-agents, but no deeper`, fixed: { helper: h.id } },
    ].map((a) => ({ ...a, key: a.key ?? a.id, done: false }));
  }

  /**
   * The deck: what whoever you play can do now. Playing yourself, what only an agent does you ask your agent
   * to do; playing your agent, only what an agent may do, mischief included. What can't work yet (no agent, no
   * sub-agents, no case, a step already done) isn't listed; what a place might refuse is, because the refusal
   * is the point. Standing settings (the badge, connecting an outside agent, your record) live in the You panel;
   * `settings` adds the ones an agent may change, for an outside agent, which has no panel.
   */
  function catalog({ settings = false } = {}) {
    if (p.playing !== 'me' && p.playing !== 'agent') {
      const h = sim.npcs.get(p.playing);
      if (h?.status === 'active' && h.owner === pid) return helperCatalog(h);
      Object.assign(p, { playing: 'me', acting: 'me' }); // the sub-agent you played is gone
    }
    const hs = helpers().filter((h) => h.status === 'active');
    const helperOpts = hs.map((h) => ({ value: h.id, label: h.name, hint: h.busy ? `out: ${h.busy}` : h.budget ? `up to $${h.budget}` : 'no budget yet' }));
    const placeOpts = TARGETS.map((id) => ({ value: id, label: PLACE_DEFS[id].name }));
    const budgetBase = p.grant?.budget ?? 50;
    const errands = errandOptions();
    const agentErrands = errandOptions({ adult: true });
    const name = p.agent?.name ?? 'your agent';
    const hasAgent = Boolean(p.agent && !p.revoked);
    const agentGoes = asAgent();
    const asSelf = !agentGoes;
    const who = agentGoes ? `${name}${p.badge ? '' : ' (no badge)'}` : 'you, in person';
    const hint = (placeId) => (agentGoes ? agentHint(placeId) : peopleHint(placeId));
    const software = { key: 'software', label: 'Which agent software?', options: Object.entries(SOFTWARE).map(([id, sw]) => ({ value: id, label: sw.name, hint: sw.blurb })) };
    // How a sub-agent starts: registered by its agent at a counter (it walks there), or on its own. Asking one of
    // several agents, each way is offered only for the agents it suits.
    const mine = live();
    const several = mine.length > 1;
    const registeredIds = mine.filter((a) => a.registered).map((a) => a.id);
    const harborIds = mine.filter((a) => a.registered && !a.home).map((a) => a.id);
    const only = (ids) => (several ? { when: { agent: ids } } : {});
    const by = several ? 'It' : name;
    const spawnKinds = [
      ...(several ? registeredIds.length : p.registered) ? [
        { value: 'ephemeral', label: 'Registered, for a few minutes', hint: `${by} registers it at Town Hall; it lapses in 4 minutes`, walk: 'townhall', ...only(registeredIds) },
        { value: 'standing', label: 'Registered, until revoked', hint: `${by} registers it at Town Hall`, walk: 'townhall', ...only(registeredIds) },
        ...((several ? harborIds.length : !p.home) ? [{ value: 'eu', label: 'Registered at the Harbor Registry (EU)', hint: 'Cross-registry: a federated chain', walk: 'harbor', ...only(harborIds) }] : []),
      ] : [],
      { value: 'unregistered', label: 'Unregistered', hint: 'No registry asked: no badge, no depth limit, nothing to revoke' },
    ];
    const spawn = { key: 'kind', label: 'How?', options: spawnKinds };
    // Asking your agents: with more than one, the first question is which. Their sub-agents say whose they are.
    const ask = several ? 'Ask your agents to…' : `Ask ${name} to…`;
    const whichAgent = several ? [{ key: 'agent', label: 'Which agent?', options: mine.map((a) => ({ value: a.id, label: a.agent.name, hint: a.registered ? (a.badge ? 'badge on' : 'badge off') : 'unregistered' })) }] : [];
    const allHelpers = mine.flatMap((a) => a.helpers.map((hid) => sim.npcs.get(hid)).filter((h) => h?.status === 'active').map((h) => ({ h, of: a.agent.name })));
    const askHelperOpts = allHelpers.map(({ h, of }) => ({ value: h.id, label: h.name, hint: [several ? `${of}'s` : '', h.busy ? `out: ${h.busy}` : h.budget ? `up to $${h.budget}` : 'no budget yet'].filter(Boolean).join(' · ') }));
    const unregistered = mine.filter((a) => !a.registered);
    const ungranted = mine.filter((a) => a.registered && !a.grant);
    const list = [
      // ---- You, in person ---------------------------------------------------
      ...(asSelf ? [
        // An agent: one entry, then the choice that matters. You can run several.
        ...(mine.length >= MAX_AGENTS ? [] : [{
          id: 'agent.start', group: mine.length ? 'Your agent' : 'Get started', icon: '🤖', label: mine.length ? 'Start another agent' : p.agents.length ? 'Start a new agent' : 'Start an agent', hint: 'Then choose: register it at Town Hall, or don’t',
          params: [
            { key: 'register', label: 'Register it?', options: [
              { value: 'yes', label: 'Register it at Town Hall', hint: p.verified ? 'A registry vouches for it, and it gets a badge' : 'A registry vouches for it, and it gets a badge. You need to be verified first', walk: 'townhall' },
              { value: 'no', label: 'Don’t register it', hint: 'Like most agents today: no badge, and nobody can trace it to you' },
            ] },
            { key: 'name', label: "Your agent's name", input: true, value: agentNameFor() },
            software,
            { ...counterParam(), when: { register: 'yes' } },
          ],
        }]),
        ...unregistered.map((a) => ({ id: 'register', key: several ? `register.${a.id}` : 'register', group: 'Your agent', icon: '🪪', label: `Register ${a.agent.name}`, hint: 'Same agent, same key: a registry vouches for it, and it gets a badge', place: 'townhall', fixed: { agent: a.id }, params: [counterParam()], done: false })),
        { id: 'verify', group: 'You', icon: '🪪', label: 'Get verified (KYC)', hint: 'Once. Only the registry keeps your name.', place: 'townhall' },
        { id: 'worldid.enroll', group: 'You', icon: '🔮', label: 'Get a World ID at the Orb', hint: 'Simulated: proof you are a unique human, no name', place: 'orb' },
        { id: 'phone.passkey', group: 'You', icon: '📱', label: 'Put a passkey on your phone', hint: 'For approving what your agent shares and spends', client: 'phone.passkey' },
        // The first grant is signed at the Records Office; after that, the You panel changes it.
        ...(ungranted.length ? [
          { id: 'record', group: 'Your record', icon: '🗂️', label: 'Set your record', hint: `What ${listOf(ungranted.map((a) => a.agent.name))} may spend, and what places may learn about you (proposed)`, place: 'records', client: 'record', done: false },
          ...ungranted.map((a) => ({ id: 'grant', key: ungranted.length > 1 ? `grant.${a.id}` : 'grant', group: 'Your record', icon: '📜', label: several ? `Sign a grant for ${a.agent.name} (quick)` : 'Sign a grant (quick)', hint: 'Just a limit per purchase', place: 'records', fixed: { agent: a.id }, done: false, params: [{ key: 'budget', label: 'Spending limit per purchase', options: BUDGETS.map((b) => ({ value: b, label: `Up to $${b}` })) }] })),
        ] : []),
        // Places where people sign in with a passkey: offered there, not everywhere. The bank has its own.
        ...Object.keys(PLACE_DEFS).filter((id) => id !== 'bank' && P.places[id].policy.people === 'passkey').map((id) => ({
          id: 'signup', key: `signup.${id}`, group: 'Shops & services', icon: '🔑', label: p.accounts[id] ? 'Put a passkey on your account here' : 'Open an account here',
          hint: p.accounts[id] ? 'Then only you can use it' : 'People sign in here with a passkey', place: id, hereOnly: true, fixed: { place: id }, done: hasPasskeyAt(id),
        })),
        { id: 'door.passkey', group: 'Home', icon: '🔑', label: 'Put a passkey on your door', hint: 'Touch ID, Face ID or device PIN', place: 'home', client: 'passkey' },
        { id: 'home.knock', group: 'Home', icon: '✋', label: 'Knock in person (passkey)', hint: 'The human path', place: 'home' },
        { id: 'night', group: 'Home', icon: '🌙', label: 'Rest at home until night', place: 'home', client: 'night' },
        ...(p.cases.length ? [
          { id: 'court', group: 'You', icon: '⚖️', label: 'Ask the court who is behind a badge', hint: 'Resolution under legal process', place: 'court', params: [{ key: 'case', label: 'Which case?', options: p.cases.map((c) => ({ value: c.id, label: c.about })) }] },
        ] : []),
      ] : []),

      // ---- Asking your agent: it goes, you stay ---------------------------
      ...(asSelf && mine.length ? [
        { id: 'agent.errand', group: ask, ask: true, icon: '🧺', label: 'Run an errand', hint: 'It walks there on its own and stays there; you carry on', via: 'agent', params: [...whichAgent, { key: 'task', label: 'To do what?', options: agentErrands }] },
        { id: 'agent.call', group: ask, ask: true, icon: '📣', label: 'Come over', hint: 'It walks to you and stays beside you', params: whichAgent },
        { id: 'helper.spawn', group: ask, ask: true, icon: '🌱', label: 'Spawn a sub-agent', hint: `${several ? 'It' : name} goes; you stay here`, via: 'agent', params: [...whichAgent, spawn] },
        ...(allHelpers.length ? [
          { id: 'helper.errand', group: ask, ask: true, icon: '🧺', label: 'Send a sub-agent on an errand', hint: 'It walks there and back on its own', via: 'agent', params: [{ key: 'helper', label: 'Who?', options: askHelperOpts }, { key: 'task', label: 'To do what?', options: errands }] },
          { id: 'helper.fund', group: ask, ask: true, icon: '💰', label: 'Give a sub-agent a budget', hint: `Delegation: ${several ? 'its agent' : name} goes to the Records Office`, via: 'agent', params: [{ key: 'helper', label: 'Who?', options: askHelperOpts }, { key: 'budget', label: 'How much a purchase?', options: [Math.round(budgetBase / 5), Math.round(budgetBase / 2.5), budgetBase * 2].map((v) => ({ value: v, label: `$${v}`, hint: v > budgetBase ? `more than ${name} has` : '' })) }] },
          { id: 'helper.call', group: ask, ask: true, icon: '📣', label: 'Call a sub-agent over', hint: 'It walks over and stays there', via: 'agent', params: [{ key: 'helper', label: 'Who?', options: askHelperOpts }] },
          { id: 'helper.deeper', group: ask, ask: true, icon: '🪆', label: 'Have a sub-agent spawn its own', hint: 'Depth budget', via: 'agent', params: [{ key: 'helper', label: 'Who?', options: askHelperOpts }] },
        ] : []),
        { id: 'home.enter', group: ask, ask: true, icon: '🚪', label: 'Go into your house', hint: `${several ? 'It' : name} goes; you stay here`, via: 'agent', params: whichAgent },
      ] : []),

      // ---- Your agent, played -----------------------------------------------
      ...(agentGoes ? [
        { id: 'helper.spawn', group: 'Sub-agents', icon: '🌱', label: 'Spawn a sub-agent', hint: p.registered ? 'Register it, or don’t' : 'No registry knows you, so none will register it', params: [spawn] },
        ...(hs.length ? [
          { id: 'helper.errand', group: 'Sub-agents', icon: '🧺', label: 'Send a sub-agent on an errand', hint: 'It walks there and back on its own', params: [{ key: 'helper', label: 'Who?', options: helperOpts }, { key: 'task', label: 'To do what?', options: errands }] },
          { id: 'helper.fund', group: 'Sub-agents', icon: '💰', label: 'Give a sub-agent a budget', hint: 'Delegation, at the Records Office', place: 'records', params: [{ key: 'helper', label: 'Who?', options: helperOpts }, { key: 'budget', label: 'How much a purchase?', options: [Math.round(budgetBase / 5), Math.round(budgetBase / 2.5), budgetBase * 2].map((v) => ({ value: v, label: `$${v}`, hint: v > budgetBase ? `more than you have` : '' })) }] },
          { id: 'helper.deeper', group: 'Sub-agents', icon: '🪆', label: 'Ask a sub-agent to spawn its own', hint: 'Depth budget', params: [{ key: 'helper', label: 'Who?', options: helperOpts }] },
          { id: 'helper.call', group: 'Sub-agents', icon: '📣', label: 'Call a sub-agent over', hint: 'It walks over and stays there', params: [{ key: 'helper', label: 'Who?', options: helperOpts }] },
          { id: 'helper.revoke', group: 'Sub-agents', icon: '✂️', label: 'Revoke a sub-agent', params: [{ key: 'helper', label: 'Who?', options: helperOpts }] },
        ] : []),
        { id: 'home.enter', group: 'Home', icon: '🚪', label: 'Go into the house', hint: 'If its owner let you in', place: 'home' },
        { id: 'mischief.wrongplace', group: 'Mischief', icon: '🔀', label: 'Show a badge made out to another place', hint: 'Mischief', params: [{ key: 'at', label: 'Where?', options: placeOpts, here: true }] },
        { id: 'mischief.forge', group: 'Mischief', icon: '🖨️', label: 'Show a forged badge', hint: 'Mischief', params: [{ key: 'at', label: 'Where?', options: placeOpts, here: true }] },
        { id: 'mischief.replay', group: 'Mischief', icon: '📋', label: "Replay a copy of a resident's badge", hint: 'Mischief', params: [{ key: 'at', label: 'Where?', options: placeOpts, here: true }] },
        { id: 'mischief.claim', group: 'Mischief', icon: '🗣️', label: 'Just claim to be accountable', hint: 'Mischief', params: [{ key: 'at', label: 'Where?', options: placeOpts, here: true }] },
        // Settings an outside agent may change; in the browser they're in the You panel and on the dock.
        ...(settings && p.registered ? [
          { id: 'badge', group: 'Settings', icon: p.badge ? '🙈' : '🪪', label: p.badge ? 'Take your badge off' : 'Put your badge on' },
          { id: 'incognito', group: 'Settings', icon: '🎭', label: p.incognito ? 'Use steady badge numbers' : 'Use one-time badge numbers', hint: 'Ephemeral PPIDs: a fresh number every request' },
          { id: 'pose', group: 'Settings', icon: '🥸', label: 'Go out without your badge', hint: 'Places that take people at their word will take you for a person' },
        ] : []),
      ] : []),

      // ---- Either of you ----------------------------------------------------
      ...(p.cases.length ? [{ id: 'police.complain', group: 'You', icon: '👮', label: 'Report someone to the police', hint: 'A badge you checked, or a visitor', place: 'police', params: [{ key: 'case', label: 'About whom?', options: p.cases.map((c) => ({ value: c.id, label: c.about })) }] }] : []),
      ...SHOPS.map((s) => ({ id: 'buy', group: 'Shops & services', icon: SHOP_ICONS[s] ?? '🛍️', label: `Buy at ${PLACE_DEFS[s].name}`, hint: [who, hint(s)].filter(Boolean).join(' · '), place: s, fixed: { shop: s }, key: `buy.${s}`, params: [{ key: 'item', label: 'What?', options: PLACE_DEFS[s].items.map((i) => ({ value: i.id, label: i.name, hint: `$${i.price}${i.category ? ` (${i.category})` : ''}` })) }] })),
      { id: 'pay', group: 'Shops & services', icon: '🏦', label: 'Pay at First Ledger Bank', hint: [who, hint('bank')].filter(Boolean).join(' · '), place: 'bank', params: [{ key: 'bill', label: 'Pay what?', options: PLACE_DEFS.bank.bills.map((b) => ({ value: b.id, label: b.name, hint: `$${b.amount}` })) }] },
      { id: 'bank.open', group: 'Shops & services', icon: '🏦', label: 'Open an account at First Ledger Bank', hint: agentGoes ? 'Know your customer: the bank asks for your owner’s name' : 'In person: you sign in with a passkey', place: 'bank' },
      { id: 'trade', group: 'Shops & services', icon: '📈', label: 'Trade at the Thistle Exchange', hint: [who, hint('exchange')].filter(Boolean).join(' · '), place: 'exchange', params: [
        { key: 'symbol', label: 'Which?', options: P.market().map((m) => ({ value: m.id, label: `${m.id} · ${m.name}`, hint: `$${m.price} (${m.change >= 0 ? '+' : ''}${m.change}% today)` })) },
        { key: 'side', label: 'Buy or sell?', options: [{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }] },
        { key: 'qty', label: 'How many?', options: [1, 2, 5, 10].map((n) => ({ value: n, label: String(n) })) },
      ] },
      { id: 'compute', group: 'Shops & services', icon: '🔥', label: 'Rent GPUs at the Compute Forge', hint: [who, hint('forge')].filter(Boolean).join(' · '), place: 'forge', params: [{ key: 'job', label: 'How big?', options: PLACE_DEFS.forge.jobs.map((j) => ({ value: j.id, label: j.name })) }] },
      { id: 'fair.claim', group: 'Shops & services', icon: '🥧', label: 'Claim a free pie at the Harvest Fair', hint: `${who} · one per person (World ID)`, place: 'fair' },
      { id: 'toll.pay', group: 'Shops & services', icon: '🌉', label: 'Pay the bridge toll', hint: `${who} · x402, 0.5 ${ASSET} (simulated)`, place: 'toll' },
      // Only for whoever is standing near you: the browser keeps the ones within a few steps.
      { id: 'id.ask', group: 'Shops & services', icon: '🔍', label: 'Ask someone nearby to show their badge', hint: 'Your own badge reader', near: true, params: [{ key: 'npc', label: 'Whom?', options: 'npcs' }] },
      { id: 'home.key', group: 'Home', icon: '🗝️', label: 'Just use the house key', hint: 'A bearer token', place: 'home' },
      // A knock happens at the door: one for each neighbor's, offered there, like a shop's counter.
      ...neighbors().map((n) => ({ id: 'neighbor.knock', key: `neighbor.knock.${n.account}`, group: 'Home', icon: '🚪', label: `Knock at ${n.label.replace(/'s( home)?$/, '')}'s door`, hint: n.human ? 'Someone is home: they decide' : 'Its owner decides', place: n.place, fixed: { home: n.account } })),
      { id: 'maple.key', group: 'Home', icon: '🗝️', label: "Try Maple's key", place: 'maple', hint: p.foundKey ? 'you found it' : 'lost somewhere in Hearthside' },

      // ---- Information --------------------------------------------------------
      { id: 'hall.registries', group: 'Information', icon: '🏛️', label: 'The Hall of Registries', hint: 'Every registry, by federation; add another federation, or your own registry', place: 'townhall', client: 'hall', info: true },
      { id: 'hall.records', group: 'Information', icon: '🗄️', label: 'The Hall of Record Keepers', hint: `Every record keeper, by federation; yours is ${grantKeeper()?.name ?? 'not chosen yet'}`, place: 'records', client: 'hall', info: true },
      ...(asSelf && mine.length ? [{ id: 'register.view', group: 'Information', icon: '📒', label: 'Your register of attempts', hint: 'Every purchase your agents tried, and today’s totals', client: 'register', info: true }] : []),
      ...(hasAgent && p.registered ? [{ id: 'receipts', group: 'Information', icon: '🧾', label: 'Show activity receipts', place: 'records', client: 'receipts', info: true }] : []),
    ].map((a) => ({ ...a, key: a.key ?? a.id, done: a.done ?? DONE[a.key ?? a.id]?.() ?? false }));
    // A step you've taken once is in the You panel now, not the deck.
    return list.filter((a) => !a.done);
  }

  /**
   * Run one action. `as: 'agent'` is a paired outside agent: it acts as the
   * agent whatever the browser's toggle says, and only within AGENT_MAY.
   */
  async function run(id, params = {}, { as, agent } = {}) {
    const fn = ACTIONS[id];
    if (!fn) throw new HttpError(404, 'unknown_action', `no action ${id}`);
    // Which of your agents this is about: the one named, the one you play, the sub-agent's own (you, in person,
    // asking), the sub-agent you play's, or the one you're dealing with. It stays that one to the end, even if you
    // pick another meanwhile.
    const playedHelper = p.playing !== 'me' && p.playing !== 'agent' ? sim.npcs.get(p.playing) : null;
    const target = agent ?? params.agent ?? (p.playing === 'agent' ? p.current : null) ?? (params.helper ? sim.npcs.get(params.helper)?.ofAgent : null) ?? playedHelper?.ofAgent ?? p.current;
    if (target && !slotOf(target)) throw new HttpError(404, 'no_agent', 'You have no agent by that name.');
    return which.run(target, () => runAs(id, fn, params, as));
  }

  async function runAs(id, fn, params, as) {
    if (p.halted && !['agents.resume', 'stop.all', 'play', 'acting'].includes(id) && (as === 'agent' || asAgent() || AGENT_ONLY.has(id) || id === 'helper.act')) {
      return { ...service({ place: 'Your device', keeper: DEVICE, title: 'Your agents are stopped', ok: false, reasons: ['You stopped everything. Start your agents again first.'] }), fix: { action: 'agents.resume', label: 'Start your agents again' } };
    }
    if (as === 'agent') {
      if (!AGENT_MAY.has(id)) throw new HttpError(403, 'principal_only', `Only your principal can do "${id}", in the browser. Ask them.`);
      if (!p.agent || p.revoked) throw new HttpError(409, 'no_agent', 'Your principal has no active agent for you to drive.');
    }
    const out = await (as ? acting.run({ as }, () => fn(params)) : fn(params));
    // A place asked, and the record says to ask you: the question goes to your phone.
    if (out?.ask && out.decision === 'step_up' && out.agentAnswer?.overall === 'ask') {
      p.asks = p.asks.filter((a) => !(a.placeId === out.ask.placeId && a.retry.action === id));
      // Only what needs your say-so goes on the phone; what the record already allows goes anyway.
      const want = out.ask.want.filter((w) => !w.shared && out.agentAnswer.items.some((i) => i.kind === w.kind && i.name === w.name && i.answer === 'ask'));
      // Remember who asked: answered later, the retry goes the same way (you in person, or your agent).
      const ask = { id: `ask-${++p.askCount}`, ...out.ask, want, retry: { action: id, params, as: as ?? (asAgent() ? 'agent' : 'me'), agent: slot()?.id ?? null }, at: Date.now() };
      p.asks.push(ask);
      out.ask = { ...out.ask, id: ask.id, want };
    } else if (out?.ask && out.agentAnswer?.overall !== 'ask') {
      out.ask = null;
    }
    return out;
  }

  async function enroll({ name }) {
    if (p.principal) throw new HttpError(409, 'already_enrolled', 'You are already enrolled.');
    const legalName = String(name ?? '').trim().slice(0, 40) || 'A Resident';
    p.principal = await world.enrolledPrincipal({ type: 'natural_person', identity: { legal_name: legalName, jurisdiction: 'US-NY' }, registry: world.regA });
    P.hearth.rp.accounts.get(account).owner = legalName;
    K.phone.create(p.principal.id, legalName);
    await saveRecord(defaultRecord());
    return { principal_id: p.principal.id, registry: town };
  }

  /** Every approval waiting for you, wherever it was opened: your phone, your door, places you sign in to. */
  function approvals() {
    const list = [];
    const from = (service, accounts, acct) => {
      for (const { id, purpose, details } of accounts.pendingFor(acct)) list.push({ request_id: id, purpose, details, service });
    };
    if (p.principal) from('phone', K.phone, p.principal.id);
    from('door', P.hearth.rp.accounts, account);
    for (const [placeId, acct] of Object.entries(p.accounts)) from(`place:${placeId}`, P.places[placeId].rp.accounts, acct);
    return list;
  }

  async function state() {
    // Incidents and court orders come from every registry you're enrolled at.
    const all = p.principal ? (await Promise.all([p.principal, ...Object.values(p.principals ?? {})].map((x) => x.notifications().catch(() => [])))).flat() : [];
    const notifications = all.filter((n) => n.kind === 'incident').concat(all.filter((n) => n.kind === 'resolution').map((n) => ({
      incident_id: n.resolution_id, agent_label: n.agent_label, reporter: n.authority, summary: `A court order (case ${n.case}) made the registry say who stands behind this agent`, at: n.at,
    })));
    const ppidAtHome = p.agent?.contexts.get(P.hearth.rp.id)?.ppid;
    const knocks = p.knocks.map((k) => {
      const ppid = p.agent?.contexts.get(P.hearth.rp.id)?.ppid;
      const pendingNow = P.hearth.rp.accounts.pendingFor(k.account).some((r) => r.id === k.request_id);
      const status = ppid && P.hearth.rp.accounts.delegationFor(k.account, ppid, 'home.enter') ? 'approved' : pendingNow ? 'waiting' : 'declined';
      return { ...k, status };
    });
    const rec = record();
    return {
      principal: p.principal ? { name: p.principal.name, verified: p.verified, registry: town, worldid: Boolean(p.worldIdentity), banned: justice?.isBanned(p.principal.identity) ?? null, facts: p.verified ? ['over 18'] : [] } : null,
      acting: asAgent() ? 'agent' : 'me',
      playing: p.playing,
      playingName: playingName(),
      knocks,
      market: P.market(),
      // The agent you're dealing with (the one you play or last picked), and all of them.
      agent: p.agent ? agentView(slot()) : null,
      agents: p.agents.map((a) => which.run(a.id, () => agentView(a))),
      current: slot()?.id ?? null,
      halted: live().some((a) => a.halted),
      badge: Boolean(p.agent && p.badge),
      grant: p.grant,
      record: rec, register: p.principal ? K.register(p.principal.id) : null, sharable: SHARABLE,
      places: Object.fromEntries(Object.keys(PLACE_DEFS).map((id) => [id, { name: PLACE_DEFS[id].name, people: P.places[id].policy.people, account: Boolean(p.accounts[id]), passkey: (P.places[id].rp.accounts.get(p.accounts[id])?.passkeys.size ?? 0) > 0 }])),
      wallet: { balance: x402.balance(p.wallet), spent: p.spent, asset: ASSET },
      helpers: p.agents.flatMap((a) => a.helpers.map((hid) => sim.npcs.get(hid)).filter(Boolean).map((h) => ({ id: h.id, name: h.name, agent: a.id, status: h.status, budget: h.budget ?? null, busy: h.busy ?? null, registry: h.registry, unregistered: Boolean(h.unregistered), depth: h.depth ?? 1, ephemeral_until: h.ephemeralUntil }))),
      home: { passkey: (P.hearth.rp.accounts.get(account)?.passkeys.size ?? 0) > 0, agent_let_in: Boolean(ppidAtHome && P.hearth.rp.accounts.delegationFor(account, ppidAtHome, 'home.enter')) },
      found_key: p.foundKey, inventory: p.inventory, known: Object.values(p.known), receipts: p.receipts, events: [...p.events],
      phone: {
        passkey: phoneReady(),
        incidents: notifications.map((n) => ({ id: n.incident_id, agent: n.agent_label, reporter: placeName(n.reporter), summary: n.summary, at: n.at })),
        approvals: approvals(),
        asks: p.asks.map(({ id, place, placeId, want, tier, law, at }) => ({ id, place, placeId, what: want.filter((w) => !w.shared), tier, law, at })),
        consent: rec ? Object.keys(PLACE_DEFS).map((placeId) => ({
          placeId, place: PLACE_DEFS[placeId].name,
          what: Object.entries(rec.sharing).filter(([, v]) => v.always.includes(placeId)).map(([k]) => SHARABLE[k]),
        })).filter((c) => c.what.length) : [],
      },
      cases: p.cases.length,
    };
  }

  const placeName = (id) => Object.values(P.places).find((x) => x.rp?.id === id)?.name ?? id;

  /** One of your agents, for your own browser: call it inside which.run(a.id) so its registry is its own. */
  const agentView = (a) => ({
    id: a.id, name: a.agent.name, status: a.revoked ? 'revoked' : 'active', registered: a.registered, badge: Boolean(a.registered && a.badge), incognito: a.incognito, halted: a.halted,
    registry: a.registered ? homeRegistry().name : null, federation: a.registered ? world.federations?.of(homeRegistry().id)?.name ?? null : null, keeper: a.registered ? grantKeeper()?.name ?? null : null,
    software: SOFTWARE[a.software], grant: a.grant ? { budget: a.grant.budget, plain: a.grant.plain, permissions: a.grant.permissions } : null,
  });

  return {
    catalog, run, enroll, state, reset, account,
    /** What this player has bought, for the head-to-head errands. */
    purchases: () => p.purchases,
    /** Who they play: 'me', 'agent', or a sub-agent's id. */
    playing: () => p.playing,
    /** Whether they run an agent now (registered or not). */
    hasAgent: () => live().length > 0,
    /** The agent they're dealing with: the one they play or last picked. */
    current: () => (slotOf(p.current)?.revoked ? null : p.current),
    /** Their agents nobody has revoked, by id. */
    agentIds: () => live().map((a) => a.id),
    /** An agent's name. */
    agentName: (id) => slotOf(id ?? p.current)?.agent.name ?? null,
    /** Where an errand task happens. */
    taskPlace: (task) => errandTask(task)?.place ?? null,
    /** What one of your agent's sub-agents can do, for an outside agent driving it. */
    helperActions: (id) => which.run(sim.npcs.get(id)?.ofAgent ?? p.current, () => helperCatalog(helper(id))),
    errandAction,
    /** Playing yourself, this is something you ask your agent to do: it goes, you stay. */
    instructs: (id) => p.playing === 'me' && AGENT_ONLY.has(id) && live().length > 0,
    /** The actions an outside agent driving one of your agents may take, for its tool list. */
    agentCatalog: (id) => which.run(id ?? p.current, () => acting.run({ as: 'agent' }, () => catalog({ settings: true }).filter((a) => AGENT_MAY.has(a.id)))),
    /** What an outside agent needs to know to play one of your agents: who it is, its record, what waits on its principal. */
    briefing: (id) => which.run(id ?? p.current, () => ({
      agent: p.agent && !p.revoked ? {
        name: p.agent.name, software: SOFTWARE[p.software]?.name, badge: p.badge && p.registered, registered: p.registered,
        registry: p.registered ? homeRegistry().name : null, federation: p.registered ? world.federations?.of(homeRegistry().id)?.name ?? null : null,
      } : null,
      record: record(), register: p.principal ? K.register(p.principal.id) : null, grant: p.grant?.plain ?? null,
      wallet: x402.balance(p.wallet),
      asks: p.asks.map(({ id, place, placeId, want, tier, law }) => ({ id, place, placeId, want: want.map((w) => w.label), tier, law })),
      approvals: approvals(), phonePasskey: phoneReady(),
    })),
    /** How this player presents when someone asks to see a badge: their agent, or the person. */
    presentAs: () => (asAgent() ? byAgent() : byPerson()),
    /** One of their agents, asked directly. */
    agentAs: (id) => which.run(id ?? p.current, () => (p.agent && !p.revoked ? byAgent() : null)),
    /** The approval services this player answers for: the phone, the door, places they sign in to. */
    approvalServices() {
      return [
        ...(p.principal ? [{ service: 'phone', accounts: K.phone, account: p.principal.id }] : []),
        { service: 'door', accounts: P.hearth.rp.accounts, account },
        ...Object.entries(p.accounts).map(([placeId, acct]) => ({ service: `place:${placeId}`, accounts: P.places[placeId].rp.accounts, account: acct })),
      ];
    },
    setPos(pos) {
      if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) p.pos = { x: pos.x, y: pos.y };
    },
    get pos() {
      return p.pos;
    },
    get principal() {
      return p.principal;
    },
    /** What others see walking past: a resident, and the agent following them. Never the resident's name. */
    appearance: () => ({ agent: p.agent && !p.revoked ? p.agent.name : null, badge: Boolean(p.agent && p.registered && p.badge), registered: p.registered, revoked: p.revoked, acting: asAgent() ? 'agent' : 'me', playing: p.playing }),
    /** Each of their agents as others see it. */
    appearances: () => live().map((a) => ({ id: a.id, agent: a.agent.name, badge: Boolean(a.registered && a.badge), registered: a.registered, revoked: false })),
  };
}
