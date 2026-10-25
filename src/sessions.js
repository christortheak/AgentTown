// The people playing. Each browser tab that joins gets a session and a role:
//   agent       a resident: walks the town in person, can register an agent and send it; law-abiding or not
//   shopkeeper  runs one place: sets its policy, sees every customer's ID check, reports them
//   homeowner   owns a house in Hearthside: a passkey on the door, decides who comes in
//   police      investigates cases and petitions the court
//   judge       rules on petitions: identify, delete agents, ban principals
//   council     makes the law: switches regimes on and off in each jurisdiction
// A session that goes quiet for a few minutes is let go, with whatever it held.
// Anyone can come back with a new session, under any name; a banned identity
// just won't be verified again.
import crypto from 'node:crypto';
import { HttpError } from 'aaf-reference/src/lib/http.js';
import { createPlayer } from './player.js';
import { PLACE_DEFS, HOUSES, ADOPTION, ADOPTION_PRESETS, PEOPLE } from './places.js';
import { REGIMES } from './rulebook.js';

const IDLE_MS = 4 * 60 * 1000;

export const ROLES = {
  agent: { icon: '🧍', label: 'A resident', blurb: 'You walk the town yourself. Get verified, register an agent, and choose who goes: you or it. Shop, trade, spawn sub-agents. Play it straight, or try to get away with something.' },
  shopkeeper: { icon: '🏪', label: 'A shopkeeper', blurb: 'Run a shop, the bank, the exchange or the toll: decide which registries you trust and what you ask for, and see exactly what each customer proves.' },
  homeowner: { icon: '🏡', label: 'A homeowner', blurb: 'Put a passkey on your door and decide, on your phone, which agents come in.' },
  police: { icon: '👮', label: 'Police', blurb: 'Investigate fraud and rogue agents from the cases places report, and take them to court.' },
  judge: { icon: '⚖️', label: 'The judge', blurb: 'Rule on petitions: order a registry to identify a principal, delete rogue agents, ban a principal.' },
  council: { icon: '🏛️', label: 'Town council', blurb: 'Make the law for the town or the Harbor: anti-money-laundering, consumer protection, privacy. See what places must ask for change, while the registries stay exactly as they are.' },
};

const RESIDENT_LOOK = { body: '#fff1d6', bulb: null, badge: 'none', feet: '#7a5a3a' };
const PERSON_LOOKS = {
  shopkeeper: { body: '#ffe1a8', bulb: null, badge: 'none', feet: '#7a5a3a' },
  homeowner: { body: '#d7f0ff', bulb: null, badge: 'none', feet: '#5a6a7a' },
  police: { body: '#c9d6ff', bulb: '#4f7fbf', glow: true, badge: 'on', badgeColor: '#ffe08a', badgeMark: '#2c3e66', feet: '#2c3e66' },
  judge: { body: '#3b3346', bulb: null, badge: 'none', feet: '#22202a' },
  council: { body: '#e9d8ff', bulb: null, badge: 'none', feet: '#5b4a7a' },
};

