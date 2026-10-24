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
import { startServer } from '../src/server.js';

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
  const passkey = async () => {
    const o = await post('/api/passkey/options');
    return post('/api/passkey', { credential: authenticator.create(o.publicKey, game.origin) });
  };
  return { call, post, run, get, join, approve, passkey, authenticator };
};

/** Wait until the town ledger has an event matching `test`. */
async function until(get, testFn, { timeout = 20000, label = 'event' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const w = await get('/api/world?since=0');
    const hit = w.events.find(testFn);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('a day in AgentTown', { timeout: 120000 }, async () => {
  const game = await startServer({ port: 4499, portOffset: 7500, quiet: true, timeScale: 25 });
  const { post, run, get, join, approve, passkey } = client(game);
  try {
    assert.match(await (await fetch(game.url + '/')).text(), /AgentTown/);
    assert.equal((await get('/api/state')).httpStatus, 401, 'join first');
    await join('agent', 'Robin Ash');
    const actions = (await get('/api/actions')).actions;
    assert.ok(actions.length > 30, 'the deck lists every action');

    // An unregistered agent is unlabeled; registering before verification is refused by the registry itself.
    assert.equal((await run('buy', { shop: 'bramble', item: 'guide' })).classification, 'UNLABELED');
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
    assert.equal((await run('buy', { shop: 'bramble', item: 'encyclopedia' })).decision, 'deny');
    const cafe = await run('buy', { shop: 'cafe', item: 'creme' });
    assert.notEqual(cafe.decision, 'allow', 'Café Lumière only accepts Harbor Registry badges');
    assert.match(cafe.policy, /Harbor Registry|Registry B/);

    // Disclosure: the forge's large jobs need a disclosed principal (and provenance), small ones don't.
    assert.equal((await run('compute', { job: 'small' })).decision, 'allow');
    assert.equal((await run('compute', { job: 'large' })).decision, 'step_up');
    await run('disclose', { on: true });
    assert.equal((await run('buy', { shop: 'kettle', item: 'kettle' })).classification, 'ACCOUNTABLE_DISCLOSED');
    await run('disclose', { on: false });

    // World ID (simulated): one pie per person, not per agent.
    const noWorldId = await run('fair.claim');
    assert.equal(noWorldId.decision, 'deny');
    assert.match(noWorldId.reasons[0], /World ID/);
    await run('worldid.enroll');
    assert.equal((await run('fair.claim')).decision, 'allow');
    assert.equal((await run('fair.claim')).decision, 'deny', 'same person, same nullifier');

    // x402 (simulated): the toll takes payment from anyone; with the framework on, it also checks authority.
    const toll = await run('toll.pay');
    assert.equal(toll.decision, 'allow');
    assert.ok(toll.steps.some((s) => /settled/.test(s.text)));
    assert.equal((await get('/api/state')).wallet.balance, 19.5);
    await run('badge', { on: false });
    assert.equal((await run('toll.pay')).decision, 'allow', 'x402 alone: no badge needed');
    await post('/api/director', { cue: 'policy', params: { place: 'toll', patch: { aaf: 'required' } } });
    assert.equal((await run('toll.pay')).classification, 'UNLABELED');
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
    const cascade = await until(get, (e) => /revoked gloam-root/.test(e.text ?? ''), { timeout: 60000, label: 'the cascade' });
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
    assert.notEqual((await run('buy', { shop: 'bramble', item: 'guide' })).decision, 'allow');
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
