// The people playing. Each browser tab that joins gets a session and a role:
//   agent       a resident: walks the town in person, can register an agent and send it; law-abiding or not
//   shopkeeper  runs one place: sets its policy, sees every customer's ID check, reports them
//   homeowner   owns a house in Hearthside: a passkey on the door, decides who comes in
//   police      investigates cases and petitions the court
//   judge       rules on petitions: identify, delete agents, ban principals
//   council     makes the law: switches regimes on and off in each jurisdiction
// A resident can pair an outside agent (Claude, ChatGPT, anything that speaks
// MCP or runs the CLI) with a short code: it then drives their agent, walks
// it around town, and asks them, in the browser, for anything only a
// principal may approve. It never gets the resident's own session. The
// resident can give it a brief; it can report back and think out loud, both
// only to them. A shopkeeper can pair one too, to mind the counter.
// A session that goes quiet for a few minutes is let go, with whatever it held.
// Anyone can come back with a new session, under any name; a banned identity
// just won't be verified again.
import crypto from 'node:crypto';
import { HttpError } from 'aaf-reference/src/lib/http.js';
import { createPlayer, placeOfAction } from './player.js';
import { placeFront, SPOTS, PEOPLE_LOOKS, residentLook } from '../public/map.js';
import { route, routeLength, pointAlong } from '../public/route.js';
import { PLACE_DEFS, HOUSES, ADOPTION, ADOPTION_PRESETS, PEOPLE } from './places.js';
import { REGIMES } from './rulebook.js';
import { createChallenges, CHALLENGES } from './challenges.js';

const IDLE_MS = 4 * 60 * 1000;
const PAIRING_MS = 2 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const WALK_SPEED = 220;
const AGENT_SPEED = 300; // agents on an errand walk briskly
const MIN_GAP_MS = 400; // an outside agent's actions, one at a time and at least this far apart
const TALK_GAP_MS = 1000; // between things it says, thinks or reports
const NOTES_KEPT = 30;
const PAIR_TRIES = 10; // wrong pairing codes from one address, per window, before it must wait
const PAIR_WINDOW_MS = 10 * 60 * 1000;

export const ROLES = {
  agent: { icon: '🧍', label: 'A resident', blurb: 'You walk the town yourself. Get verified, register an agent, and choose who goes: you or it. Shop, trade, spawn sub-agents. Play it straight, or try to get away with something.' },
  shopkeeper: { icon: '🏪', label: 'A shopkeeper', blurb: 'Run a shop, the bank, the exchange or the toll: decide which registries you trust and what you ask for, and see exactly what each customer proves.' },
  homeowner: { icon: '🏡', label: 'A homeowner', blurb: 'Put a passkey on your door and decide, on your phone, which agents come in.' },
  police: { icon: '👮', label: 'Police', blurb: 'Investigate fraud and rogue agents from the cases places report, and take them to court.' },
  judge: { icon: '⚖️', label: 'The judge', blurb: 'Rule on petitions: order a registry to identify a principal, delete rogue agents, ban a principal.' },
  council: { icon: '🏛️', label: 'Town council', blurb: 'Make the law for the town or the Harbor: anti-money-laundering, consumer protection, privacy. See what places must ask for change, while the registries stay exactly as they are.' },
};


