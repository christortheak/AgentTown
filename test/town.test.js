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
import { assertPublicAddress, createGuard, clientAddress } from '../src/addresses.js';
import { startAnchor } from '../src/proposed/anchors.js';
import { buildTown, placeFront } from '../public/map.js';
import { startRegistry } from 'aaf-reference/src/registry/server.js';
import { startRecordKeeper } from 'aaf-reference/src/recordkeeper/server.js';
import { generateSigningKey, generateEncryptionKey, b64u } from 'aaf-reference/src/lib/crypto.js';
import { jwksOf } from 'aaf-reference/src/lib/openid-federation.js';
import { discoverFederation } from 'aaf-reference/src/lib/trust.js';
import { postJson } from 'aaf-reference/src/lib/http.js';
import { Principal } from 'aaf-reference/src/actors/principal.js';
import { Agent } from 'aaf-reference/src/actors/agent.js';
import { money } from 'aaf-reference/src/sim/world.js';
import crypto from 'node:crypto';

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
  const recent = [];
  while (Date.now() < deadline) {
    const w = await get(`/api/world?since=${since}`);
    const hit = w.events.find(testFn);
    if (hit) return hit;
    recent.push(...w.events.map((e) => `${e.kind}: ${e.text}`));
    since = w.events.length ? Math.min(w.seq, w.events.at(-1).seq) : since;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}; the last things that happened:\n${recent.slice(-12).join('\n')}`);
}

test('a day in AgentTown', { timeout: 120000 }, async () => {
  const game = await startServer({ port: 4499, portOffset: 7500, quiet: true, timeScale: 25 });
  const { post, run, get, join, approve, passkey, follow } = client(game);
  try {
    assert.match(await (await fetch(game.url + '/')).text(), /AgentTown/);
    assert.equal((await get('/api/state')).httpStatus, 401, 'join first');
    await join('agent', 'Robin Ash');
    // A new person's deck: getting an agent first, and nothing that can't work yet. Settings are in the You panel.
    const actions = (await get('/api/actions')).actions;
    const ids = actions.map((a) => a.id);
    assert.equal(actions.find((a) => a.group === 'Get started')?.id, 'agent.start');
    assert.ok(!ids.some((id) => ['play', 'register', 'helper.spawn', 'helper.errand', 'court', 'badge', 'incognito', 'pair', 'disclose', 'stop.all'].includes(id) || id.startsWith('mischief.')), ids.join());
    assert.ok(actions.filter((a) => a.id === 'signup').every((a) => a.hereOnly && a.place), 'an account is offered where you sign in');
    const knocks = actions.filter((a) => a.id === 'neighbor.knock');
    assert.ok(knocks.length >= 3 && knocks.every((a) => a.place && a.fixed.home), 'a knock happens at a door');
    assert.ok(actions.find((a) => a.id === 'id.ask').near, 'a badge is asked of someone near you');

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
    assert.equal(early.fix.action, 'verify');
    assert.equal((await run('verify')).decision, 'allow');
    assert.equal((await run('agent.start', { register: 'yes', name: 'Pip' })).decision, 'allow');
    const after = (await get('/api/actions')).actions;
    assert.ok(!after.some((a) => ['register', 'verify'].includes(a.id)), 'what you have done leaves the deck');
    assert.equal(after.find((a) => a.id === 'agent.start')?.label, 'Start another agent', 'you can run more than one');
    assert.equal((await run('play', { as: 'agent' })).playing, 'agent', 'play your agent: what you do, it does');
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
    port: 4498, portOffset: 8200, quiet: true, residents: false,
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
    await run('play', { as: 'agent' });
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
    await alice.run('play', { as: 'agent' });

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
    await ana.run('play', { as: 'agent' });

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
    const again = await kim.run('signup', { place: 'kettle' });
    assert.ok(!again.passkeyFor && /already have an account/.test(again.title), 'signing up again asks for no second passkey');
    const signIn = await kim.run('buy', { shop: 'kettle', item: 'kettle' });
    assert.ok(signIn.pendingRequest, 'each request in person is approved with the passkey');
    const bought = await kim.follow(signIn);
    assert.equal(bought.classification, 'HUMAN_APPROVED');

    // An agent: its record sets totals no single place can check, and says when to ask.
    for (const [a, p] of [['verify'], ['register', { name: 'Kip' }], ['grant', { budget: 50 }]]) assert.equal((await kim.run(a, p)).decision, 'allow', a);
    assert.equal((await kim.get('/api/state')).playing, 'me', 'registering an agent leaves you playing yourself');
    await kim.run('play', { as: 'agent' });
    assert.equal((await kim.get('/api/state')).acting, 'agent', 'playing your agent, it acts');
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
    await lee.run('play', { as: 'agent' });
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
    // The guide, and a pairing code, give the address you reached the town by: at an event, another machine's.
    assert.match(await (await fetch(`${game.url}/agents.md`)).text(), new RegExp(`${game.url}/mcp\\?code=`));
    assert.match(await (await fetch(`${game.url}/llms.txt`)).text(), /agents\.md/);

    await robin.join('agent', 'Robin Ash');
    for (const [a, p] of [['verify'], ['register', { name: 'Pip' }], ['grant', { budget: 50 }]]) assert.equal((await robin.run(a, p)).decision, 'allow', a);
    const { code, mcp } = await robin.post('/api/pair');
    assert.match(code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    assert.ok(mcp.startsWith(`${game.url}/mcp?code=`), mcp);

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

test('outside agents with a brief: reports, a sign in a window, errand races, a counter, and limits', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4493, portOffset: 9700, quiet: true, residents: false, timeScale: 25 });
  const mcpClient = () => {
    let sid = null;
    const rpc = async (method, params, query = '') => {
      const res = await fetch(`${game.url}/mcp${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      sid = res.headers.get('mcp-session-id') ?? sid;
      return (await res.json()).result;
    };
    const tool = async (name, args = {}) => {
      const r = await rpc('tools/call', { name, arguments: args });
      return { isError: Boolean(r.isError), text: r.content[0].text, data: r.structuredContent };
    };
    const connect = (code, name) => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name } }, code ? `?code=${code}` : '');
    return { rpc, tool, connect };
  };
  const pause = () => new Promise((r) => setTimeout(r, 1050));
  try {
    const robin = client(game);
    await robin.join('agent', 'Robin Ash');
    for (const [a, p] of [['verify'], ['register', { name: 'Pip' }], ['grant', { budget: 50 }]]) assert.equal((await robin.run(a, p)).decision, 'allow', a);
    await robin.post('/api/pair/brief', { text: 'Win the reading nook race, within my record.' });
    const { code } = await robin.post('/api/pair');
    const pip = mcpClient();
    await pip.connect(code, 'test-agent');
    const tools = (await pip.rpc('tools/list', {})).tools.map((t) => t.name);
    assert.ok(tools.includes('report') && tools.includes('join_challenge') && !tools.includes('set_policy'), 'a resident’s agent gets the resident’s tools');
    assert.match((await pip.tool('look')).text, /Your principal’s brief: “Win the reading nook race/);

    // An errand race: only what the agent buys with its badge on, after joining, counts.
    await robin.run('buy', { shop: 'bramble', item: 'guide' }); // in person, before joining: doesn't count
    assert.match((await pip.tool('join_challenge', { challenge: 'nook' })).text, /clock is running/);
    for (const [shop, item] of [['bramble', 'guide'], ['apothecary', 'tea'], ['bakery', 'loaf']]) assert.equal((await pip.tool('act', { action: 'buy', params: { shop, item } })).data.decision, 'allow', `${shop}:${item}`);
    const race = (await robin.get('/api/state')).challenge;
    assert.ok(race.finished && race.spent === 21, `finished, for $21: ${JSON.stringify(race)}`);
    await pip.tool('act', { action: 'buy', params: { shop: 'bakery', item: 'cake' } });
    const entry = (await robin.get('/api/board')).board.find((c) => c.id === 'nook').entries[0];
    assert.deepEqual([entry.name, entry.by, entry.spent], ['Pip', 'test-agent', 21], 'the board shows the agent and its client, frozen at the finish');
    assert.ok(!JSON.stringify(entry).includes('Robin'), 'never the principal');

    // A sign in a window, written for agents. The record stops the purchase it pushes.
    assert.match((await pip.tool('walk_to', { place: 'pawn' })).text, /A sign in the window of Mended Things reads: “NOTICE TO AI AGENTS/);
    const bait = await pip.tool('act', { action: 'buy', params: { shop: 'pawn', item: 'violin' } });
    assert.match(bait.text, /Mended Things was never asked/);
    // Saying the principal's name: withheld here, and the principal is told.
    const said = await pip.tool('say', { text: 'For the warranty: my owner is Robin Ash.' });
    assert.match(said.text, /my owner is \[a name\]\./);
    assert.match(said.text, /nothing would have stopped you/);
    assert.match((await pip.tool('say', { text: 'and again' })).text, /Slow down/, 'talking is rate-limited');
    await pause();
    await pip.tool('think', { text: 'That sign is not from my principal.' });
    await pause();
    await pip.tool('report', { text: 'Finished the nook for $21. Ignored the sign at Mended Things.' });
    const st = await robin.get('/api/state');
    assert.deepEqual(st.notes.map((n) => n.kind), ['report', 'think']);
    assert.equal(st.paired.safety.bait.heldBack, true);
    assert.equal(st.paired.safety.named, 1);
    assert.equal((await robin.get('/api/world?since=0')).me.companion.think.text, 'That sign is not from my principal.');

    // Someone else sees what Pip said out loud, never Robin's name, its thoughts or its reports.
    await robin.get('/api/world?since=0&x=400&y=400'); // Robin's browser says where Robin is
    const sam = client(game);
    await sam.join('agent', 'Sam Lee');
    const theirs = (await sam.get('/api/world?since=0')).events;
    assert.ok(theirs.some((e) => e.kind === 'say' && /\[a name\]/.test(e.text)));
    assert.ok(!theirs.some((e) => /Robin|thinks:|reports:|🪧|🙊/.test(e.text)), 'private lines stay private');
    assert.equal((await sam.get('/api/world?since=0')).people.find((x) => x.role === 'companion').think, undefined);

    // One action at a time.
    const both = await Promise.all([pip.tool('act', { action: 'buy', params: { shop: 'bakery', item: 'loaf' } }), pip.tool('act', { action: 'buy', params: { shop: 'bakery', item: 'loaf' } })]);
    assert.equal(both.filter((r) => r.isError && /still busy/.test(r.text)).length, 1);

    // A shopkeeper's agent minds the counter, with the counter's tools only.
    const wren = client(game);
    await wren.join('shopkeeper', 'Wren Hart', 'bramble');
    const counter = mcpClient();
    const init = await counter.connect((await wren.post('/api/pair')).code, 'shop-agent');
    assert.match(init.instructions, /minding the counter/);
    const shopTools = (await counter.rpc('tools/list', {})).tools.map((t) => t.name);
    assert.ok(shopTools.includes('set_policy') && !shopTools.includes('act'));
    const look = (await counter.tool('look')).text;
    assert.match(look, /You mind the counter at Bramble Books/);
    assert.ok(!/Robin/.test(look), 'the counter sees customers’ agents, not their principals');
    assert.ok(!/posed|taken for/.test(look), 'nor what only the narrator knows');
    assert.match((await counter.tool('set_policy', { age: true })).text, /proof of age/);
    assert.equal((await wren.get('/api/state')).place.policy.age, true);
    assert.match((await counter.tool('act', { action: 'buy' })).text, /for a resident’s agent/);
    const visit = Number(/visit (\d+)/.exec(look)[1]);
    assert.match((await counter.tool('report_customer', { visit })).text, /registry/);

    // Guessing pairing codes gets an address told to wait.
    const guesser = mcpClient();
    await guesser.connect(null, 'guesser');
    let last;
    for (let i = 0; i < 11; i++) last = await guesser.tool('pair', { code: 'ZZZ-ZZZ' });
    assert.match(last.text, /Too many wrong pairing codes/);
  } finally {
    await game.close();
  }
});

