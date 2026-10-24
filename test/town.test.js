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

const client = (game) => {
  const call = async (method, p, body) => (await fetch(game.url + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  const post = (p, body = {}) => call('POST', p, body);
  const run = (action, params = {}) => post('/api/do', { action, params });
  const get = (p) => call('GET', p);
  return { call, post, run, get };
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
  const { post, run, get } = client(game);
  const you = new SoftwareAuthenticator();
  const approve = async (rid) => {
    const o = await post(`/api/approvals/${rid}/options`);
    return post(`/api/approvals/${rid}/approve`, { credential: you.get(o.publicKey, game.origin) });
  };
  try {
    assert.match(await (await fetch(game.url + '/')).text(), /AgentTown/);
    const actions = (await get('/api/actions')).actions;
    assert.ok(actions.length > 30, 'the deck lists every action');

    // An unregistered agent is unlabeled; registering before verification is refused by the registry itself.
    assert.equal((await run('buy', { shop: 'bramble', item: 'guide' })).classification, 'UNLABELED');
    await post('/api/enroll', { name: 'Robin Ash' });
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
    const opts = await post('/api/passkey/options');
    assert.ok((await post('/api/passkey', { credential: you.create(opts.publicKey, game.origin) })).credential_id);
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

    // The rogue swarm: depth refused, incidents relayed, revocation cascades.
    await post('/api/director', { cue: 'swarm' });
    await until(get, (e) => /lineage depth budget/.test(e.text ?? ''), { label: 'depth refusals' });
    const cascade = await until(get, (e) => /revoked gloam-root/.test(e.text ?? ''), { timeout: 60000, label: 'the cascade' });
    assert.match(cascade.text, /cascaded to 8 sub-agents/);

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
  const { post, run, get } = client(game);
  try {
    const info = await get('/api/info');
    assert.equal(info.federation, 'external');
    assert.equal(info.trust_anchor, fed.trustAnchor.url);
    assert.ok(info.registries.length >= 2);
    await post('/api/enroll', { name: 'Robin Ash' });
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
