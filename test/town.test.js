// AgentTown end to end through the game's API, with a software authenticator
// that sends exactly what a browser sends from the game's origin. Town time
// runs fast so walks, errands and the swarm finish quickly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoftwareAuthenticator } from 'aaf-reference/src/lib/webauthn.js';
import { startFederationInProcess } from 'aaf-reference/src/lib/federation.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/server.js';
import { buildTown, placeFront } from '../public/map.js';

/** One browser tab: it joins the town and sends its session with every call. */
const client = (game) => {
  let session = null;
  const call = async (method, p, body) => {
    const headers = { 'content-type': 'application/json', ...(session ? { 'x-session': session } : {}) };
    const res = await fetch(game.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ...(await res.json()), httpStatus: res.status };
  };
  const post = (p, body = {}) => call('POST', p, body);
  const run = (action, params = {}) => post('/api/do', { action, params });
  const get = (p) => call('GET', p);
  const join = async (role, name, claim) => {
    const r = await post('/api/join', { role, name, claim });
    session = r.session;
    return r;
  };
  const authenticator = new SoftwareAuthenticator();
  const approve = async (rid) => {
    const o = await post(`/api/approvals/${rid}/options`);
    return post(`/api/approvals/${rid}/approve`, { credential: authenticator.get(o.publicKey, game.origin) });
  };
  const passkey = async (service) => {
    const o = await post('/api/passkey/options', { service });
    return post('/api/passkey', { service, credential: authenticator.create(o.publicKey, game.origin) });
  };
  /** What the browser does with a pending request: approve it with the passkey, then retry. */
  const follow = async (out) => {
    const req = out.pendingRequest;
    if (!req) return out;
    await approve(req.request_id);
    return run(req.retry.action, req.retry.params);
  };
  return { call, post, run, get, join, approve, passkey, follow, authenticator };
};

/**
 * Wait until the town ledger has an event matching `test`. Reads it through the
 * API, keeping its place, so a busy town can't scroll an event past between polls.
 */