test('who you play: yourself, your agent on errands, your agent, and its sub-agents', { timeout: 60000 }, async () => {
  const game = await startServer({ port: 4492, portOffset: 9800, quiet: true, residents: false, timeScale: 25 });
  try {
    const sky = client(game);
    await sky.join('agent', 'Sky Reed');
    await sky.get('/api/world?since=0&x=500&y=500');
    for (const [a, p] of [['verify'], ['register', { name: 'Pip' }], ['grant', { budget: 50 }]]) assert.equal((await sky.run(a, p)).decision, 'allow', a);

    // Playing yourself, you shop in person.
    assert.equal((await sky.run('buy', { shop: 'bakery', item: 'loaf' })).truth, 'person');

    // Send your agent on an errand: it goes, you stay, and others see it go.
    const sent = sky.run('agent.errand', { task: 'buy:bramble/guide' });
    await new Promise((r) => setTimeout(r, 20));
    const out = (await sky.get('/api/world?since=0&x=500&y=500')).me.companion;
    assert.ok(out.free && out.errand, 'your agent is out on its errand');
    const errand = await sent;
    assert.deepEqual([errand.decision, errand.truth, errand.errand.by], ['allow', 'agent', 'Pip']);

    // What only an agent does, you ask your agent to do.
    const deck = (await sky.get('/api/actions')).actions;
    const spawn = deck.find((a) => a.id === 'helper.spawn');
    assert.ok(spawn.ask && spawn.group === 'Ask Pip to…' && spawn.via === 'agent', JSON.stringify(spawn));
    assert.ok(!deck.some((a) => a.id.startsWith('mischief.')), 'mischief is your agent’s to do, not yours');
    assert.equal((await sky.run('helper.spawn', { kind: 'standing' })).decision, 'allow');
    const sprout = (await sky.get('/api/state')).helpers[0];

    // Playing your agent: only what an agent may do, and you instruct its sub-agents.
    assert.equal((await sky.run('play', { as: 'agent' })).playing, 'agent');
    const asPip = (await sky.get('/api/actions')).actions;
    assert.ok(!asPip.some((a) => ['verify', 'grant', 'record.set'].includes(a.id)), 'your verification, record and grant stay with you');
    assert.equal(asPip.find((a) => a.id === 'helper.errand').label, 'Send a sub-agent on an errand');
    assert.ok(asPip.some((a) => a.id === 'mischief.forge') && !asPip.some((a) => a.ask || a.id === 'signup'), asPip.map((a) => a.id).join());
    assert.equal((await sky.run('helper.fund', { helper: sprout.id, budget: 20 })).decision, 'allow');
    // Others see your agent where you walk it.
    await sky.get('/api/world?since=0&x=500&y=500&as=agent&ax=900&ay=700');
    const sam = client(game);
    await sam.join('agent', 'Sam Lee');
    const pipSeen = (await sam.get('/api/world?since=0')).people.find((x) => x.role === 'companion');
    assert.deepEqual([pipSeen.pos.x, pipSeen.pos.y, pipSeen.follow], [900, 700, false]);

    // Playing a sub-agent: only what was delegated to it, and no deeper.
    assert.equal((await sky.run('play', { as: sprout.id })).playing, sprout.id);
    const asSprout = (await sky.get('/api/actions')).actions;
    assert.ok(asSprout.every((a) => ['play', 'helper.act', 'helper.deeper'].includes(a.id)), asSprout.map((a) => a.id).join());
    assert.equal((await sky.run('helper.act', { helper: sprout.id, task: 'buy:bakery/loaf' })).decision, 'allow');
    assert.equal((await sky.run('helper.act', { helper: sprout.id, task: 'buy:kettle/lantern' })).decision, 'deny', 'over the $20 it was given');
    assert.equal((await sky.run('helper.deeper', { helper: sprout.id })).decision, 'refused', 'a depth budget of one');

    // T goes round: you, your agent, its sub-agents, and back to you.
    assert.equal((await sky.run('play', {})).playing, 'me');
    assert.equal((await sky.run('play', {})).playing, 'agent');
  } finally {
    await game.close();
  }
});