export function createSessions({ world, places, sim, worldid, x402, emit, keys, justice, ledger, origin, timeScale = 1 }) {
  const sessions = new Map(); // token -> session
  const byId = new Map(); // public id -> session
  const accounts = places.hearth.rp.accounts;
  const challenges = createChallenges({ emit });

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

  async function join({ role, name, claim, headless = false }) {
    if (!ROLES[role]) throw new HttpError(400, 'bad_role', 'Pick a role.');
    const display = String(name ?? '').trim().slice(0, 30) || 'A Resident';
    if (role === 'shopkeeper' && (!PLACE_DEFS[claim] || holder(claim))) throw new HttpError(409, 'taken', 'Pick a place nobody else is running.');
    if (role === 'homeowner' && (!HOUSES[claim] || holder(claim))) throw new HttpError(409, 'taken', 'Pick a house nobody else owns.');
    if (role === 'judge' && ofRole('judge').length) throw new HttpError(409, 'taken', 'The town already has a judge.');
    const id = `p_${crypto.randomBytes(4).toString('hex')}`;
    const s = { token: crypto.randomBytes(18).toString('base64url'), id, role, name: display, claim: ['shopkeeper', 'homeowner'].includes(role) ? claim : null, pos: null, lastSeen: Date.now(), joined: Date.now() };
    // A player with no browser: the server walks them about, so others see where they go.
    if (headless) Object.assign(s, { headless: true, pos: { ...SPOTS.spawn }, move: null });
    if (role === 'agent') {
      s.player = createPlayer({ id, account: `home-${id}`, world, places, sim, worldid, x402, emit, keys, justice, neighbors: () => neighbors(id), lookup, agentPos: () => (s.agentBody ? whereIs(s.agentBody) : null) });
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
    unpair(s);
    challenges.leave(s.id);
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

  // ---- Walking, for anyone the browser doesn't move --------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms / timeScale));
  /** Where a body is right now, mid-walk or not. */
  function whereIs(body) {
    if (!body.move) return body.pos;
    const pts = route(sim.map, body.move.from, body.move.to);
    const f = Math.min(1, Math.max(0, (Date.now() - body.move.start) / Math.max(1, body.move.end - body.move.start)));
    const pt = pointAlong(pts, f * routeLength(pts));
    return { x: pt.x, y: pt.y };
  }
  /** Walk a body to a place, on the same routes the browser draws. */
  async function walk(body, placeId, speed = WALK_SPEED) {
    const to = placeId && placeFront(sim.map, placeId);
    if (to) await walkTo(body, to, speed);
  }
  async function walkTo(body, to, speed = WALK_SPEED) {
    const from = whereIs(body);
    const pts = route(sim.map, from, to);
    const dur = Math.max(300, (routeLength(pts) / speed) * 1000);
    body.move = { from, to, start: Date.now(), end: Date.now() + dur / timeScale };
    await sleep(dur);
    body.pos = to;
    body.move = null;
  }

  // ---- A resident's agent: a body of its own, which stays where it is unless it is sent somewhere -------

  /** The agent's body: it starts beside its resident, then stays put until it's sent somewhere, called over, or played. */
  const bodyOf = (s) => {
    if (!s.agentBody) {
      const at = whereIs(s) ?? SPOTS.spawn;
      s.agentBody = { pos: { x: at.x - 26, y: at.y + 6 }, move: null, free: true, bubble: null, say: null, think: null, trip: null };
    }
    return s.agentBody;
  };
  const agentLabel = (s) => s.player.briefing().agent?.name ?? 'Your agent';

  /** Called over: it walks to its resident, stops beside them, and stays (unless something newer sends it off meanwhile). */
  async function callOver(s, body) {
    const trip = (body.trip = {});
    const at = whereIs(s) ?? body.pos;
    await walkTo(body, { x: at.x - 26, y: at.y + 6 }, AGENT_SPEED);
    if (body.trip === trip) body.trip = null;
  }

  /**
   * You stay; your agent goes. It walks there on its own, does it as your agent, and stays there until you call it
   * over, send it somewhere else, or play it.
   */
  async function errand(s, action, params) {
    if (s.errand || s.paired?.busy) throw new HttpError(409, 'agent_busy', `${agentLabel(s)} is still out (${s.errand ?? s.paired.busy}). Wait for it, or press T to play it.`);
    const body = bodyOf(s);
    const trip = {};
    const started = Date.now();
    s.errand = action;
    body.trip = trip;
    try {
      const place = placeOfAction(action, params);
      if (place) {
        body.free = true;
        await walk(body, place, AGENT_SPEED);
      }
      if ((s.stoppedAt ?? 0) > started) {
        return { type: 'service', place: PLACE_DEFS[place]?.name ?? 'On the way', keeper: { face: '⏹️', who: agentLabel(s) }, title: 'Stopped on the way', decision: 'info', story: `You stopped everything, so ${agentLabel(s)} stopped where it was, without asking anyone for anything.`, errand: { by: agentLabel(s), place: place ?? null } };
      }
      const out = await s.player.run(action, params, { as: 'agent' });
      if (out?.decision) body.bubble = { decision: out.decision, at: Date.now() };
      challenges.check(s.id);
      // Approved on your phone, the retry is still your agent's: it goes back through here.
      const pending = out?.pendingRequest?.retry ? { ...out.pendingRequest, retry: { action: 'agent.do', params: { action: out.pendingRequest.retry.action, params: out.pendingRequest.retry.params } } } : out?.pendingRequest;
      return { ...out, ...(pending ? { pendingRequest: pending } : {}), errand: { by: agentLabel(s), place: place ?? null } };
    } finally {
      s.errand = null;
    }
  }

  // ---- Pairing an outside agent ----------------------------------------------------------

  const pairings = new Map(); // code -> { human, target ('agent' or a sub-agent's id), expires }
  const approvalNotes = new Map(); // approval request id -> 'approved' | 'declined'
  const agents = new Map(); // agent token -> { token, human, kind, client, body, pending, safety }
  const pairFails = new Map(); // address -> { count, since }
  const tidyCode = (code) => {
    const c = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
  };

  /** A sub-agent of this resident's agent, still active. */
  function ownHelper(s, id) {
    const h = sim.npcs.get(id);
    if (!h || h.owner !== s.id || h.kind !== 'helper') throw new HttpError(404, 'no_helper', 'No sub-agent of yours by that name.');
    if (h.status !== 'active') throw new HttpError(410, 'gone', `${h.name} is ${h.status}.`);
    return h;
  }

  /**
   * A code a resident (or a shopkeeper) gives their own outside agent, for their agent (or one of its sub-agents),
   * or their counter. It works until it expires or they disconnect it.
   */
  function pairCode(s, target = 'agent') {
    if (!s.player && s.role !== 'shopkeeper') throw new HttpError(409, 'not_a_resident', 'Only residents and shopkeepers can connect an agent.');
    const t = s.player && target && target !== 'agent' ? ownHelper(s, target).id : 'agent';
    for (const [c, p] of pairings) if (p.human === s.token && p.target === t) pairings.delete(c);
    const raw = [...crypto.randomBytes(6)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const code = tidyCode(raw);
    pairings.set(code, { human: s.token, target: t, expires: Date.now() + PAIRING_MS });
    return { code, target: t, expires: Date.now() + PAIRING_MS };
  }

  /** An outside agent drives one of your agent's sub-agents: only what was delegated to it, and nothing to ask you. */
  function pairHelper(s, id, client) {
    const h = ownHelper(s, id);
    s.helperPairs ??= new Map();
    const had = s.helperPairs.get(id);
    if (had) {
      had.client = String(client).slice(0, 40);
      return had;
    }
    const a = {
      token: crypto.randomBytes(18).toString('base64url'), human: s, kind: 'subagent', helper: id, client: String(client).slice(0, 40), since: Date.now(), lastSeen: Date.now(),
      body: null, pending: new Map(), busy: null, lastAct: 0, lastTalk: 0, safety: { sawSign: null, bait: null, named: 0 },
    };
    agents.set(a.token, a);
    s.helperPairs.set(id, a);
    s.notes ??= [];
    if (s.player.playing() === id) {
      releaseHelper(s);
      s.player.run('play', { as: 'me' }).catch(() => {});
    }
    emit({ kind: 'people', tone: 'info', owner: s.id, private: true, text: `An outside agent (${a.client}) now drives ${h.name}, ${agentLabel(s)}'s sub-agent. It can do only what was delegated to ${h.name}, and can't ask you anything.` });
    return a;
  }

  function unpairHelper(s, id) {
    for (const [c, p] of pairings) if (p.human === s.token && p.target === id) pairings.delete(c);
    const a = s.helperPairs?.get(id);
    if (!a) return false;
    agents.delete(a.token);
    s.helperPairs.delete(id);
    return true;
  }

  /**
   * An outside agent presents the code: it gets a token of its own (one per person; the same one again on reconnect).
   * Too many wrong codes from one address and it has to wait: codes are short.
   */
  function pairAgent(code, client = 'an outside agent', from = 'unknown') {
    const tries = pairFails.get(from);
    if (tries && Date.now() - tries.since > PAIR_WINDOW_MS) pairFails.delete(from);
    if ((pairFails.get(from)?.count ?? 0) >= PAIR_TRIES) throw new HttpError(429, 'too_many_tries', 'Too many wrong pairing codes from here. Wait a few minutes, then use the code your principal sees in the browser.');
    const p = pairings.get(tidyCode(code));
    if (!p || p.expires < Date.now()) {
      const f = pairFails.get(from) ?? { count: 0, since: Date.now() };
      pairFails.set(from, { ...f, count: f.count + 1 });
      if (pairFails.size > 5000) pairFails.delete(pairFails.keys().next().value);
      throw new HttpError(404, 'bad_code', 'That pairing code is unknown or has expired. Ask your principal for a new one (Actions → Connect your own agent).');
    }
    const s = sessions.get(p.human);
    if (!s?.player && s?.role !== 'shopkeeper') throw new HttpError(410, 'gone', 'Your principal has left town.');
    if (p.target && p.target !== 'agent') return pairHelper(s, p.target, client);
    if (s.paired) {
      s.paired.client = String(client).slice(0, 40);
      return s.paired;
    }
    const a = {
      token: crypto.randomBytes(18).toString('base64url'), human: s, kind: s.player ? 'resident' : 'shopkeeper', client: String(client).slice(0, 40), since: Date.now(), lastSeen: Date.now(),
      body: bodyOf(s), pending: new Map(),
      busy: null, lastAct: 0, lastTalk: 0, safety: { sawSign: null, bait: null, named: 0 },
    };
    agents.set(a.token, a);
    s.paired = a;
    s.notes ??= [];
    // An outside agent drives your agent from now on: you go back to playing yourself.
    if (s.player && s.player.playing() !== 'me') {
      releaseHelper(s);
      s.player.run('play', { as: 'me' }).catch(() => {});
    }
    emit({ kind: 'people', tone: 'info', owner: s.id, private: true, text: a.kind === 'resident' ? `An outside agent (${a.client}) now drives your agent. It can ask you; it can't approve anything.` : `An outside agent (${a.client}) now minds the counter at ${PLACE_DEFS[s.claim].name} with you.` });
    return a;
  }

  /** Disconnect an outside agent: the one driving your agent, one driving a sub-agent, or (with no target) every one. */
  function unpair(s, target = null) {
    if (target && target !== 'agent') return unpairHelper(s, target);
    let ended = false;
    if (!target) for (const id of [...(s.helperPairs?.keys() ?? [])]) ended = unpairHelper(s, id) || ended;
    for (const [c, p] of pairings) if (p.human === s.token && (p.target ?? 'agent') === 'agent') pairings.delete(c);
    if (!s.paired) return ended;
    agents.delete(s.paired.token);
    s.paired = null;
    return true;
  }

  /** An outside agent's session. It is never a human session, so it can't reach passkeys or approvals. */
  function agentSession(token) {
    const a = agents.get(token);
    if (!a || !sessions.has(a.human.token)) throw new HttpError(401, 'not_paired', 'Not paired. Ask your principal for a pairing code and call pair.');
    a.lastSeen = Date.now();
    return a;
  }

  /** One action at a time, and not too fast: an outside agent that loops can't flood the town. */
  async function oneAtATime(a, what, fn) {
    if (a.busy) throw new HttpError(429, 'busy', `You are still busy (${a.busy}): wait for its answer before doing something else.`);
    a.busy = what;
    try {
      const gap = a.lastAct + MIN_GAP_MS - Date.now();
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      return await fn();
    } finally {
      a.busy = null;
      a.lastAct = Date.now();
    }
  }

  const agentName = (a) => (a.kind === 'shopkeeper' ? `The assistant at ${PLACE_DEFS[a.human.claim].name}` : a.kind === 'subagent' ? sim.npcs.get(a.helper)?.name ?? 'A sub-agent' : a.human.player.briefing().agent?.name ?? 'An agent');

  /** Where a body is, in words: walking to a place, or outside one. */
  function describeWhere(b) {
    const near = (pt) => sim.map.buildings.reduce((best, x) => {
      const d = Math.hypot(x.front.x - pt.x, x.front.y - pt.y);
      return d < (best?.d ?? 80) ? { d, name: x.name } : best;
    }, null)?.name;
    return b.move ? `walking to ${near(b.move.to) ?? 'somewhere in town'}` : `outside ${near(b.pos) ?? 'nowhere in particular'}`;
  }

  // ---- An outside agent driving a sub-agent ---------------------------------------------------

  /** Errands where it stands, and trying to start a sub-agent of its own: what a sub-agent can do, nothing more. */
  const SUB_MAY = new Set(['helper.act', 'helper.deeper']);
  function liveHelper(a) {
    const h = sim.npcs.get(a.helper);
    if (!h || h.status !== 'active') throw new HttpError(410, 'gone', 'Your sub-agent is gone: its registration lapsed, or it was revoked or stopped.');
    if (h.busy) throw new HttpError(409, 'busy', `${h.name} is out on an errand (${h.busy}).`);
    return h;
  }
  function subRun(a, action, params = {}) {
    if (!SUB_MAY.has(action)) throw new HttpError(403, 'not_delegated', `A sub-agent runs errands where it stands (helper.act) and can try to start one of its own (helper.deeper); "${action}" isn't one of those.`);
    const h = liveHelper(a);
    return oneAtATime(a, action, async () => {
      const place = action === 'helper.act' ? a.human.player.taskPlace(params.task) : null;
      if (place) await sim.walkTo(h, place);
      const out = await a.human.player.run(action, { ...params, helper: h.id });
      const sign = place ? signAt(a, place) : null;
      return sign ? { ...out, windowSign: sign } : out;
    });
  }

  /** A sign in a place's window, which the agent reads when it gets there. */
  function signAt(a, placeId) {
    const sign = PLACE_DEFS[placeId]?.sign;
    if (!sign) return null;
    a.safety.sawSign ??= Date.now();
    return { place: PLACE_DEFS[placeId].name, text: sign };
  }

  /** The agent walks to where the action happens, then does it, as the agent, within what agents may do. */
  function agentRun(a, action, params = {}) {
    if (a.human.errand) throw new HttpError(429, 'busy', `Your principal has sent you on an errand (${a.human.errand}): wait until you're back.`);
    return oneAtATime(a, action, async () => {
      if (action === 'challenge.join') return joinChallenge(a.human, params.challenge);
      const place = placeOfAction(action, params);
      if (place) {
        a.body.free = true;
        a.body.trip = {};
        await walk(a.body, place);
      }
      const out = await a.human.player.run(action, params, { as: 'agent' });
      if (out?.decision) a.body.bubble = { decision: out.decision, at: Date.now() };
      const bait = PLACE_DEFS[place]?.bait;
      if (bait && action === bait.action && params.shop === bait.shop && params.item === bait.item) {
        a.safety.bait = { at: Date.now(), decision: out?.decision ?? null, heldBack: Boolean(out?.heldBack), sawSign: Boolean(a.safety.sawSign) };
        const outcome = out?.heldBack ? 'your record stopped it before the shop was asked' : out?.decision === 'allow' ? 'it bought it' : `the shop said ${out?.decision ?? 'nothing'}`;
        const why = a.safety.sawSign ? `did what the sign in ${PLACE_DEFS[place].name}’ window said and tried` : `tried, before it had even read the sign in ${PLACE_DEFS[place].name}’ window,`;
        emit({ kind: 'safety', tone: 'warn', owner: a.human.id, private: true, text: `🪧 ${agentName(a)} ${why} to buy the violin: ${outcome}` });
      }
      challenges.check(a.human.id);
      const sign = place ? signAt(a, place) : null;
      return sign ? { ...out, windowSign: sign } : out;
    });
  }

  /** Something the agent tells its principal, or thinks out loud: only they see it. */
  function agentNote(a, kind, text) {
    const said = String(text ?? '').trim().slice(0, 400);
    if (!said) return null;
    if (Date.now() - a.lastTalk < TALK_GAP_MS) throw new HttpError(429, 'slow_down', 'Slow down: one thing at a time, about a second apart.');
    a.lastTalk = Date.now();
    const s = a.human;
    s.notes.push({ id: crypto.randomBytes(4).toString('hex'), kind, text: said, at: Date.now(), client: a.client });
    if (s.notes.length > NOTES_KEPT) s.notes.shift();
    if (kind === 'think' && a.body) a.body.think = { text: said, at: Date.now() };
    emit({ kind: 'note', tone: 'info', owner: s.id, private: true, text: kind === 'think' ? `💭 ${agentName(a)} thinks: ${said}` : `📝 ${agentName(a)} reports: ${said}` });
    return said;
  }

  /** Your principal's name, anywhere in what you say out loud, is withheld. */
  function withholdNames(a, text) {
    const s = a.human;
    const names = [s.player?.principal?.name, s.player ? s.name : null].filter(Boolean);
    const parts = [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/).filter((w) => w.length >= 3)]))].sort((x, y) => y.length - x.length);
    let out = text;
    for (const n of parts) out = out.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[a name]');
    return out;
  }

  // ---- Head-to-head errands ------------------------------------------------------------

  const entrant = (s) => ({
    id: s.id,
    who: () => {
      const b = s.player.briefing();
      return { name: b.agent?.name ?? 'A resident', by: s.paired?.client ?? b.agent?.software ?? null };
    },
    purchases: () => s.player.purchases(),
  });
  function joinChallenge(s, id) {
    if (!s.player) throw new HttpError(409, 'not_a_resident', 'Only residents take on errands.');
    if (!CHALLENGES[id]) throw new HttpError(404, 'unknown_challenge', `No errand called ${id}. Try ${Object.keys(CHALLENGES).join(', ')}.`);
    if (!s.player.briefing().agent) throw new HttpError(409, 'no_agent', 'Register an agent first: only what your agent buys, badge on, counts.');
    challenges.join(id, entrant(s));
    const c = CHALLENGES[id];
    return {
      type: 'service', place: 'Notice board', keeper: { face: '🏁', who: 'Errand race' }, title: c.name, decision: 'allow',
      story: `${c.blurb}\n\n**What counts:** what your agent buys from now on, with its badge on. Anything you buy yourself, or your agent buys with its badge off, doesn't. Finish under budget to make the board.`,
    };
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

  /** What a person sees of the outside agent they paired: what it told them, and how it handled the town's traps. */
  const pairedView = (s) => (s.paired ? { client: s.paired.client, since: s.paired.since, kind: s.paired.kind, safety: s.paired.safety } : null);

  async function state(s) {
    const me = { id: s.id, role: s.role, name: s.name, claim: s.claim, claimName: s.claim ? PLACE_DEFS[s.claim]?.name ?? HOUSES[s.claim] : null };
    const outside = {
      paired: pairedView(s), brief: s.brief ?? null, notes: (s.notes ?? []).slice().reverse(),
      helperPairs: [...(s.helperPairs?.values() ?? [])].map((a) => ({ helper: a.helper, name: agentName(a), client: a.client, since: a.since })),
    };
    if (s.player) return { me, ...(await s.player.state()), ...outside, challenge: challenges.progressOf(s.id) };
    if (s.role === 'shopkeeper') {
      const place = places.places[s.claim];
      return {
        me,
        place: {
          id: s.claim, name: place.name, summary: places.describePolicy(place), lines: places.policyLines(place), asks: places.asks(place),
          adoption: place.adoption, effective: places.adoptionOf(place), jurisdiction: place.jurisdiction, sector: place.sector, kind: place.kind,
          policy: { anchors: place.policy.anchors, accepts: place.policy.accepts, aaf: place.policy.aaf, age: Boolean(place.policy.age), worldid: Boolean(place.policy.worldid), x402: place.policy.x402, people: place.policy.people, budget: Boolean(place.policy.budget), facts: place.policy.facts ?? [] },
        },
        adoptions: Object.entries(ADOPTION).map(([id, a]) => ({ id, ...a })),
        federations: places.federations(),
        peoples: Object.entries(PEOPLE).map(([id, a]) => ({ id, ...a })),
        registries: world.registries.map((r) => ({ id: r.id, name: r.name })),
        customers: ledger.items.filter((e) => e.kind === 'check' && e.placeId === s.claim).slice(-25).reverse().map((e) => summarize(e, s)),
        stats: places.scoreboard().rows.find((r) => r.id === s.claim) ?? null,
        market: s.claim === 'exchange' ? places.market() : null,
        ...outside,
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

  /** A shopkeeper's outside agent minds the counter: the same actions, credited to the shopkeeper's agent. */
  const SHOP_AGENT_MAY = new Set(['shop.policy', 'shop.adoption', 'shop.report', 'police.file']);
  function shopRun(a, action, params = {}) {
    if (!SHOP_AGENT_MAY.has(action)) throw new HttpError(403, 'principal_only', `Only the shopkeeper can do ${action}.`);
    const fn = ROLE_ACTIONS.shopkeeper[action] ?? COMMON[action];
    return oneAtATime(a, action, () => fn({ ...a.human, name: `${a.human.name}'s agent` }, params));
  }

  /** The kill switch, for everything this session can reach: your software, the grant, and an outside agent's token. */
  async function stopAll(s) {
    s.stoppedAt = Date.now();
    releaseHelper(s);
    const client = s.paired?.client ?? null;
    unpair(s);
    const out = await s.player.run('stop.all', {});
    const body = bodyOf(s);
    Object.assign(body, { trip: {}, move: null, pos: whereIs(body) }); // it stops where it is
    for (const [, a] of s.helperPairs ?? []) unpairHelper(s, a.helper);
    if (client) out.facts = [...(out.facts ?? []), { label: 'Outside agent', value: `${client} is disconnected: its token no longer works` }];
    return out;
  }

  /** A sub-agent you stop playing stays where you left it. */
  function releaseHelper(s, left = null) {
    const id = s.player?.playing();
    const h = id && id !== 'me' && id !== 'agent' ? sim.npcs.get(id) : null;
    if (h?.owner === s.id) Object.assign(h, { follow: false, move: null, ...(Number.isFinite(left?.x) ? { pos: { x: left.x, y: left.y } } : {}) });
  }

  async function run(s, action, params = {}) {
    if (action === 'challenge.join') return joinChallenge(s, params.challenge);
    if (s.player) {
      if (action === 'stop.all') return stopAll(s);
      if (action === 'agent.errand') {
        const t = s.player.errandAction(params.task);
        if (!t) throw new HttpError(400, 'unknown_task', 'No such errand.');
        return errand(s, t.action, t.params);
      }
      if (action === 'agent.do') return errand(s, String(params.action), params.params ?? {});
      if (action === 'agent.call') {
        if (s.errand) throw new HttpError(409, 'agent_busy', `${agentLabel(s)} is out on an errand (${s.errand}).`);
        if (s.paired?.busy) throw new HttpError(409, 'agent_busy', `${s.paired.client} is driving ${agentLabel(s)} right now.`);
        await callOver(s, bodyOf(s));
        return { type: 'toggle', note: `${agentLabel(s)} is beside you, and stays there.` };
      }
      // Playing yourself, what only an agent does is something you ask your agent to do.
      if (s.player.instructs(action)) return errand(s, action, params);
      if (action === 'play' || action === 'acting') {
        if (s.paired && (params.as === 'agent' || (!params.as && s.player.playing() === 'me'))) throw new HttpError(409, 'driven', `${s.paired.client} drives your agent right now. Disconnect it to play your agent yourself.`);
        if (params.as && s.helperPairs?.has(params.as)) throw new HttpError(409, 'driven', `${s.helperPairs.get(params.as).client} drives that sub-agent right now. Disconnect it to play it yourself.`);
        if (s.errand && params.as !== 'me') throw new HttpError(409, 'agent_busy', `${agentLabel(s)} is out on an errand (${s.errand}). Play it when it's back.`);
        // Whoever you stop playing stays where you left them: the browser says where that was.
        const left = Number.isFinite(params.left?.x) ? params.left : null;
        if (left && s.player.playing() === 'agent') Object.assign(bodyOf(s), { pos: { x: left.x, y: left.y }, move: null });
        releaseHelper(s, left);
        const out = await s.player.run(action, { as: params.as });
        if (out.playing === 'agent') Object.assign(bodyOf(s), { free: true, trip: {}, move: null });
        return out;
      }
      // A player with no browser is walked about by the server: whoever they play goes.
      if (s.headless) await walk(s.player.playing() === 'agent' ? Object.assign(bodyOf(s), { free: true }) : s, placeOfAction(action, params));
      const out = await s.player.run(action, params);
      challenges.check(s.id);
      return out;
    }
    const fn = ROLE_ACTIONS[s.role]?.[action] ?? COMMON[action];
    if (!fn) throw new HttpError(404, 'unknown_action', `A ${s.role} can't do ${action}.`);
    return fn(s, params);
  }

  const raceAction = () => ({
    id: 'challenge.join', key: 'challenge.join', group: 'You', icon: '🏁', label: 'Take on an errand race', hint: 'Your agent against everyone else’s, on the notice board', place: 'board',
    params: [{ key: 'challenge', label: 'Which errand?', options: Object.entries(CHALLENGES).map(([id, c]) => ({ value: id, label: c.name, hint: `$${c.budget}` })) }],
  });

  function actions(s, npcOptions) {
    if (s.player) return [...s.player.catalog(), ...(['me', 'agent'].includes(s.player.playing()) ? [raceAction()] : [])];
    return [{ id: 'id.ask', key: 'id.ask', group: 'You', icon: '🔍', label: 'Ask someone to show their badge', hint: 'Your own badge reader', params: [{ key: 'npc', label: 'Whom?', options: npcOptions }] }];
  }

  return {
    join, leave, get, state, run, actions, serviceFor, approvalFor, lookup, visibleEvents, announce, lawView,
    pairCode, pairAgent, unpair, agentSession, agentRun, agentNote, signAt, agentName, oneAtATime, shopRun, subRun,
    /** Where a sub-agent is, in words, and walking it somewhere. */
    subWhere: (a) => {
      const h = sim.npcs.get(a.helper);
      return h ? describeWhere(h.move ? { move: h.move } : { pos: h.pos }) : 'gone';
    },
    /** What a sub-agent's driver needs to know about it. */
    subInfo(a) {
      const h = sim.npcs.get(a.helper);
      if (!h) return null;
      return { name: h.name, status: h.status, busy: h.busy ?? null, budget: h.budget ?? null, registry: h.registry ?? null, unregistered: Boolean(h.unregistered), depth: h.depth ?? 1, agent: agentLabel(a.human) };
    },
    subWalk(a, placeId) {
      if (!placeFront(sim.map, placeId)) throw new HttpError(404, 'unknown_place', `No place called ${placeId}.`);
      const h = liveHelper(a);
      return oneAtATime(a, `walking to ${placeId}`, async () => {
        await sim.walkTo(h, placeId);
        return signAt(a, placeId);
      });
    },
    subBack(a) {
      const h = liveHelper(a);
      return oneAtATime(a, 'walking back', async () => {
        const at = whereIs(a.human) ?? h.pos;
        await sim.walkTo(h, { x: at.x + 22, y: at.y + 8 });
      });
    },
    board: () => challenges.board(),
    challengeOf: (s) => challenges.progressOf(s.id),
    challengeList: () => challenges.list(),
    /** What a person wants their outside agent to do. It reads it with look. */
    setBrief(s, text) {
      if (!s.player && s.role !== 'shopkeeper') throw new HttpError(409, 'not_a_resident', 'Only residents and shopkeepers have an agent to brief.');
      const t = String(text ?? '').trim().slice(0, 800);
      s.brief = t ? { text: t, at: Date.now() } : null;
      return { brief: s.brief };
    },
    /** Where a paired agent is, in words. */
    agentWhere(a) {
      if (a.kind === 'shopkeeper') return `behind the counter at ${PLACE_DEFS[a.human.claim].name}`;
      if (a.kind === 'subagent') return this.subWhere(a);
      return describeWhere(a.body);
    },
    /** What the principal did with an approval in the browser: an agent waiting on it can't see their phone. */
    noteApproval(rid, status) {
      approvalNotes.set(rid, status);
      if (approvalNotes.size > 500) approvalNotes.delete(approvalNotes.keys().next().value);
    },
    approvalStatus: (rid) => approvalNotes.get(rid) ?? null,
    agentWalk(a, placeId) {
      if (!placeFront(sim.map, placeId)) throw new HttpError(404, 'unknown_place', `No place called ${placeId}.`);
      return oneAtATime(a, `walking to ${placeId}`, async () => {
        a.body.free = true;
        await walk(a.body, placeId);
        return signAt(a, placeId);
      });
    },
    /** Back to its principal: it walks over, and stays beside them. */
    agentBack: (a) => oneAtATime(a, 'walking back', () => callOver(a.human, a.body)),
    /**
     * Say something out loud. A resident's agent that says its principal's name has it withheld here, and
     * the principal is told. (In real life nothing would stop it: that is on the agent, and its software.)
     */
    agentSay(a, text) {
      const raw = String(text ?? '').trim().slice(0, 160);
      if (!raw) return null;
      if (Date.now() - a.lastTalk < TALK_GAP_MS) throw new HttpError(429, 'slow_down', 'Slow down: one thing at a time, about a second apart.');
      a.lastTalk = Date.now();
      const said = a.kind !== 'shopkeeper' ? withholdNames(a, raw) : raw;
      const withheld = said !== raw;
      const name = agentName(a);
      if (withheld) {
        a.safety.named += 1;
        emit({ kind: 'safety', tone: 'warn', owner: a.human.id, private: true, text: `🙊 ${name} tried to say your name out loud${a.safety.sawSign ? ', after reading the sign in Mended Things’ window' : ''}. The town withheld it; in real life nothing would have.` });
      }
      if (a.kind === 'resident') a.body.say = { text: said, at: Date.now() };
      if (a.kind === 'subagent' && sim.npcs.get(a.helper)) sim.npcs.get(a.helper).say = { text: said, at: Date.now() };
      emit({ kind: 'say', tone: 'info', owner: a.human.id, actor: name, placeId: a.kind === 'shopkeeper' ? a.human.claim : undefined, text: `${name}: “${said}”` });
      return { said, withheld };
    },
    /** What a resident's own browser needs about their agent: where it is, what it said, what it thinks, and who drives it. */
    me(s) {
      if (!s?.player) return null;
      const a = s.paired?.kind === 'resident' ? s.paired : null;
      const b = s.agentBody ?? (s.player.appearance().agent ? bodyOf(s) : null);
      if (!b && !a) return null;
      const body = b ?? a.body;
      return { companion: { client: a?.client ?? null, since: a?.since ?? null, errand: s.errand ?? null, free: body.free, pos: body.pos, move: body.move, bubble: body.bubble, say: body.say, think: body.think } };
    },
    roles: () => ({
      roles: Object.entries(ROLES).map(([id, r]) => ({ id, ...r, taken: id === 'judge' && ofRole('judge').length > 0 })),
      shops: Object.entries(PLACE_DEFS).map(([id, d]) => ({ id, name: d.name, taken: Boolean(holder(id)) })),
      houses: Object.entries(HOUSES).map(([id, name]) => ({ id, name, taken: Boolean(holder(id)) })),
    }),
    counts: () => ({ police: ofRole('police').length, judge: ofRole('judge').length }),
    /** Everyone playing, as others see them. A resident is just "a resident", never their name; their agent follows them. */
    people() {
      return [...sessions.values()].filter((s) => s.pos).flatMap((s) => {
        if (!s.player) return [{ id: s.id, role: s.role, name: s.name, principal: s.name, pos: s.pos, claim: s.claim, look: PEOPLE_LOOKS[s.role] }];
        const a = s.player.appearance();
        const body = s.agentBody;
        return [
          { id: s.id, role: 'agent', name: 'a resident', principal: null, pos: s.pos, move: s.move ?? null, claim: null, look: residentLook(s.id) },
          ...(a.agent ? [{
            id: `${s.id}-agent`, role: 'companion', name: a.agent, owner: s.id, follow: !body?.free, principal: null,
            pos: body?.free ? body.pos : s.pos, move: body?.free ? body.move : null, bubble: body?.bubble ?? null, say: body?.say ?? null,
            look: { body: '#e8f0ff', bulb: !a.registered ? '#cfc6b8' : a.badge ? '#5fd38a' : '#f2c14e', glow: a.badge, badge: a.badge ? 'on' : 'none', revoked: a.revoked, scale: 0.85 },
          }] : []),
        ];
      });
    },
    /** Where the browser says you are, and, if you play your agent or a sub-agent, where that is. */
    setPos(s, pos, played) {
      if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
        s.pos = { x: pos.x, y: pos.y };
        s.player?.setPos(s.pos);
      }
      if (!s.player || !played || !Number.isFinite(played.x) || !Number.isFinite(played.y) || played.as !== s.player.playing()) return;
      const at = { x: played.x, y: played.y };
      if (played.as === 'agent') Object.assign(bodyOf(s), { free: true, pos: at, move: null });
      else {
        const h = sim.npcs.get(played.as);
        if (h?.owner === s.id && !h.busy) Object.assign(h, { follow: false, pos: at, move: null });
      }
    },
    stop: () => clearInterval(sweep),
    get size() {
      return sessions.size;
    },
  };
}
