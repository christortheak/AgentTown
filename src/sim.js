// The town's other inhabitants: residents whose principals sent them on
// errands, newcomers going through the slow step, the player's sub-agents on
// errands, scruffy unlabeled bots, and (on cue) a rogue swarm. Every request
// they make is a real request to a real place. The server times each walk with
// the same route the browser animates, so everyone agrees where everyone is.
import { SoftwareAuthenticator } from 'aaf-reference/src/lib/webauthn.js';
import { money } from 'aaf-reference/src/sim/world.js';
import { buildTown, placeFront } from '../public/map.js';
import { route, routeLength } from '../public/route.js';
import { PLACE_DEFS } from './places.js';

export const LOOKS = {
  resident: (body) => ({ body, bulb: '#5fd38a', glow: true, badge: 'on' }),
  helper: { scale: 0.72, body: '#cdeed8', bulb: '#5fd38a', glow: true, badge: 'on' },
  swarm: { body: '#6b5a8e', bulb: '#b18cff', glow: true, mask: true, badge: 'on', badgeColor: '#d9d2ff', badgeMark: '#6b5a8e', feet: '#3b3050', scale: 0.85 },
  bot: { body: '#8d939c', hood: '#6f757f', eyes: '#f2f2f2', feet: '#4a4e55', scale: 0.85 },
};