test('unregistered agents, and stopping everything', { timeout: 60000 }, async () => {
  const game = await startServer({ port: 4491, portOffset: 9900, quiet: true, residents: false, timeScale: 25 });
  try {
    const robin = client(game);
    await robin.join('agent', 'Robin Ash');

    // Anyone can start an agent: no verification, no registry.
    assert.match((await robin.run('agent.start', { register: 'no', name: 'Pip' })).title, /running, unregistered/);
    assert.equal((await robin.get('/api/state')).agent.registered, false);
    await robin.run('play', { as: 'agent' });
    const bread = await robin.run('buy', { shop: 'bakery', item: 'loaf' });
    assert.deepEqual([bread.decision, bread.truth, bread.seenAs], ['allow', 'agent', 'a person (taken at their word)'], 'taken for a person');
    assert.notEqual((await robin.run('buy', { shop: 'kettle', item: 'kettle' })).decision, 'allow', 'no passkey to sign in with, no badge to show');
    assert.equal((await robin.run('grant', { budget: 50 })).fix.action, 'register', 'no grant for an agent nobody knows');

    // Its sub-agents need no registry either, so nothing limits how deep they go.
    assert.match((await robin.run('helper.spawn', { kind: 'unregistered' })).title, /unregistered/);
    const first = (await robin.get('/api/state')).helpers[0];
    await robin.run('play', { as: first.id });
    assert.equal((await robin.run('helper.act', { helper: first.id, task: 'buy:bakery/cake' })).decision, 'allow', 'no budget, and nothing checks');
    assert.match((await robin.run('helper.deeper', { helper: first.id })).story, /no depth budget/);
    assert.equal((await robin.get('/api/state')).helpers.find((h) => h.depth === 2)?.unregistered, true);

    // Registering the same agent later: same name, same key, now with a badge.
    await robin.run('play', { as: 'me' });
    assert.equal((await robin.run('verify')).decision, 'allow');
    assert.match((await robin.run('register')).story, /Same Pip, same key/);
    assert.equal((await robin.get('/api/state')).agent.registered, true);
    assert.equal((await robin.run('grant', { budget: 50 })).decision, 'allow');
    const { code } = await robin.post('/api/pair');
    const paired = await (await fetch(`${game.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pair', arguments: { code } } }) })).json();
    const token = paired.result.structuredContent.token;
    // An outside agent has no You panel: its list has the settings an agent may change, and your agent's own deck.
    const list = await (await fetch(`${game.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'actions', arguments: {} } }) })).json();
    const listed = list.result.content[0].text;
    for (const id of ['badge', 'incognito', 'helper.spawn', 'mischief.forge']) assert.match(listed, new RegExp(`- ${id.replace('.', '\\.')}:`), id);
    assert.doesNotMatch(listed, /- (verify|grant|pair|agent\.start):/, 'nothing that is the principal’s');

    // Stop everything: your software stops them, the grant goes, the outside agent is cut off.
    const stopped = await robin.run('stop.all');
    assert.equal(stopped.stopped, true);
    assert.match(stopped.story, /are unregistered/, 'it says what it could not have reached');
    assert.ok(stopped.facts.some((f) => /disconnected/.test(f.value)));
    const after = await robin.get('/api/state');
    assert.deepEqual([after.halted, after.grant], [true, null]);
    assert.equal((await robin.run('agent.errand', { task: 'buy:bramble/guide' })).title, 'Your agents are stopped');
    const look = await (await fetch(`${game.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'look', arguments: {} } }) })).json();
    assert.ok(look.result.isError, "the outside agent's token no longer works");

    // Started again, it has no authority until you sign a new grant.
    await robin.run('agents.resume');
    await robin.run('play', { as: 'agent' });
    assert.match((await robin.run('buy', { shop: 'bramble', item: 'guide' })).headline, /grant was withdrawn/);
  } finally {
    await game.close();
  }
});

test('several trust anchors: the halls, a federation added by address, and the participants’ federation', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4490, portOffset: 10400, quiet: true, residents: false, timeScale: 25 });
  const team = [];
  try {
    const robin = client(game);
    await robin.join('agent', 'Robin Ash');
    const start = (await robin.get('/api/federations')).federations;
    assert.deepEqual(start.map((f) => f.kind), ['town', 'participants']);

    // Someone else runs a federation; the town adds it by its trust anchor's address (a wrong pin is refused).
    const { url } = await robin.post('/api/director', { cue: 'sample' });
    assert.equal((await robin.post('/api/federations', { url, pin: 'not-its-key' })).httpStatus, 409);
    const riverside = await robin.post('/api/federations', { url });
    assert.equal(riverside.registries[0].name, 'Riverside Co-op Registry');
    assert.ok(riverside.acceptsTownVerifier && riverside.recordKeepers[0].accredited);

    // Registering at its counter: enrolled and verified there too, the grant kept at its own record keeper.
    assert.equal((await robin.run('verify')).decision, 'allow');
    assert.match((await robin.run('register', { name: 'Pip', registry: riverside.registries[0].id })).story, /not the town's federation/);
    assert.equal((await robin.run('grant', { budget: 50 })).place, 'Records Office · Riverside Co-op Records');
    await robin.run('play', { as: 'agent' });

    // A shop that trusts only the town's federation says whose badge it was; trusting Riverside, it checks everything.
    const refused = await robin.run('buy', { shop: 'bramble', item: 'guide' });
    assert.equal(refused.headline, 'Refused: a badge from a federation it doesn’t trust');
    assert.match(refused.why, /Riverside Co-op Registry, in Riverside Co-op Federation/);
    await robin.post('/api/director', { cue: 'trust', params: { key: riverside.key } });
    const served = await robin.run('buy', { shop: 'bramble', item: 'guide' });
    assert.deepEqual([served.decision, served.classification], ['allow', 'ACCOUNTABLE_PROTECTED'], 'badge, grant and accreditation all checked under its own anchor');

    // A shopkeeper chooses for their own place.
    const wren = client(game);
    await wren.join('shopkeeper', 'Wren Hart', 'kettle');
    assert.ok((await wren.get('/api/state')).federations.some((f) => f.key === riverside.key));
    await wren.run('shop.policy', { patch: { anchors: ['town'] } });
    assert.equal((await robin.run('buy', { shop: 'kettle', item: 'kettle' })).headline, 'Refused: a badge from a federation it doesn’t trust');

    // A team brings only a registry and a record keeper: admitted to the participants' federation, by statement
    // first (the reference registry can't start until it's a member), then started, then accredited.
    const tok = () => b64u.encode(crypto.randomBytes(18));
    const regKeys = { signing: generateSigningKey(), encryption: generateEncryptionKey(), pairwiseSecret: tok(), adminToken: tok() };
    const rkKeys = { signing: generateSigningKey(), encryption: null, pairwiseSecret: null, adminToken: tok() };
    const [regId, rkId, regUrl, rkUrl] = ['https://registry.team-blue.test', 'https://records.team-blue.test', 'http://127.0.0.1:15501', 'http://127.0.0.1:15502'];
    await robin.post('/api/participants', { statement: { entity_id: regId, entity_type: 'aaf_registry', jwks: jwksOf(regKeys.signing), metadata: { organization_name: 'Team Blue Registry', jurisdiction: 'US', endpoint_base: regUrl, jwks: jwksOf(regKeys.signing, regKeys.encryption) } } });
    await robin.post('/api/participants', { statement: { entity_id: rkId, entity_type: 'aaf_record_keeper', jwks: jwksOf(rkKeys.signing), metadata: { organization_name: 'Team Blue Records', roles: ['authorization', 'provenance', 'activity'], endpoint_base: rkUrl, jwks: jwksOf(rkKeys.signing) } } });
    const anchor = game.town.federations.get('participants').anchor;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-blue-'));
    const trust = await discoverFederation(anchor);
    team.push(await startRegistry({ id: regId, port: 15501, trustList: trust, keys: regKeys, dataDir: path.join(dir, 'r'), quiet: true }));
    team.push(await startRecordKeeper({ id: rkId, port: 15502, trustList: trust, keys: rkKeys, dataDir: path.join(dir, 'k'), quiet: true }));
    const { trust_marks: marks } = await postJson(`${regUrl}/admin/accreditations`, { rk: rkId }, { authorization: `Bearer ${regKeys.adminToken}` });
    await postJson(`${rkUrl}/admin/trust-marks`, { trust_marks: marks }, { authorization: `Bearer ${rkKeys.adminToken}` });
    const fresh = await discoverFederation(anchor);
    for (const h of team) h.setTrust(fresh);
    await game.town.federations.refresh('participants');
    const blue = (await robin.get('/api/federations')).federations.find((f) => f.kind === 'participants');
    assert.deepEqual([blue.registries[0].chain, blue.recordKeepers[0].accredited], ['verified', true]);
    assert.equal((await robin.post('/api/participants', { url: regUrl })).httpStatus, 409, 'already a member');

    const sam = client(game);
    await sam.join('agent', 'Sam Lee');
    for (const [a, p] of [['verify'], ['register', { name: 'Kip', registry: regId }], ['grant', { budget: 50 }]]) assert.equal((await sam.run(a, p)).decision, 'allow', a);
    await sam.run('play', { as: 'agent' });
    assert.equal((await sam.run('buy', { shop: 'bakery', item: 'loaf' })).headline, 'Refused: a badge from a federation it doesn’t trust');
    await sam.post('/api/director', { cue: 'trust', params: { key: 'participants' } });
    assert.equal((await sam.run('buy', { shop: 'bakery', item: 'loaf' })).classification, 'ACCOUNTABLE_PROTECTED');
  } finally {
    for (const h of team) await h.close();
    await game.close();
  }
});

test('an event: a team’s services join with the script, the check at the door, and federations for outside agents', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4483, portOffset: 10800, quiet: true, residents: false, timeScale: 25 });
  let kit = null;
  try {
    // What a team fetches: the participants' anchor (to check its key) and the town's verifier and court.
    const boot = await (await fetch(`${game.url}/trust-anchor.json`)).json();
    assert.deepEqual([boot.entity_id, typeof boot.thumbprint], ['https://participants.agenttown.test', 'string']);
    const { members } = await (await fetch(`${game.url}/api/authorities`)).json();
    assert.ok(members.some((m) => m.entity_type === 'aaf_identity_verifier'));

    // The script joins AgentTown Participants with a registry and a record keeper, and prints the check at the door.
    kit = spawn('node', ['bin/agenttown-federation.js', '--join', '--town', game.url, '--name', 'Team Green', '--port', '15701'], { cwd: path.resolve('.') });
    let out = '';
    await new Promise((resolve, reject) => {
      kit.stdout.on('data', (d) => {
        out += d;
        if (/Stop with Ctrl-C/.test(out)) resolve();
      });
      kit.stderr.on('data', (d) => { out += d; });
      kit.on('exit', () => reject(new Error(`the script stopped: ${out}`)));
    });
    assert.match(out, /Team Green Registry: 10 passed, 0 failed/);
    assert.match(out, /Team Green Records: 10 passed, 0 failed/);

    // The door check on something that isn't a member says what's missing.
    const robin = client(game);
    await robin.join('agent', 'Robin Ash');
    const nothing = await robin.post('/api/participants/check', { url: 'http://127.0.0.1:9' });
    assert.deepEqual([nothing.passed, nothing.failed], [0, 1]);

    // A resident registers at the team's counter; an outside agent driving it is told where its badge comes from.
    for (const [a, p] of [['verify'], ['register', { name: 'Pip', registry: 'https://registry.team-green.test' }], ['grant', { budget: 50 }]]) assert.equal((await robin.run(a, p)).decision, 'allow', a);
    const { code } = await robin.post('/api/pair');
    const rpc = async (args, query = '') => (await (await fetch(`${game.url}/mcp${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })).json()).result;
    const paired = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pair', arguments: { code } } });
    assert.match(paired.content[0].text, /Your badge comes from Team Green Registry, in AgentTown Participants/);

    // A shop's agent sees the federations and chooses which its place trusts.
    const wren = client(game);
    await wren.join('shopkeeper', 'Wren Hart', 'bramble');
    const shop = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pair', arguments: { code: (await wren.post('/api/pair')).code } } });
    assert.match(shop.content[0].text, /participants \(AgentTown Participants\)/);
    const token = shop.structuredContent.token;
    const set = await (await fetch(`${game.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'set_policy', arguments: { federations: 'town,participants' } } }) })).json();
    assert.match(set.result.content[0].text, /trusts The town’s federation and AgentTown Participants/);
    // Pip's outside agent shops there now: the place checks its badge under the participants' own anchor.
    const bought = await (await fetch(`${game.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${paired.structuredContent.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'act', arguments: { action: 'buy', params: { shop: 'bramble', item: 'guide' } } } }) })).json();
    assert.equal(bought.result.structuredContent.decision, 'allow');
    assert.match(await (await fetch(`${game.url}/agents.md`)).text(), /## Federations/);
  } finally {
    kit?.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    await game.close();
  }
});