export function createSessions({ world, places, sim, worldid, x402, emit, keys, justice, ledger, origin }) {
  const sessions = new Map(); // token -> session
  const byId = new Map(); // public id -> session
  const accounts = places.hearth.rp.accounts;

  const holder = (claim) => [...sessions.values()].find((s) => s.claim === claim) ?? null;
  const ofRole = (role) => [...sessions.values()].filter((s) => s.role === role);

  function neighbors(selfId) {
    return [
      ...Object.entries(HOUSES).map(([account, label]) => ({ account, label, place: account, human: Boolean(holder(account)) })),
      ...ofRole('agent').filter((s) => s.id !== selfId).map((s) => ({ account: s.player.account, label: `${s.name}'s home`, place: 'home', human: true })),
    ];
  }

  /** How someone presents when asked to show their badge: an NPC, or another player's agent. */
  function lookup(id) {
    const npc = sim.npcs.get(id);
    if (npc) return sim.byFor(npc);
    const companion = typeof id === 'string' && id.endsWith('-agent') ? byId.get(id.slice(0, -6)) : null;
    if (companion?.player) return companion.player.agentAs();
    const s = byId.get(id);
    if (s?.player) return s.player.presentAs();
    if (s) return { name: s.name, agent: null, badge: false };
    return null;
  }

  async function join({ role, name, claim }) {
    if (!ROLES[role]) throw new HttpError(400, 'bad_role', 'Pick a role.');
    const display = String(name ?? '').trim().slice(0, 30) || 'A Resident';
    if (role === 'shopkeeper' && (!PLACE_DEFS[claim] || holder(claim))) throw new HttpError(409, 'taken', 'Pick a place nobody else is running.');
    if (role === 'homeowner' && (!HOUSES[claim] || holder(claim))) throw new HttpError(409, 'taken', 'Pick a house nobody else owns.');
    if (role === 'judge' && ofRole('judge').length) throw new HttpError(409, 'taken', 'The town already has a judge.');
    const id = `p_${crypto.randomBytes(4).toString('hex')}`;
    const s = { token: crypto.randomBytes(18).toString('base64url'), id, role, name: display, claim: ['shopkeeper', 'homeowner'].includes(role) ? claim : null, pos: null, lastSeen: Date.now(), joined: Date.now() };
    if (role === 'agent') {
      s.player = createPlayer({ id, account: `home-${id}`, world, places, sim, worldid, x402, emit, keys, justice, neighbors: () => neighbors(id), lookup });
      await s.player.enroll({ name: display });
    } else if (role === 'shopkeeper') {
      places.claimPlace(claim, { id, name: display });
    } else if (role === 'homeowner') {
      places.takeHouse(claim, display);
    }
    sessions.set(s.token, s);
    byId.set(id, s);
    // An agent's principal stays private: others see a new agent, never whose it is.
    const where = s.claim ? ` (${PLACE_DEFS[s.claim]?.name ?? HOUSES[s.claim]})` : '';
    emit({ kind: 'people', tone: 'info', owner: id, text: role === 'agent' ? 'Someone new moved into town' : `${display} joined as ${ROLES[role].label.toLowerCase()}${where}` });
    return { session: s.token, id, role, name: display, claim: s.claim };
  }

  function leave(s) {
    if (!sessions.has(s.token)) return;
    sessions.delete(s.token);
    byId.delete(s.id);
    if (s.player) {
      s.player.reset();
      delete keys[s.player.account];
    }
    if (s.role === 'shopkeeper') places.claimPlace(s.claim, null);
    if (s.role === 'homeowner') {
      places.takeHouse(s.claim, null);
      accounts.get(s.claim).owner = HOUSES[s.claim].replace("'s", '');
    }
    emit({ kind: 'people', tone: 'info', text: s.role === 'agent' ? 'A resident left town' : `${s.name} left town` });
  }

  const sweep = setInterval(() => {
    for (const s of sessions.values()) if (Date.now() - s.lastSeen > IDLE_MS) leave(s);
  }, 30000);

  function get(token) {
    const s = sessions.get(token);
    if (!s) throw new HttpError(401, 'no_session', 'Join the town first.');
    s.lastSeen = Date.now();
    return s;
  }

  /** The passkey services a session answers for: a player's phone, door and place accounts; a homeowner's door. */
  function services(s) {
    if (s.player) return s.player.approvalServices();
    if (s.role === 'homeowner') return [{ service: 'door', accounts, account: s.claim }];
    return [];
  }
  function serviceFor(s, name = 'door') {
    const sv = services(s).find((x) => x.service === (name ?? 'door'));
    if (!sv) throw new HttpError(409, 'no_service', name === 'door' ? 'Only residents and homeowners have a front door.' : `No ${name} account to put a passkey on.`);
    return sv;
  }
  function approvalFor(s, rid) {
    const sv = services(s).find((x) => x.accounts.pendingFor(x.account).some((r) => r.id === rid));
    if (!sv) throw new HttpError(403, 'not_yours', 'That request is not for you.');
    return sv.accounts;
  }

  const eventBySeq = (seq) => ledger.items.find((e) => e.seq === Number(seq));
  /** A shopkeeper is the relying party, so sees its own customers' cards in full; everyone else sees what's public. */
  const cardFor = (s, e) => (e.card && !(e.owner === s?.id) && !(s?.role === 'shopkeeper' && s.claim === e.placeId) ? places.publicCard(e.card) : e.card);
  const evidenceOf = (card) => ({ ppid: card.ppid, registry: card.registry, sealed_ref: card.sealed_ref, rp: places.places[card.placeId]?.rp.id, place: card.place });
  const summarize = (e, s) => ({ seq: e.seq, at: e.at, text: e.text, tone: e.tone, decision: e.decision, classification: e.classification, badge: e.badge ?? null, card: cardFor(s, e) });
  const lawView = () => ({
    ...places.law(),
    regimes: Object.entries(REGIMES).map(([id, r]) => ({ id, name: r.name, blurb: r.blurb })),
    scoreboard: places.scoreboard(),
    presets: Object.entries(ADOPTION_PRESETS).map(([id, p]) => ({ id, ...p })),
  });

  // ---- What each role sees ------------------------------------------------------

  async function state(s) {
    const me = { id: s.id, role: s.role, name: s.name, claim: s.claim, claimName: s.claim ? PLACE_DEFS[s.claim]?.name ?? HOUSES[s.claim] : null };
    if (s.player) return { me, ...(await s.player.state()) };
    if (s.role === 'shopkeeper') {
      const place = places.places[s.claim];
      return {
        me,
        place: {
          id: s.claim, name: place.name, summary: places.describePolicy(place), lines: places.policyLines(place), asks: places.asks(place),
          adoption: place.adoption, effective: places.adoptionOf(place), jurisdiction: place.jurisdiction, sector: place.sector, kind: place.kind,
          policy: { accepts: place.policy.accepts, aaf: place.policy.aaf, age: Boolean(place.policy.age), worldid: Boolean(place.policy.worldid), x402: place.policy.x402, people: place.policy.people, budget: Boolean(place.policy.budget), facts: place.policy.facts ?? [] },
        },
        adoptions: Object.entries(ADOPTION).map(([id, a]) => ({ id, ...a })),
        peoples: Object.entries(PEOPLE).map(([id, a]) => ({ id, ...a })),
        registries: world.registries.map((r) => ({ id: r.id, name: r.name })),
        customers: ledger.items.filter((e) => e.kind === 'check' && e.placeId === s.claim).slice(-25).reverse().map((e) => summarize(e, s)),
        stats: places.scoreboard().rows.find((r) => r.id === s.claim) ?? null,
        market: s.claim === 'exchange' ? places.market() : null,
      };
    }
    if (s.role === 'homeowner') {
      return {
        me,
        home: { passkey: (accounts.get(s.claim)?.passkeys.size ?? 0) > 0 },
        door: ledger.items.filter((e) => e.kind === 'check' && e.card?.account === s.claim).slice(-25).reverse().map((e) => summarize(e, s)),
        phone: { approvals: accounts.pendingFor(s.claim).map(({ id, purpose, details }) => ({ request_id: id, purpose, details, service: 'door' })), incidents: [] },
      };
    }
    if (s.role === 'council') return { me, law: lawView() };
    return { me, cases: justice.cases().slice().reverse(), petitions: justice.petitions().slice().reverse(), lawful: { police: ofRole('police').length, judge: ofRole('judge').length } };
  }

  /** Tell the town what a change did: the rails stay the same, places' questions change. */
  const announce = (s, what, changed, placeId) => emit({
    kind: 'policy', tone: 'info', owner: s?.id ?? null, placeId: placeId ?? null,
    text: `${what}. Registries and record keepers unchanged; ${changed.length ? `${changed.length} place${changed.length === 1 ? '' : 's'} now ask${changed.length === 1 ? 's' : ''} for something different: ${changed.join(', ')}` : 'no place asks for anything different'}`,
  });

  // ---- What each role can do ------------------------------------------------------

  const ROLE_ACTIONS = {
    shopkeeper: {
      'shop.policy': (s, { patch }) => {
        const res = places.setPolicy(s.claim, patch ?? {});
        emit({ kind: 'policy', place: res.place, placeId: s.claim, tone: 'info', owner: s.id, text: `${s.name} set ${res.place} to ask for: ${res.policy}` });
        return { type: 'toggle', policy: res.policy };
      },
      'shop.adoption': (s, { mode }) => {
        const res = places.setAdoption(s.claim, mode);
        emit({ kind: 'policy', place: res.place, placeId: s.claim, tone: 'info', owner: s.id, text: `${res.place} ${{ full: 'now checks badges', pilot: 'is piloting badges: optional for small orders', none: 'stopped checking badges', block: 'now turns away anything that says it is an agent' }[mode]}${res.mandated ? ' (but the law still makes it check badges)' : ''}` });
        return { type: 'toggle', adoption: res.adoption, policy: res.policy };
      },
      'shop.report': async (s, { seq }) => {
        const e = eventBySeq(seq);
        if (!e?.card || e.placeId !== s.claim) throw new HttpError(404, 'no_visit', 'That was not a visit to your place.');
        await places.report(s.claim, e.card, `${PLACE_DEFS[s.claim].name} reports misconduct by this agent`);
        emit({ kind: 'incident', place: e.card.place, placeId: s.claim, tone: 'warn', owner: s.id, text: `${s.name} reported ${e.card.actor} to the registry that issued its badge; the registry tells its principal` });
        return { type: 'service', place: e.card.place, title: 'Reported', decision: 'allow', story: `The registry that issued ${e.card.actor}'s badge will tell whoever stands behind it. You still don't learn who that is.` };
      },
    },
    homeowner: {
      'door.locks': (s) => {
        accounts.get(s.claim).tokens.clear();
        keys[s.claim] = accounts.issueToken(s.claim);
        emit({ kind: 'info', placeId: s.claim, tone: 'info', owner: s.id, text: `${s.name} changed the locks: every old key to ${HOUSES[s.claim]} is dead` });
        return { type: 'service', place: HOUSES[s.claim], title: 'Locks changed', decision: 'allow', story: 'Every old key (bearer token) to your door is dead, lost ones included. Agents you approved with your passkey still get in.' };
      },
      'door.report': async (s, { seq }) => {
        const e = eventBySeq(seq);
        if (!e?.card || e.card.account !== s.claim) throw new HttpError(404, 'no_visit', 'That was not a visit to your door.');
        await places.report('hearth', e.card, `A homeowner reports this agent's visit to ${HOUSES[s.claim]}`);
        return { type: 'service', place: HOUSES[s.claim], title: 'Reported', decision: 'allow', story: `The registry that issued ${e.card.actor}'s badge will tell whoever stands behind it.` };
      },
    },
    police: {
      'case.open': (s, { seq }) => {
        const e = eventBySeq(seq);
        if (!e?.card?.ppid) throw new HttpError(409, 'no_badge', 'There is no badge in that record to investigate.');
        const c = justice.fileCase({ kind: 'investigation', placeId: e.card.placeId, title: `Investigation: ${e.card.actor} at ${e.card.place}`, evidence: [evidenceOf(e.card)], by: s.name, owner: s.id });
        return { type: 'service', place: 'Police Station', title: `Case ${c.id}`, decision: 'allow', story: `Case **${c.id}** is open. Ask the court to identify who stands behind the badge.` };
      },
      'case.petition': (s, { case: caseId, kind }) => {
        const p = justice.petition(caseId, kind, s.name, s.id);
        return { type: 'service', place: 'Courthouse', title: 'Petition filed', decision: 'allow', story: `Petition ${p.id} is before the court${ofRole('judge').length ? '. A judge will rule.' : '; the simulated judge will rule shortly.'}` };
      },
    },
    council: {
      'law.set': (s, { jurisdiction, regime, on }) => {
        if (!REGIMES[regime]) throw new HttpError(404, 'unknown_regime', `no regime ${regime}`);
        const res = places.setLaw(jurisdiction, regime, Boolean(on));
        announce(s, `${s.name} ${on ? 'switched on' : 'repealed'} ${REGIMES[regime].name} in ${res.jurisdiction}`, res.changed);
        return { type: 'service', place: 'Town Council', keeper: { face: '🏛️', who: 'Town Council' }, title: on ? `${REGIMES[regime].name}: in force` : `${REGIMES[regime].name}: repealed`, decision: 'allow', story: `${REGIMES[regime].blurb}\n\n**Registries, record keepers and badges: unchanged.** ${res.changed.length ? `${res.changed.length} place${res.changed.length === 1 ? '' : 's'} now ask${res.changed.length === 1 ? 's' : ''} for something different: ${res.changed.join(', ')}.` : 'No place asks for anything different.'}`, changed: res.changed };
      },
      'adoption.preset': (s, { preset }) => {
        const res = places.presetAdoption(preset);
        announce(s, `${s.name} set the town to "${res.preset}"`, res.changed);
        return { type: 'toggle', changed: res.changed };
      },
    },
    judge: {
      'petition.rule': async (s, { petition, grant }) => {
        const p = await justice.rule(petition, { grant: Boolean(grant), by: `Judge ${s.name}`, owner: s.id });
        return { type: 'service', place: 'Courthouse', title: grant ? 'Order issued' : 'Petition denied', decision: grant ? 'allow' : 'info', story: grant ? `Your order in case ${p.case} has been carried out.` : 'Denied.' };
      },
    },
  };

  /** Anyone may complain to the police about a visit they saw at their place or door. */
  const COMMON = {
    'police.file': (s, { seq }) => {
      const e = eventBySeq(seq);
      if (!e?.card?.ppid) throw new HttpError(409, 'no_badge', 'There is no badge in that record: nobody to trace.');
      const c = justice.fileCase({ kind: 'complaint', placeId: e.card.placeId, title: `Complaint from ${s.name} about ${e.card.actor} at ${e.card.place}`, evidence: [evidenceOf(e.card)], by: s.name, owner: s.id });
      return { type: 'service', place: 'Police Station', title: `Case ${c.id} opened`, decision: 'allow', story: `The police have opened case **${c.id}**. They can ask the court to say who stands behind that badge.` };
    },
    'id.ask': async (s, { npc }) => {
      const them = lookup(npc);
      if (!them) throw new HttpError(404, 'gone', 'They have left.');
      const card = await places.visit('reader', 'id.check', {}, them);
      return { ...card, title: `${them.name}'s badge`, place: 'Your badge reader' };
    },
  };

  /** The ledger as one person may see it: names shared with a place stay with that place. */
  const visibleEvents = (s, events) => events.map((e) => (e.card ? { ...e, card: cardFor(s, e) } : e));

  async function run(s, action, params = {}) {
    if (s.player) return s.player.run(action, params);
    const fn = ROLE_ACTIONS[s.role]?.[action] ?? COMMON[action];
    if (!fn) throw new HttpError(404, 'unknown_action', `A ${s.role} can't do ${action}.`);
    return fn(s, params);
  }

  function actions(s, npcOptions) {
    if (s.player) return s.player.catalog();
    return [{ id: 'id.ask', key: 'id.ask', group: 'You', icon: '🔍', label: 'Ask someone to show their badge', hint: 'Your own badge reader', params: [{ key: 'npc', label: 'Whom?', options: npcOptions }] }];
  }

  return {
    join, leave, get, state, run, actions, serviceFor, approvalFor, lookup, visibleEvents, announce, lawView,
    roles: () => ({
      roles: Object.entries(ROLES).map(([id, r]) => ({ id, ...r, taken: id === 'judge' && ofRole('judge').length > 0 })),
      shops: Object.entries(PLACE_DEFS).map(([id, d]) => ({ id, name: d.name, taken: Boolean(holder(id)) })),
      houses: Object.entries(HOUSES).map(([id, name]) => ({ id, name, taken: Boolean(holder(id)) })),
    }),
    counts: () => ({ police: ofRole('police').length, judge: ofRole('judge').length }),
    /** Everyone playing, as others see them. A resident is just "a resident", never their name; their agent follows them. */
    people() {
      return [...sessions.values()].filter((s) => s.pos).flatMap((s) => {
        if (!s.player) return [{ id: s.id, role: s.role, name: s.name, principal: s.name, pos: s.pos, claim: s.claim, look: PERSON_LOOKS[s.role] }];
        const a = s.player.appearance();
        return [
          { id: s.id, role: 'agent', name: 'a resident', principal: null, pos: s.pos, claim: null, look: RESIDENT_LOOK },
          ...(a.agent ? [{ id: `${s.id}-agent`, role: 'companion', name: a.agent, owner: s.id, follow: true, principal: null, pos: s.pos, look: { body: '#fff1d6', bulb: a.badge ? '#5fd38a' : '#f2c14e', glow: a.badge, badge: a.badge ? 'on' : 'none', revoked: a.revoked } }] : []),
        ];
      });
    },
    setPos(s, pos) {
      if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
        s.pos = { x: pos.x, y: pos.y };
        s.player?.setPos(s.pos);
      }
    },
    stop: () => clearInterval(sweep),
    get size() {
      return sessions.size;
    },
  };
}
