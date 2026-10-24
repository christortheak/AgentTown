// The people playing. Each browser tab that joins gets a session and a role:
//   agent       a principal and their agent, law-abiding or not, with a home of their own
//   shopkeeper  runs one place: sets its policy, sees every customer's ID check, reports them
//   homeowner   owns a house in Hearthside: a passkey on the door, decides who comes in
//   police      investigates cases and petitions the court
//   judge       rules on petitions: identify, delete agents, ban principals
// A session that goes quiet for a few minutes is let go, with whatever it held.
// Anyone can come back with a new session, under any name; a banned identity
// just won't be verified again.
import crypto from 'node:crypto';
import { HttpError } from 'aaf-reference/src/lib/http.js';
import { createPlayer } from './player.js';
import { PLACE_DEFS, HOUSES } from './places.js';

const IDLE_MS = 4 * 60 * 1000;

export const ROLES = {
  agent: { icon: '🤖', label: 'An agent', blurb: 'You are the principal; your agent walks the town. Shop, trade, spawn sub-agents. Play it straight, or try to get away with something.' },
  shopkeeper: { icon: '🏪', label: 'A shopkeeper', blurb: 'Run a shop, the bank, the exchange or the toll: decide which registries you trust and what you ask for, and see exactly what each customer proves.' },
  homeowner: { icon: '🏡', label: 'A homeowner', blurb: 'Put a passkey on your door and decide, on your phone, which agents come in.' },
  police: { icon: '👮', label: 'Police', blurb: 'Investigate fraud and rogue agents from the cases places report, and take them to court.' },
  judge: { icon: '⚖️', label: 'The judge', blurb: 'Rule on petitions: order a registry to identify a principal, delete rogue agents, ban a principal.' },
};

const PERSON_LOOKS = {
  shopkeeper: { body: '#ffe1a8', bulb: null, badge: 'none', feet: '#7a5a3a' },
  homeowner: { body: '#d7f0ff', bulb: null, badge: 'none', feet: '#5a6a7a' },
  police: { body: '#c9d6ff', bulb: '#4f7fbf', glow: true, badge: 'on', badgeColor: '#ffe08a', badgeMark: '#2c3e66', feet: '#2c3e66' },
  judge: { body: '#3b3346', bulb: null, badge: 'none', feet: '#22202a' },
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
    emit({ kind: 'people', tone: 'info', owner: id, text: role === 'agent' ? 'Someone new joined as an agent' : `${display} joined as ${ROLES[role].label.toLowerCase()}${where}` });
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
    emit({ kind: 'people', tone: 'info', text: s.role === 'agent' ? 'An agent player left town' : `${s.name} left town` });
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

  /** The home account a session's passkey and approvals belong to. */
  function accountOf(s) {
    if (s.player) return s.player.account;
    if (s.role === 'homeowner') return s.claim;
    throw new HttpError(409, 'no_home', 'Only agents and homeowners have a front door.');
  }

  const eventBySeq = (seq) => ledger.items.find((e) => e.seq === Number(seq));
  const evidenceOf = (card) => ({ ppid: card.ppid, registry: card.registry, sealed_ref: card.sealed_ref, rp: places.places[card.placeId]?.rp.id, place: card.place });
  const summarize = (e) => ({ seq: e.seq, at: e.at, text: e.text, tone: e.tone, decision: e.decision, classification: e.classification, card: e.card });

  // ---- What each role sees ------------------------------------------------------

  async function state(s) {
    const me = { id: s.id, role: s.role, name: s.name, claim: s.claim, claimName: s.claim ? PLACE_DEFS[s.claim]?.name ?? HOUSES[s.claim] : null };
    if (s.player) return { me, ...(await s.player.state()) };
    if (s.role === 'shopkeeper') {
      const place = places.places[s.claim];
      return {
        me,
        place: { id: s.claim, name: place.name, summary: places.describePolicy(place), policy: { accepts: place.policy.accepts, aaf: place.policy.aaf, worldid: Boolean(place.policy.worldid), x402: place.policy.x402 } },
        registries: world.registries.map((r) => ({ id: r.id, name: r.name })),
        customers: ledger.items.filter((e) => e.kind === 'check' && e.placeId === s.claim).slice(-25).reverse().map(summarize),
        market: s.claim === 'exchange' ? places.market() : null,
      };
    }
    if (s.role === 'homeowner') {
      return {
        me,
        home: { passkey: (accounts.get(s.claim)?.passkeys.size ?? 0) > 0 },
        door: ledger.items.filter((e) => e.kind === 'check' && e.card?.account === s.claim).slice(-25).reverse().map(summarize),
        phone: { approvals: accounts.pendingFor(s.claim).map(({ id, purpose, details }) => ({ request_id: id, purpose, details })), incidents: [] },
      };
    }
    return { me, cases: justice.cases().slice().reverse(), petitions: justice.petitions().slice().reverse(), lawful: { police: ofRole('police').length, judge: ofRole('judge').length } };
  }

  // ---- What each role can do ------------------------------------------------------

  const ROLE_ACTIONS = {
    shopkeeper: {
      'shop.policy': (s, { patch }) => {
        const res = places.setPolicy(s.claim, patch ?? {});
        emit({ kind: 'policy', place: res.place, placeId: s.claim, tone: 'info', owner: s.id, text: `${s.name} set ${res.place} to ask for: ${res.policy}` });
        return { type: 'toggle', policy: res.policy };
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
    join, leave, get, state, run, actions, accountOf, lookup,
    roles: () => ({
      roles: Object.entries(ROLES).map(([id, r]) => ({ id, ...r, taken: id === 'judge' && ofRole('judge').length > 0 })),
      shops: Object.entries(PLACE_DEFS).map(([id, d]) => ({ id, name: d.name, taken: Boolean(holder(id)) })),
      houses: Object.entries(HOUSES).map(([id, name]) => ({ id, name, taken: Boolean(holder(id)) })),
    }),
    counts: () => ({ police: ofRole('police').length, judge: ofRole('judge').length }),
    /** Everyone playing, as others see them. */
    people() {
      return [...sessions.values()].filter((s) => s.pos).map((s) => {
        const a = s.player?.appearance();
        return {
          id: s.id, role: s.role, name: a?.name ?? s.name, principal: s.player ? null : s.name, pos: s.pos, claim: s.claim,
          look: s.player ? { body: '#fff1d6', bulb: a.badge ? '#5fd38a' : '#f2c14e', glow: a.badge, badge: a.badge ? 'on' : 'none', revoked: a.revoked } : PERSON_LOOKS[s.role],
        };
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