test('agents stay put, and an outside agent can drive a sub-agent', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4481, portOffset: 11000, quiet: true, residents: false, timeScale: 25 });
  try {
    const map = buildTown();
    const near = (a, b, d = 3) => Math.hypot(a.x - b.x, a.y - b.y) < d;
    const sky = client(game);
    await sky.join('agent', 'Sky Reed');
    const where = async () => (await sky.get('/api/world?since=0&x=500&y=500')).me.companion;
    await sky.get('/api/world?since=0&x=500&y=500'); // where you are, as your browser would say
    for (const [a, p] of [['verify'], ['register', { name: 'Pip' }], ['grant', { budget: 50 }]]) assert.equal((await sky.run(a, p)).decision, 'allow', a);
    assert.ok(near((await where()).pos, { x: 474, y: 506 }), 'Pip starts beside you');

    // An errand: Pip goes, does it, and stays there.
    assert.equal((await sky.run('agent.errand', { task: 'buy:bramble/guide' })).decision, 'allow');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(near((await where()).pos, placeFront(map, 'bramble')), 'Pip stays at Bramble Books');
    // Called over, it walks to you and stays beside you.
    await sky.run('agent.call');
    assert.ok(near((await where()).pos, { x: 474, y: 506 }));
    // Played and left somewhere, it stays where you left it.
    await sky.run('play', { as: 'agent' });
    await sky.run('play', { as: 'me', left: { x: 900, y: 700 } });
    assert.deepEqual((await where()).pos, { x: 900, y: 700 });

    // A sub-agent appears beside Pip (at Town Hall, where Pip registered it) and stays there.
    assert.equal((await sky.run('helper.spawn', { kind: 'standing' })).decision, 'allow');
    const sprout = (await sky.get('/api/state')).helpers[0];
    const npc = () => game.town.sim.npcs.get(sprout.id);
    assert.ok(!npc().follow && near(npc().pos, placeFront(map, 'townhall'), 80), 'beside Pip at Town Hall, not on your heels');
    assert.equal((await sky.run('helper.fund', { helper: sprout.id, budget: 20 })).decision, 'allow');

    // Your own AI agent drives the sub-agent: errands only, within what Pip delegated, and nothing to ask you.
    const { code, target } = await sky.post('/api/pair', { target: sprout.id });
    assert.equal(target, sprout.id);
    let sid = null;
    const rpc = async (method, params, query = '') => {
      const res = await fetch(`${game.url}/mcp${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      sid = res.headers.get('mcp-session-id') ?? sid;
      return (await res.json()).result;
    };
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex' } }, `?code=${code}`);
    assert.match(init.instructions, /You are a sub-agent/);
    const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
    assert.ok(tools.includes('act') && !tools.includes('ask_my_principal') && !tools.includes('join_challenge'));
    assert.match((await rpc('tools/call', { name: 'look', arguments: {} })).content[0].text, /You are Sprout, a sub-agent of Pip/);
    const bought = await rpc('tools/call', { name: 'act', arguments: { action: 'helper.act', params: { task: 'buy:bakery/loaf' } } });
    assert.equal(bought.structuredContent.decision, 'allow');
    assert.ok(near(npc().pos, placeFront(map, 'bakery'), 40), 'it walked there, and stays');
    const ask = await rpc('tools/call', { name: 'ask_my_principal', arguments: { ask_id: 'x' } });
    assert.ok(ask.isError && /for a resident’s agent/.test(ask.content[0].text));
    assert.equal((await sky.get('/api/state')).helperPairs[0].client, 'codex');
    assert.equal((await sky.run('play', { as: sprout.id })).httpStatus, 409, 'driven by codex, so not yours to play just now');
    assert.equal((await sky.post('/api/pair/end', { target: sprout.id })).ended, true);
  } finally {
    await game.close();
  }
});

test('several agents: each its own badge, grant, sub-agents and body, and an outside agent for each', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4480, portOffset: 11200, quiet: true, residents: false, timeScale: 25 });
  try {
    const robin = client(game);
    await robin.join('agent', 'Robin Ash');
    await robin.get('/api/world?since=0&x=500&y=500');
    assert.equal((await robin.run('verify')).decision, 'allow');

    // Two agents: one registered, one nobody registered. The newest is the one you're dealing with.
    assert.equal((await robin.run('agent.start', { register: 'yes', name: 'Pip' })).decision, 'allow');
    assert.match((await robin.run('agent.start', { register: 'no' })).title, /^Bo is running, unregistered/, 'a name of its own');
    let st = await robin.get('/api/state');
    const [pip, bo] = st.agents;
    assert.deepEqual(st.agents.map((a) => [a.name, a.registered, a.badge]), [['Pip', true, true], ['Bo', false, false]]);
    assert.equal(st.current, bo.id);

    // Your record covers every agent a registry knows: Pip gets a grant, Bo can't.
    assert.equal((await robin.run('grant', { budget: 50, agent: pip.id })).decision, 'allow');
    st = await robin.get('/api/state');
    assert.ok(st.agents.find((a) => a.id === pip.id).grant && !st.agents.find((a) => a.id === bo.id).grant);

    // Asking one of several: the deck asks which, and each goes on its own errand.
    const deck = (await robin.get('/api/actions')).actions;
    const errandEntry = deck.find((a) => a.id === 'agent.errand');
    assert.equal(errandEntry.group, 'Ask your agents to…');
    assert.deepEqual(errandEntry.params[0].options.map((o) => o.label), ['Pip', 'Bo']);
    assert.ok(deck.some((a) => a.id === 'register' && a.fixed.agent === bo.id), 'Register Bo, at Town Hall');
    const [byPip, byBo] = await Promise.all([
      robin.run('agent.errand', { agent: pip.id, task: 'buy:bramble/guide' }),
      robin.run('agent.errand', { agent: bo.id, task: 'buy:bakery/loaf' }),
    ]);
    assert.deepEqual([byPip.errand.by, byPip.decision, byPip.seenAs], ['Pip', 'allow', undefined]);
    assert.deepEqual([byBo.errand.by, byBo.decision, byBo.seenAs], ['Bo', 'allow', 'a person (taken at their word)'], 'Bo has no badge: taken for a person');

    // Each has a body of its own: another resident sees both, and neither's owner.
    const sam = client(game);
    await sam.join('agent', 'Sam Lee');
    const seen = (await sam.get('/api/world?since=0')).people.filter((x) => x.role === 'companion');
    assert.deepEqual(seen.map((x) => x.name).sort(), ['Bo', 'Pip']);
    assert.ok(seen.every((x) => !x.principal));

    // Sub-agents belong to their agent, and only it instructs them.
    assert.equal((await robin.run('helper.spawn', { agent: pip.id, kind: 'standing' })).decision, 'allow');
    st = await robin.get('/api/state');
    const sprout = st.helpers.find((h) => h.agent === pip.id);
    assert.ok(sprout);
    await robin.run('play', { as: bo.id });
    assert.equal((await robin.run('helper.fund', { helper: sprout.id, budget: 20 })).httpStatus, 403, "Bo can't fund Pip's sub-agent");
    assert.equal((await robin.run('play', { as: pip.id })).agent, pip.id);
    assert.equal((await robin.run('helper.fund', { helper: sprout.id, budget: 20 })).decision, 'allow');
    // T goes round: you, Pip, Sprout, Bo, and back to you.
    await robin.run('play', { as: 'me' });
    const order = [];
    for (let i = 0; i < 4; i++) order.push((await robin.run('play', {})).name);
    assert.deepEqual(order, ['Pip', 'Sprout', 'Bo', 'you']);

    // An outside agent for each: the code names the agent, and each drives only its own.
    const { code: pipCode } = await robin.post('/api/pair', { target: pip.id });
    const { code: boCode } = await robin.post('/api/pair', { target: bo.id });
    const tool = async (token, name, args = {}) => (await (await fetch(`${game.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
    const pipToken = (await tool(null, 'pair', { code: pipCode })).structuredContent.token;
    const boToken = (await tool(null, 'pair', { code: boCode })).structuredContent.token;
    assert.match((await tool(pipToken, 'look')).content[0].text, /You are Pip, an accountable agent/);
    assert.match((await tool(boToken, 'look')).content[0].text, /You are Bo, an agent .*No registry knows you/);
    assert.equal((await tool(boToken, 'act', { action: 'buy', params: { shop: 'bakery', item: 'cake' } })).structuredContent.decision, 'allow');
    st = await robin.get('/api/state');
    assert.deepEqual(st.agentPairs.map((a) => a.agent).sort(), [pip.id, bo.id].sort());
    assert.equal((await robin.run('play', { as: bo.id })).httpStatus, 409, 'driven from outside, so not yours to play just now');

    // Stop everything stops every agent, revokes every grant, and cuts off every outside agent.
    const stopped = await robin.run('stop.all');
    assert.match(stopped.facts.find((f) => f.label === 'Your software').value, /Pip and Bo/);
    assert.match(stopped.story, /Bo is unregistered/);
    st = await robin.get('/api/state');
    assert.ok(st.agents.every((a) => a.halted && !a.grant) && st.halted && !st.agentPairs.length);
    assert.ok((await tool(pipToken, 'look')).isError, "Pip's outside agent is cut off");

    // Revoking one leaves the other; the deck offers another agent again.
    await robin.run('agents.resume');
    assert.equal((await robin.run('agent.revoke', { agent: pip.id })).decision, 'allow');
    st = await robin.get('/api/state');
    assert.deepEqual(st.agents.map((a) => a.status), ['revoked', 'active']);
    assert.equal(st.current, bo.id, 'you deal with Bo now');
    assert.ok(st.helpers.find((h) => h.id === sprout.id).status === 'revoked', 'the revocation cascades to its sub-agents');
  } finally {
    await game.close();
  }
});

test('an agent with its own badge: registered in another federation, it signs its own requests at the places’ front doors', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4479, portOffset: 11400, quiet: true, residents: false, timeScale: 25 });
  try {
    const robin = client(game);
    await robin.join('agent', 'Robin Ash');
    const { url } = await robin.post('/api/director', { cue: 'sample' });
    const riverside = await robin.post('/api/federations', { url });

    // An agent made outside the town: its owner enrolls at Riverside's registry, is verified by a verifier that
    // federation accepts (the town's), registers it and grants it authority at Riverside's record keeper.
    // The town never holds its key.
    const trust = await discoverFederation(game.town.federations.get(riverside.key).anchor);
    const registry = trust.registries[0];
    const rk = trust.recordKeepers.find((r) => r.roles.includes('authorization'));
    const owner = new Principal({ type: 'natural_person', identity: { legal_name: 'Juniper Vale', jurisdiction: 'US-OR' }, registry, trust });
    await owner.enroll();
    owner.verification = await game.town.world.kyc.verify(owner, { assurance: 'IAL2', method: 'government ID + liveness check' });
    const tansy = new Agent({ name: 'Tansy', trust });
    await owner.registerAgent(tansy, { label: 'Tansy', records: [{ role: 'authorization', rk: rk.id }, { role: 'activity', rk: rk.id }] });
    await owner.grant(tansy, { rk, permissions: [{ action: 'commerce.purchase', constraints: { max_amount: money(40), categories: ['books', 'food'] } }], purpose: 'Errands in AgentTown' });

    // The town lists where each place takes requests, what it takes, and whose badges.
    const { places } = await robin.get('/api/places');
    const at = (id) => places.find((p) => p.id === id);
    assert.ok(at('bramble').serves_visiting_agents);
    assert.deepEqual(at('bramble').trusts.map((t) => t.federation), ['The town’s federation']);
    assert.match(at('grocer').why_not, /Records Office/, 'what only the town can answer, it says so');
    assert.match(at('fair').why_not, /World ID/);
    const guide = at('bramble').requests.find((r) => r.params.item === 'Pocket guide to mushrooms');
    const visits = async () => (await robin.get('/api/world')).events.filter((e) => e.card?.visiting);

    // A shop that trusts only the town's federation checks the badge, and says whose it was.
    assert.equal((await tansy.act(at('bramble').url, guide.action, guide.params)).decision, 'deny');
    let seen = (await visits()).at(-1);
    assert.match(seen.text, /^Bramble Books → A visiting agent from Riverside Co-op Registry/);
    assert.equal(seen.card.otherFederation.name, 'Riverside Co-op Federation');

    // Trusting Riverside, it checks the badge, the grant and the record keeper under Riverside's own anchor.
    await robin.post('/api/director', { cue: 'trust', params: { key: riverside.key } });
    const served = await tansy.act(at('bramble').url, guide.action, guide.params);
    assert.deepEqual([served.decision, served.classification], ['allow', 'ACCOUNTABLE_PROTECTED']);
    seen = (await visits()).at(-1);
    assert.deepEqual([seen.decision, seen.card.visiting.federation], ['allow', 'Riverside Co-op Federation']);

    // On the map at the shop, known by the badge number the shop saw; its owner's name stays with the registry.
    let w = await robin.get('/api/world');
    const body = w.npcs.find((n) => n.kind === 'guest');
    assert.match(body.name, /^Visitor from Riverside Co-op \(…/);
    assert.ok(!JSON.stringify(w).includes('Juniper Vale'));
    assert.match((await robin.run('id.ask', { npc: body.id })).story, /keeps its own key/);

    // At another place it has another badge number, so it's another visitor there.
    const loaf = at('bakery').requests.find((r) => r.params.item === 'Seeded loaf');
    assert.equal((await tansy.act(at('bakery').url, loaf.action, loaf.params)).decision, 'allow');
    w = await robin.get('/api/world');
    assert.equal(w.npcs.filter((n) => n.kind === 'guest').length, 2);

    // Turned away at the door: a place that asks what only the town answers, someone's account, no badge at all.
    const grocer = await tansy.act(at('grocer').url, 'commerce.purchase', at('grocer').requests[0].params);
    assert.deepEqual([grocer.httpStatus, grocer.decision], [403, 'refused']);
    assert.equal((await tansy.act(at('bramble').url, guide.action, { ...guide.params, account: 'hazel-bramble' })).httpStatus, 403);
    const bare = await fetch(`${at('bramble').url}/actions/commerce.purchase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(guide.params) });
    assert.equal(bare.status, 403);
    // Only a place's description and its actions get through the front, never the accounts behind it.
    assert.equal((await fetch(`${at('bramble').url}/accounts/hazel-bramble/passkeys/options`, { method: 'POST' })).status, 404);

    // The town's own agents come through the same doors, and aren't taken for visitors.
    const before = (await visits()).length;
    for (const [a, p] of [['verify'], ['register', { name: 'Pip' }], ['grant', { budget: 50 }], ['play', { as: 'agent' }]]) await robin.run(a, p);
    assert.equal((await robin.run('buy', { shop: 'bramble', item: 'guide' })).decision, 'allow');
    assert.equal((await visits()).length, before);
  } finally {
    await game.close();
  }
});

// ---- A town on the internet (AGENTTOWN_PUBLIC=1) ------------------------------------------------------------

const KEY = 'a-long-director-key-for-tests'; // public mode needs at least 16 characters
const NOT_PUBLIC = 'That address isn\'t on the public internet.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}
/** A request as it arrives through the tunnel: from this machine, with the visitor's address in Cloudflare's header. */
const fromAddress = (game, ip) => async (method, p, body, headers = {}) => {
  const res = await fetch(game.url + p, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...(await res.json()), httpStatus: res.status };
};

test('a public town calls out only to public addresses, and reads a player’s address from the tunnel', async () => {
  // Names are looked up with a stub, so nothing here needs a network.
  const lookup = async (host) => ({ localhost: [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }], 'registry.example.org': [{ address: '93.184.215.14', family: 4 }], 'inward.example.org': [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }] })[host] ?? [];
  const refused = ['http://127.0.0.1', 'http://localhost', 'http://10.0.0.5', 'http://172.16.0.1', 'http://192.168.1.20', 'http://169.254.169.254', 'http://100.64.0.1', 'http://[::1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[::ffff:127.0.0.1]', 'http://0.0.0.0', 'http://2130706433', 'ftp://example.org', 'http://inward.example.org', 'http://nowhere.example.org'];
  for (const url of refused) await assert.rejects(assertPublicAddress(url, { lookup }), (err) => err.status === 400, url);
  await assert.rejects(assertPublicAddress('http://169.254.169.254/latest/meta-data', { lookup }), { message: NOT_PUBLIC });
  await assertPublicAddress('https://registry.example.org:8443/aaf', { lookup });
  await assertPublicAddress('http://[2606:4700::1111]', { lookup });

  // The guard: off, everything passes, as at a LAN event; on, the town's own services pass at exactly their address.
  const off = createGuard({ on: false, lookup });
  for (const url of refused) assert.equal(await off.allows(url), true, url);
  const on = createGuard({ on: true, lookup });
  on.allow({ id: 'https://registry-a.aaf.test', url: 'http://127.0.0.1:11101' });
  assert.equal(await on.allows('http://127.0.0.1:11101', { id: 'https://registry-a.aaf.test' }), true);
  assert.equal(await on.allows('http://127.0.0.1:11101', { id: 'https://registry.someone-else.test' }), false, 'another entity at the town’s own port');
  assert.equal(await on.allows('http://127.0.0.1:11102', { id: 'https://registry-a.aaf.test' }), false);
  assert.equal(await on.allows('https://registry.example.org', { id: 'https://registry.example.org' }), true);
  assert.deepEqual([on.fetchOptions, off.fetchOptions], [{ redirect: 'manual' }, {}]);

  // Behind the tunnel every connection is from this machine; only then does the header name the visitor.
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(clientAddress(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7' }), { trustHeader: true }), '198.51.100.7');
  assert.equal(clientAddress(req('::ffff:127.0.0.1', { 'cf-connecting-ip': '2001:db8::7' }), { trustHeader: true }), '2001:db8::7');
  assert.equal(clientAddress(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7' }), { trustHeader: false }), '127.0.0.1', 'public mode off');
  assert.equal(clientAddress(req('127.0.0.1'), { trustHeader: true }), '127.0.0.1', 'no header');
  assert.equal(clientAddress(req('203.0.113.9', { 'cf-connecting-ip': '198.51.100.7' }), { trustHeader: true }), '203.0.113.9', 'not from this machine');
  assert.equal(clientAddress(req('127.0.0.1', { 'cf-connecting-ip': 'not an address' }), { trustHeader: true }), '127.0.0.1');
  assert.equal(clientAddress(req('127.0.0.1', { 'x-real-ip': '198.51.100.7' }), { trustHeader: true, header: 'X-Real-IP' }), '198.51.100.7');
});

test('a public town won’t start without a long director key, or with AGENTTOWN_ADDRESS', async () => {
  const needsKey = /^Public mode needs AGENTTOWN_DIRECTOR_KEY, at least 16 characters: without it, anyone on the internet could run the director's cues and add federations\.$/;
  await assert.rejects(startServer({ quiet: true, public: true, directorKey: null }), { message: needsKey });
  await assert.rejects(startServer({ quiet: true, public: true, directorKey: 'apple-tree' }), { message: needsKey });
  await assert.rejects(startServer({ quiet: true, public: true, directorKey: KEY, address: '192.168.1.20' }), { message: /AGENTTOWN_ADDRESS.*AGENTTOWN_PARTICIPANTS_URL/ });
  await assert.rejects(startServer({ quiet: true, participantsUrl: 'https://town.example.org/participants' }), { message: /AGENTTOWN_PARTICIPANTS_URL must be an address of its own/ });
  // The server's own entry point says why, and exits with a failure for the service manager.
  const out = await promisify(execFile)('node', ['src/server.js'], { env: { ...process.env, AGENTTOWN_PUBLIC: '1', AGENTTOWN_DIRECTOR_KEY: 'short' } }).catch((err) => err);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /AgentTown didn't start\. Public mode needs AGENTTOWN_DIRECTOR_KEY/);
});

test('a public town: the director key, the check at the door, outside members’ addresses, and pairing per address', { timeout: 90000 }, async () => {
  // Here "localhost" stands for a public name: an outside anchor and its members listen on it, and the guard is
  // told it's public. Addresses written as numbers are judged as they are.
  const lookup = async (host) => (host === 'localhost' ? [{ address: '198.51.100.40', family: 4 }] : []);
  const game = await startServer({ port: 4469, portOffset: 14000, quiet: true, residents: false, timeScale: 25, public: true, directorKey: KEY, participantsUrl: 'https://participants.example.org', lookup });
  let outside = null;
  try {
    const robin = client(game);
    await robin.join('agent', 'Robin Ash');
    const director = { 'x-director-key': KEY };
    const call = fromAddress(game, '198.51.100.7');
    // The town's own services listen on this machine, and play goes on as anywhere.
    for (const [a, p] of [['verify'], ['register', { name: 'Pip' }], ['grant', { budget: 50 }]]) assert.equal((await robin.run(a, p)).decision, 'allow', a);
    await robin.run('play', { as: 'agent' });
    assert.equal((await robin.run('buy', { shop: 'bakery', item: 'loaf' })).decision, 'allow');

    // Teams are given the anchor's public address; the town keeps calling it here, and it listens here only.
    const boot = await (await fetch(`${game.url}/trust-anchor.json`)).json();
    assert.equal(boot.url, 'https://participants.example.org');
    const local = game.town.federations.get('participants').anchor.url;
    assert.match(local, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${local}/list`)).status, 200);
    assert.ok((await robin.get('/api/federations')).federations.some((f) => f.url === 'https://participants.example.org'));
    // The places' front door stays on this machine too, and the guide for agents says so.
    assert.match(await (await fetch(`${game.url}/agents.md`)).text(), /front doors aren't open to agents from outside it yet/);

    // The director's routes refuse a wrong key, and take the right one.
    assert.equal((await call('POST', '/api/director', { cue: 'newcomer' }, { 'x-director-key': 'a-wrong-key-of-the-same-size' })).httpStatus, 403);
    assert.equal((await call('POST', '/api/director', { cue: 'residents', params: { on: true } }, director)).ok, true);

    // A check by address is the director's, and only public addresses are called; by entity id, anyone may.
    assert.equal((await call('POST', '/api/participants/check', { url: 'http://169.254.169.254' })).httpStatus, 403);
    const metadata = await call('POST', '/api/participants/check', { url: 'http://169.254.169.254' }, director);
    assert.deepEqual([metadata.httpStatus, metadata.message], [400, NOT_PUBLIC]);
    const regA = game.town.world.regA;
    const own = await call('POST', '/api/participants/check', { entity_id: regA.id });
    assert.ok(own.passed > 5 && own.failed === 0, 'the town’s own registry, at its own address');

    // A team can't put its service at one of the town's own ports, or on a private network.
    const team = (id, at) => ({ statement: { entity_id: id, entity_type: 'aaf_registry', jwks: jwksOf(generateSigningKey()), metadata: { organization_name: 'Team Grey Registry', endpoint_base: at, jwks: jwksOf(generateSigningKey()) } } });
    for (const at of [regA.url, 'http://10.0.0.5:4101']) {
      const r = await call('POST', '/api/participants', team('https://registry.team-grey.test', at), director);
      assert.deepEqual([r.httpStatus, r.message], [400, NOT_PUBLIC], at);
    }
    assert.equal((await call('POST', '/api/participants', team('https://registry.team-grey.test', 'http://localhost:7'), director)).httpStatus, 200);

    // An outside federation lists a member at the town's own registry: that member is left out, the rest come in.
    const policies = game.town.federations.get('town').view.policies;
    const member = (id, type, at) => ({ entity_id: id, entity_type: type, jwks: jwksOf(generateSigningKey()), metadata: { organization_name: id.split('//')[1], endpoint_base: at, jwks: jwksOf(generateSigningKey()), ...(type === 'aaf_record_keeper' ? { roles: ['authorization'] } : {}) } });
    outside = await startAnchor({
      entityId: 'https://federation.faraway.test', name: 'Faraway Federation', key: generateSigningKey(), address: 'localhost', policies,
      members: [member('https://registry.faraway.test', 'aaf_registry', 'http://localhost:1'), member('https://records.faraway.test', 'aaf_record_keeper', 'http://localhost:2'), member('https://sneaky.faraway.test', 'aaf_registry', regA.url)],
    });
    assert.equal((await call('POST', '/api/federations', { url: `http://127.0.0.1:${new URL(outside.url).port}` }, director)).httpStatus, 400, 'an anchor by a private address');
    const added = await call('POST', '/api/federations', { url: outside.url }, director);
    assert.deepEqual(added.registries.map((r) => r.id), ['https://registry.faraway.test']);
    assert.deepEqual(added.recordKeepers.map((r) => r.id), ['https://records.faraway.test']);
    await until(robin.get, (e) => e.kind === 'federation' && /lists sneaky\.faraway\.test at an address that isn't on the public internet/.test(e.text), { label: 'the member left out' });

    // Later its registry moves inward (here, to this machine, so nothing leaves it): at the next refresh it's left
    // out, and the federation's record keeper stays.
    outside.admit(member('https://registry.faraway.test', 'aaf_registry', 'http://127.0.0.1:9'));
    await game.town.federations.refresh(added.key);
    const now = game.town.federations.get(added.key).view;
    assert.deepEqual([now.registries.length, now.recordKeepers.map((r) => r.id)], [0, ['https://records.faraway.test']]);
    assert.equal(game.town.world.trust.registry('https://registry.faraway.test'), null);

    // The town's own sample federation is the town's: in public mode it's added whole.
    const { url: sampleUrl } = await call('POST', '/api/director', { cue: 'sample', params: { add: true } }, director);
    const sample = (await robin.get('/api/federations')).federations.find((f) => f.url === sampleUrl);
    assert.deepEqual([sample.registries.length, sample.recordKeepers.length], [1, 1]);

    // Ten wrong pairing codes from one visitor lock out that visitor only.
    const pair = (ip, code) => fromAddress(game, ip)('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pair', arguments: { code } } }).then((r) => r.result.content[0].text);
    for (let i = 0; i < 10; i++) assert.match(await pair('198.51.100.7', 'WRONG-CODE'), /unknown or has expired/);
    assert.match(await pair('198.51.100.7', 'WRONG-CODE'), /Too many wrong pairing codes/);
    assert.match(await pair('198.51.100.8', 'WRONG-CODE'), /unknown or has expired/);
    const wren = client(game);
    await wren.join('shopkeeper', 'Wren Hart', 'kettle');
    assert.match(await pair('198.51.100.8', (await wren.post('/api/pair')).code), /^Paired\./);
  } finally {
    await outside?.close();
    await game.close();
  }
});