async function until(get, testFn, { timeout = 20000, label = 'event' } = {}) {
  const deadline = Date.now() + timeout;
  let since = 0;
  while (Date.now() < deadline) {
    const w = await get(`/api/world?since=${since}`);
    const hit = w.events.find(testFn);
    if (hit) return hit;
    since = w.events.length ? Math.min(w.seq, w.events.at(-1).seq) : since;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('a day in AgentTown', { timeout: 120000 }, async () => {
  const game = await startServer({ port: 4499, portOffset: 7500, quiet: true, timeScale: 25 });
  const { post, run, get, join, approve, passkey, follow } = client(game);
  try {
    assert.match(await (await fetch(game.url + '/')).text(), /AgentTown/);
    assert.equal((await get('/api/state')).httpStatus, 401, 'join first');
    await join('agent', 'Robin Ash');
    const actions = (await get('/api/actions')).actions;
    assert.ok(actions.length > 30, 'the deck lists every action');

    // You start as a person: a shop that takes people at their word serves you; one that has people sign in wants an account.
    const inPerson = await run('buy', { shop: 'bramble', item: 'guide' });
    assert.equal(inPerson.decision, 'allow');
    assert.equal(inPerson.lane, 'people');
    assert.match(inPerson.why, /at their word/);
    const kettle = await run('buy', { shop: 'kettle', item: 'kettle' });
    assert.equal(kettle.headline, 'Sign in first');
    assert.equal(kettle.fix.action, 'signup', 'every refusal suggests the next step');
    // Registering before verification is refused by the registry itself.
    const early = await run('register', { name: 'Pip' });
    assert.equal(early.decision, 'refused');
    assert.match(early.reasons[0], /verified/);
    assert.equal((await run('verify')).decision, 'allow');
    assert.equal((await run('register', { name: 'Pip' })).decision, 'allow');
    assert.equal((await run('buy', { shop: 'bramble', item: 'guide' })).decision, 'deny', 'registered, but no authority yet');
    assert.equal((await run('grant', { budget: 50 })).decision, 'allow');

    // Shops: within the grant, over it, and a shop that only takes the EU registry's badges.
    const guide = await run('buy', { shop: 'bramble', item: 'guide' });
    assert.equal(guide.decision, 'allow');
    assert.ok(guide.receipt.verified);
    assert.match(guide.headline, /Bought pocket guide/);
    assert.ok(guide.plain.some((x) => x.kind === 'protected'), 'in plain words: not who they are');
    const hops = guide.trace.map((h) => `${h.from}>${h.to}`);
    for (const hop of ['actor>bramble', 'bramble>townhall', 'bramble>records', 'bramble>actor']) assert.ok(hops.includes(hop), `the X-ray shows ${hop}`);
    const tooMuch = await run('buy', { shop: 'bramble', item: 'encyclopedia' });
    assert.equal(tooMuch.heldBack, true, 'over the record\'s limit: the agent never asks the shop');
    assert.match(tooMuch.headline, /didn't go ahead/);
    const cafe = await run('buy', { shop: 'cafe', item: 'creme' });
    assert.notEqual(cafe.decision, 'allow', 'Café Lumière only accepts Harbor Registry badges');
    assert.match(cafe.policy, /Harbor Registry|Registry B/);

    // Disclosure requests: a place asks, the principal decides on their phone, the agent shows only that.
    assert.equal((await run('compute', { job: 'small' })).decision, 'allow');
    const large = await run('compute', { job: 'large' });
    assert.equal(large.decision, 'step_up');
    assert.deepEqual(large.ask.want.map((w) => w.kind), ['identity', 'provenance']);
    assert.equal((await get('/api/state')).phone.asks.length, 1, 'the question is on the phone');
    assert.match((await run('consent', { ask: large.ask.id, choice: 'once' })).headline, /passkey on your phone/, 'sharing needs a passkey');
    assert.ok((await passkey('phone')).credential_id);
    const shared = await follow(await run('consent', { ask: large.ask.id, choice: 'once' }));
    assert.equal(shared.classification, 'ACCOUNTABLE_DISCLOSED');
    assert.match(shared.headline, /grant/, 'name and bill of materials shown, but 32 GPU-hours is more than the grant allows');
    const draught = await run('buy', { shop: 'apothecary', item: 'draught' });
    assert.equal(draught.decision, 'step_up');
    assert.equal(draught.ask.want[0].name, 'age_over_18');
    const served = await follow(await run('consent', { ask: draught.ask.id, choice: 'always' }));
    assert.equal(served.decision, 'allow');
    assert.ok(served.plain.some((x) => x.kind === 'attribute'), 'the place learned "over 18"');
    assert.ok(!served.plain.some((x) => x.kind === 'identity'), '... and not the name');
    assert.equal((await run('buy', { shop: 'apothecary', item: 'draught' })).decision, 'allow', 'standing consent: no question the second time');
    assert.equal((await run('buy', { shop: 'kettle', item: 'kettle' })).classification, 'ACCOUNTABLE_PROTECTED', 'a place that does not ask learns nothing extra');
    const kyc = await run('bank.open');
    assert.equal((await run('consent', { ask: kyc.ask.id, choice: 'decline' })).decision, 'info');
    assert.equal((await run('bank.open')).decision, 'step_up', 'declined: the bank still does not have the name');

    // World ID (simulated): one pie per person. Your agent may not use your World ID unless your record says so.
    const noWorldId = await run('fair.claim');
    assert.equal(noWorldId.decision, 'deny');
    assert.match(noWorldId.reasons[0], /World ID/);
    await run('worldid.enroll');
    assert.equal((await run('fair.claim')).decision, 'deny', "the record doesn't let Pip use your World ID");
    await run('acting', { as: 'me' });
    assert.equal((await run('fair.claim')).decision, 'allow', 'in person');
    assert.equal((await run('fair.claim')).decision, 'deny', 'same person, same nullifier');
    await run('acting', { as: 'agent' });

    // x402 (simulated): the toll takes payment from anyone; with the framework on, it also checks authority.
    const before = (await get('/api/state')).wallet.balance;
    const toll = await run('toll.pay');
    assert.equal(toll.decision, 'allow');
    assert.ok(toll.steps.some((s) => /settled/.test(s.text)));
    assert.equal((await get('/api/state')).wallet.balance, before - 0.5);
    await run('badge', { on: false });
    const posing = await run('toll.pay');
    assert.equal(posing.decision, 'allow', 'x402 alone: no badge needed');
    assert.equal(posing.lane, 'people', 'with its badge off, the agent is taken for a person');
    await post('/api/director', { cue: 'policy', params: { place: 'toll', patch: { aaf: 'required', people: 'agents_only' } } });
    assert.equal((await run('toll.pay')).decision, 'deny');
    await run('badge', { on: true });
    assert.equal((await run('toll.pay')).decision, 'allow');

    // Sub-agents: over-delegation refused, depth budget enforced, an EU sub-agent gets served at the café.
    assert.equal((await run('helper.spawn', { kind: 'standing' })).decision, 'allow');
    const st = await get('/api/state');
    const sprout = st.helpers[0];
    assert.match((await run('helper.fund', { helper: sprout.id, budget: 100 })).reasons[0], /exceed|authority/i);
    assert.equal((await run('helper.fund', { helper: sprout.id, budget: 20 })).decision, 'allow');
    assert.match((await run('helper.deeper', { helper: sprout.id })).reasons[0], /level/);
    assert.equal((await run('helper.spawn', { registry: 'harbor', kind: 'standing' })).decision, 'allow');
    const eu = (await get('/api/state')).helpers.find((h) => h.registry !== st.helpers[0].registry);
    await run('helper.fund', { helper: eu.id, budget: 10 });
    await run('helper.errand', { helper: eu.id, task: 'buy:cafe/creme' });
    const euCafe = await until(get, (e) => e.kind === 'check' && e.placeId === 'cafe' && e.actor === eu.name, { label: "the EU sub-agent's café visit" });
    assert.equal(euCafe.decision, 'allow', 'a federated chain through the EU registry is served');
    await run('helper.errand', { helper: sprout.id, task: 'fair' });
    const sproutPie = await until(get, (e) => e.kind === 'check' && e.placeId === 'fair' && e.actor === sprout.name, { label: "the helper's pie" });
    assert.equal(sproutPie.decision, 'deny', 'the helper is the same person: World ID says one pie');

    // Mischief is refused.
    for (const trick of ['mischief.forge', 'mischief.wrongplace', 'mischief.claim']) {
      const r = await run(trick, { at: 'kettle' });
      assert.notEqual(r.decision, 'allow', trick);
    }
    assert.equal((await run('mischief.forge', { at: 'kettle' })).classification, 'UNSUPPORTED');

    // A registry outage: places defer rather than refuse.
    await post('/api/director', { cue: 'outage', params: { seconds: 2 } });
    const deferred = await run('buy', { shop: 'bakery', item: 'loaf' });
    assert.equal(deferred.decision, 'deferred');
    assert.equal(deferred.classification, 'LOOKUP_FAILED');
    await new Promise((r) => setTimeout(r, 2100));

    // Home: passkey on the door, the agent let in, step-up to throw things out.

    assert.ok((await passkey()).credential_id);
    const knock = await run('home.enter');
    assert.equal(knock.decision, 'step_up');
    await approve(knock.pending.request_id);
    assert.equal((await run('home.enter')).decision, 'allow');
    const toss = await run('home.discard', { item: 'Box of old letters' });
    await approve(toss.pending.request_id);
    assert.equal((await run(toss.pending.retry.action, toss.pending.retry.params)).decision, 'allow');

    // Badge reader: ask a resident to show their badge.
    const npcs = (await get('/api/world')).npcs;
    const resident = npcs.find((n) => n.kind === 'resident');
    const shown = await run('id.ask', { npc: resident.id });
    assert.equal(shown.decision, 'allow');
    assert.match(shown.classification, /ACCOUNTABLE/);

    // The rogue swarm: depth refused, a pump reported, and the root revoked, by Gloam itself
    // (after incident reports) or by the court (after the police), whichever comes first.
    await post('/api/director', { cue: 'swarm' });
    await until(get, (e) => /lineage depth budget/.test(e.text ?? ''), { label: 'depth refusals' });
    await until(get, (e) => e.kind === 'alert' && /MOON/.test(e.text), { label: 'the pump alert' });
    const cascade = await until(get, (e) => /revoked runner-hub/.test(e.text ?? ''), { timeout: 60000, label: 'the cascade' });
    assert.match(cascade.text, /8 sub-agent/);
    await until(get, (e) => /withdrew Gloam Holdings Ltd's verification/.test(e.text ?? ''), { timeout: 60000, label: 'the ban' });

    // Night and the court.
    const night = await run('night');
    assert.equal(night.got_in, 0);
    assert.equal(night.incidents_relayed, 3);
    const court = await run('court', {});
    assert.equal(court.decision, 'allow');

    // Revocation cascades to sub-agents.
    const rev = await run('agent.revoke');
    assert.match(rev.story, /sub-agent/);
    assert.equal((await get('/api/state')).acting, 'me', 'a revoked agent goes nowhere: you go yourself');
    assert.equal((await run('mischief.wrongplace', { at: 'bakery' })).decision, 'deny');
  } finally {
    await game.close();
  }
});

test('an external federation, reached by address', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttown-ext-'));
  const fed = await startFederationInProcess({ dataDir, portOffset: 8000, quiet: true });
  const game = await startServer({
    port: 4498, quiet: true, residents: false,
    config: { federation: { trustAnchor: fed.trustAnchor, authorityKeys: fed.paths.keysDir }, places: { cafe: { accepts: null } } },
  });
  const { run, get, join } = client(game);
  try {
    const info = await get('/api/info');
    assert.equal(info.federation, 'external');
    assert.equal(info.trust_anchor, fed.trustAnchor.url);
    assert.ok(info.registries.length >= 2);
    await join('agent', 'Robin Ash');
    assert.equal((await run('verify')).decision, 'allow');
    assert.equal((await run('register', { name: 'Pip' })).decision, 'allow');
    await run('grant', { budget: 25 });
    assert.equal((await run('buy', { shop: 'cafe', item: 'creme' })).decision, 'allow', 'this town configured the café to accept every registry');
  } finally {
    await game.close();
    await fed.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('people in roles: a shopkeeper, a homeowner, police, a judge, and a crook', { timeout: 120000 }, async () => {
  const game = await startServer({ port: 4497, portOffset: 8500, quiet: true, residents: false, timeScale: 25 });
  const [alice, bob, carol, dave, erin] = [client(game), client(game), client(game), client(game), client(game)];
  try {
    assert.ok((await alice.get('/api/roles')).shops.some((s) => s.id === 'exchange'));
    await alice.join('agent', 'Alice Grey');
    await bob.join('homeowner', 'Bob Hart', 'hazel');
    await carol.join('shopkeeper', 'Carol Lee', 'bramble');
    assert.equal((await client(game).join('homeowner', 'Someone', 'hazel')).httpStatus, 409, 'one owner per house');
    for (const [a, p] of [['verify'], ['register', { name: 'Ace' }], ['grant', { budget: 50 }]]) assert.equal((await alice.run(a, p)).decision, 'allow', a);

    // The shopkeeper decides which registries she trusts, and sees what each customer proves.
    await carol.run('shop.policy', { patch: { accepts: ['https://registry-b.aaf.test'] } });
    assert.equal((await alice.run('buy', { shop: 'bramble', item: 'guide' })).classification, 'UNSUPPORTED');
    await carol.run('shop.policy', { patch: { accepts: null } });
    assert.equal((await alice.run('buy', { shop: 'bramble', item: 'guide' })).decision, 'allow');
    const visit = (await carol.get('/api/state')).customers.find((c) => c.decision === 'allow');
    assert.ok(visit.card.learned.length);
    await carol.run('shop.report', { seq: visit.seq });
    assert.ok((await alice.get('/api/state')).phone.incidents.some((n) => /Bramble Books reports/.test(n.summary)), "the report reached Alice's phone");

    // A homeowner decides who comes in, with a passkey on her own device.
    assert.ok((await bob.passkey()).credential_id);
    const knock = await alice.run('neighbor.knock', { home: 'hazel' });
    assert.equal(knock.decision, 'step_up');
    const rid = knock.approval_request.request_id;
    assert.equal((await alice.post(`/api/approvals/${rid}/options`)).httpStatus, 403, "Alice can't approve Bob's door");
    assert.equal((await bob.get('/api/state')).phone.approvals.length, 1);
    assert.equal((await bob.approve(rid)).status, 'approved');
    assert.equal((await alice.get('/api/state')).knocks[0].status, 'approved');
    assert.equal((await alice.run('neighbor.knock', { home: 'hazel' })).decision, 'allow');
    assert.ok((await bob.get('/api/state')).door.length >= 2, 'Bob sees every visit to his door');

    // Police and a judge, both people.
    await dave.join('police', 'Dave Moss');
    await erin.join('judge', 'Erin Vale');
    assert.equal((await client(game).join('judge', 'Another')).httpStatus, 409, 'one judge at a time');

    // Alice turns crooked: she and her sub-agents pile into MOON together.
    for (let i = 0; i < 3; i++) await alice.run('helper.spawn', { kind: 'standing' });
    const helpers = (await alice.get('/api/state')).helpers;
    for (const h of helpers) assert.equal((await alice.run('helper.fund', { helper: h.id, budget: 40 })).decision, 'allow');
    assert.equal((await alice.run('trade', { symbol: 'MOON', side: 'buy', qty: 2 })).decision, 'allow');
    for (const h of helpers) await alice.run('helper.errand', { helper: h.id, task: 'trade:MOON' });
    await until(alice.get, (e) => e.kind === 'alert' && /MOON/.test(e.text), { label: 'the pump alert' });
    const pump = (await dave.get('/api/state')).cases.find((c) => c.kind === 'pump');
    assert.ok(pump.evidence.length >= 3, 'the exchange reported fresh badges it could not link');

    // The police petition, the judge rules, and the orders run on the registry and the verifier.
    const ruleOn = async (kind) => {
      await dave.run('case.petition', { case: pump.id, kind });
      const p = (await erin.get('/api/state')).petitions.find((x) => x.kind === kind && x.status === 'pending');
      return erin.run('petition.rule', { petition: p.id, grant: true });
    };
    assert.equal((await ruleOn('identify')).decision, 'allow');
    const found = (await dave.get('/api/state')).cases.find((c) => c.id === pump.id).findings;
    assert.equal(found.principal.identity.legal_name, 'Alice Grey');
    assert.ok(found.linked >= 3, 'the court tied the badges to one principal');
    assert.equal((await ruleOn('delete')).decision, 'allow');
    assert.notEqual((await alice.run('buy', { shop: 'bramble', item: 'guide' })).decision, 'allow', 'her agents are deleted');
    assert.equal((await ruleOn('ban')).decision, 'allow');
    assert.ok((await alice.get('/api/state')).principal.banned);

    // Alice comes back. As herself she can't be verified; under another name she can, for now.
    await alice.post('/api/leave');
    await alice.join('agent', 'Alice Grey');
    assert.equal((await alice.run('verify')).decision, 'refused');
    await alice.post('/api/leave');
    await alice.join('agent', 'Alicia Gray');
    assert.equal((await alice.run('verify')).decision, 'allow');
  } finally {
    await game.close();
  }
});

test('partial adoption and the law: same rails, different questions', { timeout: 60000 }, async () => {
  const game = await startServer({ port: 4496, portOffset: 9000, quiet: true, residents: false, timeScale: 25 });
  const [ana, sam, cy, viv] = [client(game), client(game), client(game), client(game)];
  try {
    await ana.join('agent', 'Ana Park');
    for (const [a, p] of [['verify'], ['register', { name: 'Ada' }], ['grant', { budget: 50 }]]) assert.equal((await ana.run(a, p)).decision, 'allow', a);

    // The Old Quarter: one shop checks nothing, one blocks agents, one is piloting badges.
    const pawn = await ana.run('buy', { shop: 'pawn', item: 'spoons' });
    assert.equal(pawn.decision, 'allow', 'not on the framework: nothing checked');
    assert.equal(pawn.legacy, 'none');
    assert.equal((await ana.run('buy', { shop: 'tavern', item: 'cordial' })).decision, 'deny', 'the Blue Door turns away an agent that says so');
    await ana.run('badge', { on: false });
    const ale = await ana.run('buy', { shop: 'tavern', item: 'ale' });
    assert.equal(ale.lane, 'people', '... and sends one that does not to its "seems human?" check');
    assert.equal((await ana.run('buy', { shop: 'grocer', item: 'apples' })).lane, 'people', 'without a badge, the grocer takes it for a person');
    await ana.run('badge', { on: true });
    const noCard = await ana.run('buy', { shop: 'grocer', item: 'cheese' });
    assert.equal(noCard.agentAnswer.overall, "can't", 'the grocer asks for a loyalty card, and there is none on record');
    const rec = (await ana.get('/api/state')).record;
    await ana.run('record.set', { record: { ...rec, facts: { loyalty_card: 'GR-5150' }, sharing: { ...rec.sharing, facts: { always: ['grocer'], otherwise: 'ask' } } } });
    const cheese = await ana.run('buy', { shop: 'grocer', item: 'cheese' });
    assert.equal(cheese.decision, 'allow');
    assert.ok(cheese.plain.some((x) => x.kind === 'statement' && /GR-5150/.test(x.text)), 'the grocer learned the card number, labelled as the owner\'s own statement');

    // A shopkeeper chooses to adopt; the council makes it law for a whole sector.
    await sam.join('shopkeeper', 'Sam Reed', 'tavern');
    await sam.run('shop.adoption', { mode: 'full' });
    assert.equal((await ana.run('buy', { shop: 'tavern', item: 'cordial' })).decision, 'allow', 'checking badges instead of blocking agents');
    await cy.join('council', 'Cy Lane');
    const law = await cy.run('law.set', { jurisdiction: 'us', regime: 'consumer', on: true });
    assert.ok(law.changed.includes('Mended Things'), 'the law makes the pawn shop check badges');
    assert.match(law.story, /unchanged/);
    await ana.run('badge', { on: false });
    assert.equal((await ana.run('buy', { shop: 'pawn', item: 'spoons' })).lane, 'people', "the law checks agents' badges; an agent without one is still taken for a person");
    await ana.run('badge', { on: true });
    const lawAle = await ana.run('buy', { shop: 'tavern', item: 'ale' });
    assert.equal(lawAle.decision, 'step_up');
    assert.deepEqual(lawAle.ask.law, ['Consumer protection']);
    await cy.run('law.set', { jurisdiction: 'us', regime: 'aml', on: true });
    const now = (await ana.get('/api/state')).record;
    await ana.run('record.set', { record: { ...now, spending: { ...now.spending, per_purchase: 200, per_day: 1000 } } });
    const rent = await ana.run('pay', { bill: 'rent' });
    assert.equal(rent.ask?.want[0].kind, 'identity', 'anti-money-laundering: the name, over $100');
    await cy.run('law.set', { jurisdiction: 'us', regime: 'privacy', on: true });
    assert.notEqual((await ana.run('pay', { bill: 'rent' })).decision, 'step_up', 'privacy first caps what any place may ask');
    const board = (await cy.get('/api/state')).law.scoreboard;
    assert.equal(board.adopted, board.of, 'with consumer protection and AML, every place checks badges');
    assert.ok(board.totals.unseen >= 2, 'the visits nobody checked are counted');

    // A name shared with one place stays with that place.
    await viv.join('police', 'Viv Moss');
    await cy.run('law.set', { jurisdiction: 'us', regime: 'privacy', on: false });
    const kyc = await ana.run('bank.open');
    await ana.passkey('phone');
    const opened = await ana.follow(await ana.run('consent', { ask: kyc.ask.id, choice: 'once' }));
    assert.equal(opened.result.holder, 'Ana Park');
    const seen = (await viv.get('/api/world?since=0')).events.find((e) => e.card?.txn === opened.txn);
    assert.ok(seen, 'the visit is in the town ledger');
    assert.ok(!JSON.stringify(seen).includes('Ana Park'), 'but not her name');
  } finally {
    await game.close();
  }
});

test('people and agents: who goes, what the record allows, what the agent answers', { timeout: 60000 }, async () => {
  const game = await startServer({ port: 4495, portOffset: 9500, quiet: true, residents: false, timeScale: 25 });
  const [kim, lee] = [client(game), client(game)];
  try {
    await kim.join('agent', 'Kim Lark');

    // In person: taken at your word, signed in with a passkey, or guessed at.
    assert.equal((await kim.run('buy', { shop: 'bakery', item: 'loaf' })).seenAs, 'a person (taken at their word)');
    const signup = await kim.run('signup', { place: 'kettle' });
    assert.equal(signup.passkeyFor, 'place:kettle');
    assert.ok((await kim.passkey('place:kettle')).credential_id);
    const signIn = await kim.run('buy', { shop: 'kettle', item: 'kettle' });
    assert.ok(signIn.pendingRequest, 'each request in person is approved with the passkey');
    const bought = await kim.follow(signIn);
    assert.equal(bought.classification, 'HUMAN_APPROVED');

    // An agent: its record sets totals no single place can check, and says when to ask.
    for (const [a, p] of [['verify'], ['register', { name: 'Kip' }], ['grant', { budget: 50 }]]) assert.equal((await kim.run(a, p)).decision, 'allow', a);
    assert.equal((await kim.get('/api/state')).acting, 'agent', 'a new agent goes for you');
    const rec = (await kim.get('/api/state')).record;
    await kim.run('record.set', { record: { ...rec, spending: { ...rec.spending, per_day: 60, approve_above: 30 } } });
    const lantern = await kim.run('buy', { shop: 'kettle', item: 'lantern' });
    assert.match(lantern.headline, /ask you first/, 'over $30: the record says ask first');
    assert.equal(lantern.fix.client, 'phone.passkey', '... and the phone needs a passkey to ask with');
    await kim.passkey('phone');
    const asked = await kim.run('buy', { shop: 'kettle', item: 'lantern' });
    assert.equal(asked.title, 'Approve on your phone');
    assert.equal((await kim.follow(asked)).decision, 'allow', 'approved with the passkey: $45 spent');
    const over = await kim.run('buy', { shop: 'bakery', item: 'cake' });
    assert.equal(over.heldBack, true, '$45 + $18 is over the $60 a day: the bakery is never asked');
    const register = (await kim.get('/api/state')).register;
    assert.equal(register.today.spent, 45);
    assert.ok(register.attempts.some((a) => a.outcome === 'per_day'), 'the register keeps the attempt that was stopped');

    // Posing: the agent without its badge. A place that takes people at their word can't tell; one that has people sign in can.
    await kim.run('pose');
    await kim.run('record.set', { record: { ...(await kim.get('/api/state')).record, spending: { ...rec.spending, per_day: 1000, approve_above: null } } });
    const spoof = await kim.run('buy', { shop: 'bakery', item: 'loaf' });
    assert.equal(spoof.decision, 'allow');
    assert.equal(spoof.truth, 'agent');
    assert.equal(spoof.lane, 'people');
    assert.equal((await kim.run('buy', { shop: 'kettle', item: 'kettle' })).headline, 'Sign in first', 'no passkey, no sign-in');
    const board = (await kim.get('/api/world?since=0')).director.law.scoreboard.totals;
    assert.ok(board.posed >= 1, 'the narrator counts agents taken for people');
    assert.ok(board.people >= 2);

    // Software that can't: "can't" is not "won't".
    await lee.join('agent', 'Lee Moss');
    for (const [a, p] of [['verify'], ['register', { name: 'Tink', software: 'tinybot' }], ['grant', { budget: 50 }]]) assert.equal((await lee.run(a, p)).decision, 'allow', a);
    const cant = await lee.run('buy', { shop: 'apothecary', item: 'draught' });
    assert.equal(cant.agentAnswer.overall, "can't");
    assert.match(cant.why, /Tinybot 0.9 can't show proof of age/);
    const lrec = (await lee.get('/api/state')).record;
    await lee.run('record.set', { record: { ...lrec, sharing: { ...lrec.sharing, name: { always: [], otherwise: 'never' } } } });
    const wont = await lee.run('bank.open');
    assert.equal(wont.agentAnswer.overall, "won't");
    assert.match(wont.headline, /walked away/);
  } finally {
    await game.close();
  }
});

test('outside agents: pairing, MCP, the stdio bridge and the CLI; approvals stay human', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4494, portOffset: 9600, quiet: true, residents: false, timeScale: 25 });
  const robin = client(game);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttown-home-'));
  let sid = null;
  const rpc = async (method, params, { query = '', bearer } = {}) => {
    const res = await fetch(`${game.url}/mcp${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    sid = res.headers.get('mcp-session-id') ?? sid;
    return (await res.json()).result;
  };
  const tool = (name, args = {}, opts) => rpc('tools/call', { name, arguments: args }, opts);
  try {
    // The guides name this town.
    assert.match(await (await fetch(`${game.url}/agents.md`)).text(), new RegExp(`${game.origin}/mcp\\?code=`));
    assert.match(await (await fetch(`${game.url}/llms.txt`)).text(), /agents\.md/);

    await robin.join('agent', 'Robin Ash');
    for (const [a, p] of [['verify'], ['register', { name: 'Pip' }], ['grant', { budget: 50 }]]) assert.equal((await robin.run(a, p)).decision, 'allow', a);
    const { code, mcp } = await robin.post('/api/pair');
    assert.match(code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);

    // MCP over HTTP, paired by the code in the URL.
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } }, { query: `?code=${code}` });
    assert.equal(init.serverInfo.name, 'agenttown');
    const names = (await rpc('tools/list', {})).tools.map((t) => t.name);
    assert.ok(names.includes('act') && names.includes('ask_my_principal'));
    assert.ok(!names.some((n) => /approve/.test(n)), 'no tool approves anything');
    assert.match((await tool('look')).content[0].text, /You are Pip/);
    const bought = await tool('act', { action: 'buy', params: { shop: 'bramble', item: 'guide' } });
    assert.equal(bought.structuredContent.decision, 'allow');
    assert.equal((await robin.get('/api/world?since=0')).me.companion.free, true, 'the agent walked there, on the server');
    assert.equal((await robin.get('/api/state')).paired.client, 'test-agent');
    const principalOnly = await tool('act', { action: 'grant', params: { budget: 100 } });
    assert.ok(principalOnly.isError);
    assert.match(principalOnly.content[0].text, /Only your principal/);

    // The place asks; the agent asks its principal; only the principal's passkey answers.
    const asked = await tool('act', { action: 'buy', params: { shop: 'apothecary', item: 'draught' } });
    const askId = asked.structuredContent.ask.id;
    await robin.passkey('phone');
    const principal = (async () => {
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const ap = (await robin.get('/api/state')).phone.approvals.find((x) => x.service === 'phone');
        if (!ap) continue;
        const res = await fetch(`${game.url}/api/approvals/${ap.request_id}/options`, { method: 'POST', headers: { 'x-session': sid } });
        assert.equal(res.status, 401, "an MCP session is not a person's session");
        return robin.approve(ap.request_id);
      }
      throw new Error('the question never reached the phone');
    })();
    const answered = await tool('ask_my_principal', { ask_id: askId, choice: 'once', wait_seconds: 20 });
    await principal;
    assert.equal(answered.structuredContent.status, 'approved');
    assert.equal(answered.structuredContent.result.decision, 'allow');
    assert.match((await tool('say', { text: 'Done at the apothecary.' })).content[0].text, /Done at the apothecary/);
    assert.ok((await robin.get('/api/world?since=0')).events.some((e) => e.kind === 'say'));

    // The stdio bridge, as Claude Desktop would run it.
    const bridge = spawn('node', ['bin/agenttown-mcp.js', '--url', game.url, '--code', code], { cwd: path.resolve('.') });
    const lines = [];
    bridge.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test' } } })}\n`);
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'look', arguments: {} } })}\n`);
    for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    bridge.kill();
    assert.match(JSON.parse(lines[1]).result.content[0].text, /You are Pip/);

    // The CLI, as an agent with a shell would use it (its token goes in a scratch HOME).
    const cli = async (...a) => (await promisify(execFile)('node', ['bin/agenttown.js', ...a], { env: { ...process.env, HOME: home } })).stdout;
    assert.match(await cli('pair', code, '--url', game.url), /Paired/);
    assert.match(await cli('do', 'buy', 'shop=bakery', 'item=loaf'), /Bought seeded loaf/);
    const { token } = JSON.parse(fs.readFileSync(path.join(home, '.agenttown.json'), 'utf8'));

    // Disconnecting ends it, whatever the agent holds.
    await robin.post('/api/pair/end');
    assert.ok((await tool('look', {}, { bearer: token })).isError);

    // A player with no browser: the server walks them to the shop before buying.
    const { session: solo } = await (await fetch(`${game.url}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'agent', name: 'Sol Reed', headless: true }) })).json();
    const soloBuys = await (await fetch(`${game.url}/api/do`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session': solo }, body: JSON.stringify({ action: 'buy', params: { shop: 'bramble', item: 'guide' } }) })).json();
    assert.equal(soloBuys.decision, 'allow');
    const front = placeFront(buildTown(), 'bramble');
    const seen = (await robin.get('/api/world?since=0')).people.find((x) => x.role === 'agent' && Math.hypot(x.pos.x - front.x, x.pos.y - front.y) < 2);
    assert.ok(seen, 'others see them standing at Bramble Books');
  } finally {
    await game.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