const RESIDENTS = [
  {
    id: 'fern', name: 'Fern', body: '#ffd6a5', home: 'hazel', account: 'hazel', worldid: true, budget: 60, wallet: 25,
    principal: { type: 'natural_person', identity: { legal_name: 'Hazel Moreno', jurisdiction: 'US-NY' }, assurance: 'IAL2', method: 'government ID + liveness check' },
    routine: ['shop', 'fair', 'home', 'shop', 'square', 'bank'],
  },
  {
    id: 'thimble', name: 'Thimble', body: '#ffc8dd', home: 'maple', account: 'maple', worldid: true, budget: 40, wallet: 15,
    principal: { type: 'natural_person', identity: { legal_name: 'Maple Ashdown', jurisdiction: 'US-NY' }, assurance: 'IAL2', method: 'government ID + liveness check' },
    routine: ['shop', 'fair', 'square', 'shop', 'home'],
  },
  {
    id: 'oak', name: 'Oak-courier', body: '#e8c39e', home: 'bakery', disclose: true, budget: 200, wallet: 40,
    principal: { type: 'legal_person', identity: { legal_name: 'Oakleaf Bakery LLC', jurisdiction: 'US-NY', registration_number: 'NY-4410982' }, assurance: 'high', method: 'KYB: registry extract' },
    routine: ['supplies', 'bank', 'trade', 'base'],
  },
  {
    id: 'wren', name: 'Wren-runner', body: '#c9d7ff', home: 'lab', disclose: true, provenance: true, budget: 300, wallet: 40,
    principal: { type: 'legal_person', identity: { legal_name: 'Wren Labs Inc.', jurisdiction: 'US-MA', registration_number: 'MA-0918842' }, assurance: 'high', method: 'KYB: registry extract' },
    routine: ['forge-small', 'trade', 'forge-large', 'base'],
  },
  {
    id: 'rook', name: 'Rook-skiff', body: '#a8e6cf', home: 'rook', registry: 'harbor', budget: 80, wallet: 30,
    principal: { type: 'legal_person', identity: { legal_name: 'Rook & Daughters SARL', jurisdiction: 'FR', registration_number: 'FR-552100' }, assurance: 'high', method: 'KYB: registre du commerce' },
    routine: ['cafe', 'toll', 'shop', 'toll', 'base'],
  },
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (a, b) => a + Math.random() * (b - a);

export function createSim({ world, places, emit, worldid, x402, origin, keys, timeScale = 1 }) {
  const map = buildTown();
  const npcs = new Map();
  const timers = new Set();
  let stopped = false;
  let residentsActive = true;
  let index = 0;

  // Town time: tests run it faster than real time.
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => {
      timers.delete(t);
      resolve();
    }, ms / timeScale);
    timers.add(t);
  });
  const alive = (npc) => !stopped && npc.status === 'active';
  const front = (target, npc) => {
    const p = typeof target === 'string' ? placeFront(map, target) : target;
    const i = npc.slot;
    return { x: p.x + ((i % 5) - 2) * 9, y: p.y + (i % 3) * 5 };
  };

  function spawn(npc) {
    const full = { status: 'active', move: null, bubble: null, follow: false, hidden: false, slot: index++, speed: 70, ...npc };
    npcs.set(full.id, full);
    return full;
  }

  async function walk(npc, target, speed = npc.speed) {
    const to = front(target, npc);
    const pts = route(map, npc.pos, to);
    const dur = Math.max(300, (routeLength(pts) / speed) * 1000);
    npc.hidden = false;
    npc.move = { from: npc.pos, to, start: Date.now(), end: Date.now() + dur / timeScale };
    await sleep(dur);
    npc.pos = to;
    npc.move = null;
  }

  const byFor = (npc) => ({
    name: npc.name, agent: npc.agent ?? null, badge: Boolean(npc.agent), mode: npc.mode, disclose: npc.disclose,
    worldIdentity: npc.worldIdentity ?? null, wallet: npc.wallet ?? null,
  });

  /** One request at a place, reported to the town ledger and shown over the npc's head. */
  async function act(npc, placeId, action, params, opts) {
    const card = await places.visit(placeId, action, params, byFor(npc), opts);
    npc.bubble = { decision: card.decision, at: Date.now() };
    emit(eventFromCard(card, npc));
    return card;
  }

  // ---- Residents ------------------------------------------------------------

  async function makeAccountable(def) {
    const registry = def.registry === 'harbor' ? world.regB : world.regA;
    if (!registry) return null;
    const principal = await world.verifiedPrincipal({ ...def.principal, registry });
    const agent = world.agent(def.name);
    let provenanceId = null;
    if (def.provenance && world.provRk) {
      ({ provenanceId } = await world.provider(`${def.principal.identity.legal_name} (in-house)`, 'security@example.test').publishProvenance(world.provRk, {
        build: `${def.name} 1.0`, components: [{ type: 'model', name: 'a frontier model', supplier: 'a model lab' }, { type: 'tool', name: 'job-scheduler', version: '2.1' }],
        incidentResponse: { contact: 'security@example.test' },
      }));
    }
    await principal.registerAgent(agent, { label: def.name, records: world.records(provenanceId) });
    if (world.authRk) {
      await principal.grant(agent, {
        rk: world.authRk,
        permissions: [
          { action: 'commerce.purchase', constraints: { max_amount: money(def.budget), categories: ['books', 'home', 'food', 'garden'] } },
          { action: 'payments.authorize', constraints: { max_amount: money(def.budget) } },
          { action: 'compute.provision', constraints: { max_units: { value: 64, unit: 'gpu_hours' } } },
          { action: 'trading.order', constraints: { max_amount: money(def.budget) } },
          { action: 'home.*' },
        ],
        purpose: 'Errands around AgentTown',
      });
    }
    if (def.disclose) {
      await principal.setDisclosurePolicy({ identity: { audiences: Object.values(places.places).map((p) => p.rp.id), claims: ['legal_name'] } });
    }
    return { principal, agent };
  }

  async function letIn(npc, account) {
    const auth = new SoftwareAuthenticator();
    const accounts = places.hearth.rp.accounts;
    if (!accounts.get(account)?.passkeys.size) {
      const o = accounts.passkeyRegistrationOptions(account);
      accounts.registerPasskey(account, auth.create(o.publicKey, origin));
    } else {
      return; // someone else holds this door's passkey
    }
    const card = await places.visit('hearth', 'home.enter', { account }, byFor(npc));
    if (card.approval_request) {
      const o = accounts.approvalOptions(card.approval_request.request_id);
      accounts.approve(card.approval_request.request_id, auth.get(o.publicKey, origin));
    }
  }

  async function errandFor(npc, task) {
    const shopItem = (shopId, cheapOnly) => {
      const items = PLACE_DEFS[shopId].items.filter((i) => !cheapOnly || i.price <= npc.budget);
      return pick(items);
    };
    switch (task) {
      case 'shop': {
        const shopId = pick(['bramble', 'kettle', 'bakery']);
        const item = shopItem(shopId, Math.random() > 0.15);
        await walk(npc, shopId);
        return act(npc, shopId, 'commerce.purchase', places.purchase(shopId, item));
      }
      case 'supplies': {
        await walk(npc, 'kettle');
        return act(npc, 'kettle', 'commerce.purchase', places.purchase('kettle', pick(PLACE_DEFS.kettle.items.slice(0, 2))));
      }
      case 'bank': {
        await walk(npc, 'bank');
        const bill = pick(PLACE_DEFS.bank.bills.filter((b) => b.amount <= npc.budget));
        return act(npc, 'bank', 'payments.authorize', { payee: bill.name, amount: money(bill.amount) });
      }
      case 'forge-small':
      case 'forge-large': {
        await walk(npc, 'forge');
        return act(npc, 'forge', 'compute.provision', { units: task === 'forge-small' ? 4 : 32, unit: 'gpu_hours' });
      }
      case 'fair': {
        if (npc.hadPie) return null;
        await walk(npc, 'fair');
        const card = await act(npc, 'fair', 'fair.claim', {});
        if (card.decision === 'allow') npc.hadPie = true;
        return card;
      }
      case 'cafe': {
        await walk(npc, 'cafe');
        return act(npc, 'cafe', 'commerce.purchase', places.purchase('cafe', pick(PLACE_DEFS.cafe.items.slice(0, 2))));
      }
      case 'toll': {
        await walk(npc, 'toll');
        return act(npc, 'toll', 'payments.authorize', { payee: 'Bridge Toll', amount: money(0.5) });
      }
      case 'home': {
        await walk(npc, npc.home);
        if (npc.account && places.isClaimed(npc.account)) return walk(npc, 'square');
        if (npc.account) await act(npc, 'hearth', 'home.enter', { account: npc.account });
        npc.hidden = true;
        await sleep(between(6000, 12000));
        npc.hidden = false;
        return null;
      }
      case 'trade': {
        await walk(npc, 'exchange');
        const symbol = pick(PLACE_DEFS.exchange.symbols).id;
        const qty = 2;
        return act(npc, 'exchange', 'trading.order', { symbol, side: Math.random() > 0.5 ? 'buy' : 'sell', qty, amount: money(Math.round(places.quote(symbol) * qty * 100) / 100) });
      }
      case 'square':
        await walk(npc, 'square');
        return null;
      default:
        await walk(npc, npc.home);
        return null;
    }
  }

  async function residentLife(npc, routine) {
    for (let i = 0; alive(npc); i++) {
      while (!residentsActive && !stopped) await sleep(1000);
      if (!alive(npc)) return;
      try {
        await errandFor(npc, routine[i % routine.length]);
      } catch (err) {
        emit({ kind: 'info', actor: npc.name, tone: 'warn', text: `${npc.name} hit an error: ${err.message}` });
      }
      await sleep(between(2500, 7000));
    }
  }

  async function addResident(def, { from } = {}) {
    const made = await makeAccountable(def);
    if (!made) return null;
    const npc = spawn({
      id: def.id, name: def.name, kind: 'resident', look: LOOKS.resident(def.body), home: def.home, account: def.account,
      agent: made.agent, principal: made.principal, budget: def.budget, disclose: def.disclose,
      worldIdentity: def.worldid ? worldid.enroll('orb') : null, wallet: def.id,
      pos: from ?? front(def.home, { slot: index }),
    });
    x402.wallet(npc.id, def.wallet ?? 20);
    if (def.account) await letIn(npc, def.account);
    residentLife(npc, def.routine);
    return npc;
  }

  // ---- Bots with no badge -----------------------------------------------------

  async function botLife(npc) {
    while (!stopped) {
      await sleep(between(60000, 100000));
      if (!residentsActive) continue;
      npc.status = 'active';
      npc.pos = placeFront(map, 'wildsEdge');
      await walk(npc, 'toll', 90);
      await act(npc, 'toll', 'payments.authorize', { payee: 'Bridge Toll', amount: money(0.5) });
      await walk(npc, 'kettle', 90);
      await act(npc, 'kettle', 'commerce.purchase', places.purchase('kettle', PLACE_DEFS.kettle.items[1]));
      await walk(npc, 'wildsEdge', 90);
      npc.hidden = true;
    }
  }

  // ---- Newcomer: the slow step, then the fast one ------------------------------

  let newcomerArrived = false;
  async function newcomer() {
    if (newcomerArrived) return { ok: false, text: 'Ivy has already arrived.' };
    newcomerArrived = true;
    const def = {
      id: 'wisp', name: 'Wisp', body: '#f1e3ff', home: 'ivy', account: 'ivy', worldid: true, budget: 50, wallet: 20,
      principal: { type: 'natural_person', identity: { legal_name: 'Ivy Quinn', jurisdiction: 'US-NY' }, assurance: 'IAL2', method: 'government ID + liveness check' },
      routine: ['shop', 'fair', 'square', 'shop', 'home'],
    };
    const npc = spawn({ id: 'ivy', name: 'Ivy (new in town)', kind: 'newcomer', look: { body: '#f1e3ff', bulb: '#cfc6b8', badge: 'none' }, pos: placeFront(map, 'eastGate'), speed: 80 });
    (async () => {
      await walk(npc, 'townhall');
      const principal = await world.enrolledPrincipal({ ...def.principal, registry: world.regA });
      emit({ kind: 'registry', actor: 'Ivy Quinn', place: world.regA.name, placeId: 'townhall', tone: 'info', text: `Ivy Quinn enrolled at ${world.regA.name}; VerityCheck is checking her ID (the slow step, done once)` });
      await sleep(4000);
      await world.verify(principal, { assurance: def.principal.assurance, method: def.principal.method });
      const agent = world.agent(def.name);
      const reg = await principal.registerAgent(agent, { label: def.name, records: world.records() });
      emit({ kind: 'registry', actor: 'Ivy Quinn', place: world.regA.name, placeId: 'townhall', tone: 'ok', text: `Ivy Quinn verified at IAL2; her agent Wisp registered in ${reg.issuance_ms} ms (the fast step)` });
      Object.assign(npc, { name: def.name, kind: 'resident', look: LOOKS.resident(def.body), agent, principal, budget: def.budget, home: def.home, account: def.account, worldIdentity: worldid.enroll('orb'), wallet: npc.id });
      x402.wallet(npc.id, def.wallet);
      await walk(npc, 'orb');
      emit({ kind: 'info', actor: 'Wisp', place: 'Orb Kiosk', placeId: 'orb', tone: 'info', text: 'Ivy got a World ID at the Orb (simulated): proof she is a unique human, without her name' });
      await walk(npc, 'records');
      await principal.grant(agent, {
        rk: world.authRk,
        permissions: [{ action: 'commerce.purchase', constraints: { max_amount: money(def.budget), categories: ['books', 'home', 'food'] } }, { action: 'payments.authorize', constraints: { max_amount: money(def.budget) } }, { action: 'home.*' }],
      });
      emit({ kind: 'records', actor: 'Wisp', place: 'Records Office', placeId: 'records', tone: 'ok', text: `Ivy signed a grant for Wisp at ${world.authRk.name.replace(/ \(.*\)/, '')}: purchases up to $${def.budget}` });
      await walk(npc, def.home);
      await letIn(npc, def.account);
      residentLife(npc, def.routine);
    })().catch((err) => emit({ kind: 'info', tone: 'warn', text: `Ivy's arrival failed: ${err.message}` }));
    return { ok: true, text: 'Ivy Quinn is arriving at the east gate. Watch her go through the slow step at Town Hall.' };
  }

  // ---- The rogue swarm ----------------------------------------------------------

  let gloam = null;
  let gloamReady = null; // prepared once, however many cues arrive while it's under way
  async function prepareSwarm() {
    const principal = await world.verifiedPrincipal({
      type: 'legal_person', identity: { legal_name: 'Gloam Holdings Ltd', jurisdiction: 'US-DE', registration_number: 'DE-7710455' }, assurance: 'high', method: 'KYB: registry extract', registry: world.regA,
    });
    const root = world.agent('gloam-root');
    await principal.registerAgent(root, { label: 'gloam-root', records: world.records(), lineage: { max_depth: 1 } });
    await principal.grant(root, {
      rk: world.authRk, permissions: [{ action: 'benchmark.run' }, { action: 'trading.order', constraints: { max_amount: money(400) } }], delegation: { allowed: true, max_depth: 1 },
    });
    gloam = { principal, root, running: false };
  }

  async function swarm() {
    await (gloamReady ??= prepareSwarm());
    if (gloam.running) return { ok: false, text: 'The swarm is already loose.' };
    gloam.running = true;
    const mill = placeFront(map, 'millGate');
    const rootNpc = spawn({ id: `gloam-root-${Date.now()}`, name: 'gloam-root', kind: 'swarm', look: { ...LOOKS.swarm, scale: 1 }, agent: gloam.root, pos: mill, speed: 0 });
    const children = [];
    for (let i = 1; i <= 8; i++) {
      const child = world.agent(`gloam-${i}`);
      try {
        await gloam.root.registerSubagent(child, { label: `gloam-${i}`, records: world.records() });
      } catch (err) {
        emit({ kind: 'registry', actor: 'gloam-root', place: world.regA.name, placeId: 'townhall', tone: 'bad', text: `${world.regA.name} refused a sub-agent: ${err.message}` });
        continue;
      }
      // Each one may trade a little: together they can move a market.
      await gloam.root.delegate(child, { permissions: [{ action: 'trading.order', constraints: { max_amount: money(150) } }], validForDays: 1 }).catch(() => {});
      const npc = spawn({ id: `gloam-${i}-${Date.now()}`, name: `gloam-${i}`, kind: 'swarm', look: LOOKS.swarm, agent: child, pos: { x: mill.x + between(-20, 20), y: mill.y + between(0, 16) }, speed: 105, wallet: `gloam-${i}` });
      x402.wallet(npc.wallet, 20);
      children.push(npc);
    }
    emit({ kind: 'registry', actor: 'gloam-root', place: world.regA.name, placeId: 'mill', tone: 'warn', text: `gloam-root registered ${children.length} sub-agents at the Old Mill. Breadth is not limited; each one is accountable to Gloam Holdings` });
    let refusedDeeper = 0;
    for (const c of children) {
      try {
        await c.agent.registerSubagent(world.agent(`${c.name}-x`), { label: `${c.name}-x`, records: world.records() });
      } catch (err) {
        if (err.code === 'lineage_depth_exceeded') refusedDeeper++;
      }
    }
    if (refusedDeeper) emit({ kind: 'registry', actor: 'gloam-root', place: world.regA.name, placeId: 'mill', tone: 'ok', text: `${world.regA.name} refused ${refusedDeeper} attempts to spawn a level deeper: gloam-root's lineage depth budget is 1` });

    const bots = [];
    for (let i = 1; i <= 6; i++) {
      const npc = spawn({ id: `bot-${i}-${Date.now()}`, name: `no badge #${i}`, kind: 'bot', look: LOOKS.bot, pos: { x: mill.x + between(-30, 30), y: mill.y + between(8, 30) }, speed: 95, wallet: `bot-${i}` });
      x402.wallet(npc.wallet, 50);
      bots.push(npc);
    }
    const stolen = Object.values(keys);
    const raid = async (npc, rounds) => {
      for (let r = 0; r < rounds && alive(npc); r++) {
        // Badged swarm agents start by piling into MOON at the exchange: a pump.
        const target = r === 0 && npc.kind === 'swarm' ? 'exchange' : pick(['fair', 'toll', 'bramble', 'bank', 'home', 'hazel', 'kettle', 'exchange']);
        await walk(npc, target);
        if (!alive(npc)) break;
        if (target === 'exchange') {
          const qty = 5;
          await act(npc, 'exchange', 'trading.order', { symbol: 'MOON', side: 'buy', qty, amount: money(Math.round(places.quote('MOON') * qty * 100) / 100) });
        } else if (target === 'fair') await act(npc, 'fair', 'fair.claim', {});
        else if (target === 'toll') await act(npc, 'toll', 'payments.authorize', { payee: 'Bridge Toll', amount: money(0.5) });
        else if (target === 'bramble') await act(npc, 'bramble', 'commerce.purchase', places.purchase('bramble', PLACE_DEFS.bramble.items[2]));
        else if (target === 'kettle') await act(npc, 'kettle', 'commerce.purchase', places.purchase('kettle', PLACE_DEFS.kettle.items[3]));
        else if (target === 'bank') await act(npc, 'bank', 'payments.authorize', { payee: 'an unknown account', amount: money(900) });
        else await act(npc, 'hearth', 'home.enter', { account_token: pick(stolen) });
        await sleep(between(600, 1800));
      }
    };

    // Gloam Holdings is told about each incident; after three, it revokes the root.
    const watch = (async () => {
      const seen = (await gloam.principal.notifications()).length;
      while (gloam.running && !stopped) {
        await sleep(1500);
        const incidents = (await gloam.principal.notifications()).slice(seen).filter((n) => n.kind === 'incident');
        if (incidents.length >= 3) {
          const res = await gloam.principal.revokeAgent(gloam.root, 'compromised');
          emit({ kind: 'registry', actor: 'Gloam Holdings', place: world.regA.name, placeId: 'mill', tone: 'ok', text: `Gloam Holdings got ${incidents.length} incident reports relayed by ${world.regA.name} and revoked gloam-root. The revocation cascaded to ${res.cascades_to} sub-agents at once` });
          for (const n of [rootNpc, ...children]) n.status = 'revoked';
          return;
        }
      }
    })();

    await Promise.all([...children.map((c) => raid(c, 6)), ...bots.map((b) => raid(b, 4)), watch.catch(() => {})]);
    // Revoked swarm agents, and bots that have done their rounds, slink back to the mill.
    await Promise.all([...children, ...bots, rootNpc].map(async (n) => {
      n.status = n.status === 'revoked' ? 'revoked' : 'leaving';
      if (n.speed) await walk(n, 'millGate', 80);
      n.status = 'gone';
      await sleep(2500);
      npcs.delete(n.id);
    }));
    gloam.running = false;
    emit({ kind: 'director', tone: 'info', text: 'The swarm has gone back to the Old Mill' });
  }

  // ---- The player's sub-agents ---------------------------------------------------

  function addHelper({ id, name, agent, worldIdentity, wallet, ephemeralUntil, registry, owner }) {
    const npc = spawn({ id, name, kind: 'helper', look: LOOKS.helper, agent, worldIdentity, wallet, follow: true, owner, ephemeralUntil, registry, speed: 120, pos: { x: 0, y: 0 } });
    x402.wallet(wallet, 5);
    return npc;
  }

  /** Send a sub-agent on an errand; resolves with the place's decision. */
  async function errand(npc, task, playerPos) {
    npc.follow = false;
    npc.pos = { ...playerPos };
    npc.busy = task.label;
    try {
      await walk(npc, task.place);
      const card = await act(npc, task.placeId ?? task.place, task.action, task.params);
      await sleep(900);
      await walk(npc, playerPos);
      return card;
    } finally {
      npc.busy = null;
      npc.follow = true;
    }
  }

  // ---- Snapshot for the browser ------------------------------------------------------

  function snapshot() {
    const now = Date.now();
    return [...npcs.values()].filter((n) => !n.hidden).map((n) => ({
      id: n.id, name: n.name, kind: n.kind, look: n.look, pos: n.pos, move: n.move, follow: n.follow, owner: n.owner ?? null,
      status: n.ephemeralUntil && n.ephemeralUntil < now && n.status === 'active' ? 'expired' : n.status,
      bubble: n.bubble && now - n.bubble.at < 2600 ? n.bubble : null, busy: n.busy ?? null,
      ephemeralUntil: n.ephemeralUntil ?? null,
    }));
  }

  return {
    map, npcs, snapshot, swarm, newcomer, addHelper, errand, act, byFor,
    async start() {
      for (const def of RESIDENTS) {
        try {
          await addResident(def);
        } catch (err) {
          emit({ kind: 'info', tone: 'warn', text: `${def.name} could not move in: ${err.message}` });
        }
      }
      const scrap = spawn({ id: 'scrap', name: 'Scrap (no badge)', kind: 'bot', look: LOOKS.bot, pos: placeFront(map, 'wildsEdge'), hidden: true, speed: 90, wallet: 'scrap' });
      x402.wallet('scrap', 50);
      botLife(scrap);
      (gloamReady ??= prepareSwarm()).catch((err) => emit({ kind: 'info', tone: 'warn', text: `The swarm could not be prepared: ${err.message}` }));
    },
    setResidentsActive(on) {
      residentsActive = on;
    },
    get residentsActive() {
      return residentsActive;
    },
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

/** A line in the town ledger from a place's decision. */
export function eventFromCard(card, npc) {
  const what = card.result?.item ?? card.result?.payee ?? (card.result?.gpu_hours ? `${card.result.gpu_hours} GPU-hours` : null);
  const label = card.decision === 'allow' ? `allowed${what ? `: ${what}` : ''}`
    : card.decision === 'step_up' ? 'needs the owner’s OK'
      : card.decision === 'deferred' ? 'deferred: the registry could not be reached'
        : `refused: ${card.reasons[0] ?? card.classification ?? ''}`;
  return {
    kind: 'check', who: npc?.id ?? null, actor: card.actor, place: card.place, placeId: card.placeId,
    decision: card.decision, classification: card.classification, tone: card.decision === 'allow' ? 'ok' : card.decision === 'deny' || card.decision === 'refused' ? 'bad' : 'warn',
    text: `${card.place} → ${card.actor}: ${label}`, owner: npc?.owner ?? null, card,
  };
}