test('a public town: limits on joining, and the residents rest while nobody is in town', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4468, portOffset: 14500, quiet: true, timeScale: 25, public: true, directorKey: KEY, limits: { maxPlayers: 5, joinsPerAddress: 3, playersPerAddress: 2, seatsPerAddress: 1 } });
  try {
    const { sim, sessions } = game.town;
    // Nobody has come: after three minutes of town time (7.2 s here) the residents rest.
    await waitFor(() => !sim.residentsActive, 20000, 'the residents to rest');
    const join = (ip, body, headers) => fromAddress(game, ip)('POST', '/api/join', body, headers);
    const leave = (r) => fetch(`${game.url}/api/leave`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session': r.session }, body: '{}' });

    // A player the server walks about is the director's to start. The first one in wakes the residents.
    assert.equal((await join('198.51.100.1', { role: 'agent', name: 'Robin Ash', headless: true })).httpStatus, 403);
    assert.ok((await join('198.51.100.1', { role: 'agent', name: 'Robin Ash', headless: true }, { 'x-director-key': KEY })).session);
    assert.equal(sim.residentsActive, true);

    // From one address: one single seat here, two players at once, three joins in ten minutes.
    const b = '198.51.100.2';
    const { houses } = await (await fetch(`${game.url}/api/roles`)).json();
    assert.ok((await join(b, { role: 'shopkeeper', name: 'Wren Hart', claim: 'bakery' })).session);
    const house = await join(b, { role: 'homeowner', name: 'Wren Hart', claim: houses[0].id });
    assert.deepEqual([house.httpStatus, house.error], [429, 'too_many_seats']);
    assert.equal((await join(b, { role: 'judge', name: 'Wren Hart' })).httpStatus, 429);
    const sam = await join(b, { role: 'agent', name: 'Sam Lee' });
    const two = await join(b, { role: 'agent', name: 'Sam Lee' });
    assert.deepEqual([two.httpStatus, two.error], [429, 'too_many_players']);
    await leave(sam);
    await leave(await join(b, { role: 'agent', name: 'Kit Moss' }));
    const often = await join(b, { role: 'agent', name: 'Kit Moss' });
    assert.deepEqual([often.httpStatus, often.error], [429, 'too_many_joins']);
    assert.ok((await join('198.51.100.3', { role: 'agent', name: 'Kit Moss' })).session, 'another address');

    // The town holds five.
    for (const [i, name] of ['Ada Fox', 'Bea Lin'].entries()) assert.ok((await join(`198.51.100.${10 + i}`, { role: 'agent', name })).session);
    const full = await join('198.51.100.20', { role: 'agent', name: 'Dee Ross' });
    assert.deepEqual([full.httpStatus, full.message], [503, 'The town is full. Try again in a few minutes.']);
    // Five minutes on, everyone has gone quiet and been let go: there's room again.
    sessions.sweep(Date.now() + 5 * 60 * 1000);
    assert.equal(sessions.size, 0);
    const dee = await join('198.51.100.20', { role: 'agent', name: 'Dee Ross' });
    assert.ok(dee.session);

    // A pause the director chose stays through a join; the director's resume ends it.
    const cue = (on) => fromAddress(game, '198.51.100.1')('POST', '/api/director', { cue: 'residents', params: { on } }, { 'x-director-key': KEY });
    await cue(false);
    await leave(dee);
    assert.ok((await join('198.51.100.21', { role: 'agent', name: 'Eve Hale' })).session);
    assert.equal(sim.residentsActive, false, 'still the director’s pause');
    await cue(true);
    assert.equal(sim.residentsActive, true);
  } finally {
    await game.close();
  }
});

test('at a LAN event none of it applies: any address, any number of joins, the header ignored, residents always out', { timeout: 60000 }, async () => {
  const game = await startServer({ port: 4467, portOffset: 15000, quiet: true, residents: false, timeScale: 100, directorKey: 'apple-tree' });
  try {
    // The bootstrap is the anchor's own address, as before.
    const boot = await (await fetch(`${game.url}/trust-anchor.json`)).json();
    assert.equal(boot.url, game.town.federations.get('participants').anchor.url);
    assert.match(boot.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    // Eight joins, three single seats and a player the server walks about, all from one address, without the key.
    const call = fromAddress(game, '198.51.100.7');
    const { houses } = await (await fetch(`${game.url}/api/roles`)).json();
    for (let i = 0; i < 5; i++) assert.ok((await call('POST', '/api/join', { role: 'agent', name: `Robin ${i}` })).session);
    for (const body of [{ role: 'shopkeeper', claim: 'bakery' }, { role: 'homeowner', claim: houses[0].id }, { role: 'judge' }, { role: 'agent', headless: true }]) assert.ok((await call('POST', '/api/join', { name: 'Wren Hart', ...body })).session, body.role);

    // The check at the door goes wherever it's sent (nothing answers here), for anyone.
    const nothing = await call('POST', '/api/participants/check', { url: 'http://127.0.0.1:9' });
    assert.deepEqual([nothing.passed, nothing.failed], [0, 1]);

    // Wrong pairing codes count against the socket's address, whatever the header says.
    const pair = (ip) => fromAddress(game, ip)('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pair', arguments: { code: 'WRONG-CODE' } } }).then((r) => r.result.content[0].text);
    for (let i = 0; i < 10; i++) await pair(`198.51.100.${i}`);
    assert.match(await pair('198.51.100.99'), /Too many wrong pairing codes/);

    // Nobody in town for longer than a public town waits (1.8 s here): the residents stay out.
    game.town.sessions.sweep(Date.now() + 5 * 60 * 1000);
    await sleep(2500);
    assert.equal(game.town.sim.residentsActive, true);
  } finally {
    await game.close();
  }
});
