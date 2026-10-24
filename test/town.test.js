// A full day in AgentTown through the game's API, with a software
// authenticator that sends exactly what a browser sends from the game's origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoftwareAuthenticator } from 'aaf-reference/src/lib/webauthn.js';
import { startServer } from '../src/server.js';

test('a day in AgentTown', { timeout: 60000 }, async () => {
  const game = await startServer({ port: 4499, portOffset: 7500, quiet: true });
  const call = async (method, p, body) => {
    const res = await fetch(game.url + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  const post = (p, body = {}) => call('POST', p, body);
  const you = new SoftwareAuthenticator();
  const approve = async (rid) => {
    const o = await post(`/api/approvals/${rid}/options`);
    return post(`/api/approvals/${rid}/approve`, { credential: you.get(o.publicKey, game.origin) });
  };
  try {
    assert.match(await (await fetch(game.url + '/')).text(), /AgentTown/);

    // Before anything: an unregistered agent is turned away.
    const early = await post('/api/buy', { shop: 'bramble', item: 'guide' });
    assert.equal(early.decision, 'deny');
    assert.equal(early.classification, 'UNLABELED');

    // Town Hall, then the Records Office.
    assert.equal((await post('/api/enroll', { name: 'Robin Ash' })).assurance, 'IAL2');
    assert.ok((await post('/api/agent', { name: 'Pip' })).registration_id);
    const noGrant = await post('/api/buy', { shop: 'bramble', item: 'guide' });
    assert.equal(noGrant.decision, 'deny', 'registered but no authority yet');
    assert.equal((await post('/api/grant', { budget: 50 })).budget, 50);

    // Shopping: within the grant, over it, outside its categories, and without the badge.
    const guide = await post('/api/buy', { shop: 'bramble', item: 'guide' });
    assert.equal(guide.decision, 'allow');
    assert.equal(guide.classification, 'ACCOUNTABLE_PROTECTED');
    assert.ok(guide.receipt.verified);
    assert.equal((await post('/api/buy', { shop: 'bramble', item: 'encyclopedia' })).decision, 'deny');
    assert.equal((await post('/api/buy', { shop: 'kettle', item: 'seeds' })).decision, 'deny');
    const kettle = await post('/api/buy', { shop: 'kettle', item: 'kettle' });
    assert.equal(kettle.decision, 'allow');
    assert.notEqual(kettle.ppid, guide.ppid, 'a different name at each shop');
    await post('/api/badge', { on: false });
    assert.equal((await post('/api/buy', { shop: 'kettle', item: 'lantern' })).classification, 'UNLABELED');
    await post('/api/badge', { on: true });

    // A helper: over-delegation is refused, a smaller budget works, and the lineage stops at one level.
    assert.ok((await post('/api/helper', { name: 'Sprout' })).ok);
    const tooMuch = await post('/api/helper/fund', { budget: 100 });
    assert.equal(tooMuch.ok, false);
    assert.equal(tooMuch.code, 'exceeds_parent_authority');
    assert.ok((await post('/api/helper/fund', { budget: 20 })).ok);
    const errand = await post('/api/buy', { shop: 'bramble', item: 'guide', by: 'helper' });
    assert.equal(errand.decision, 'allow');
    assert.equal(errand.chain_length, 2);
    assert.equal((await post('/api/buy', { shop: 'bramble', item: 'atlas', by: 'helper' })).decision, 'deny');
    assert.equal((await post('/api/helper/hire')).code, 'lineage_depth_exceeded');

    // Home: a passkey on the door, the agent let in, step-up for throwing things out.
    const opts = await post('/api/passkey/options');
    assert.ok((await post('/api/passkey', { credential: you.create(opts.publicKey, game.origin) })).credential_id);
    const knock = await post('/api/door', { account: 'you' });
    assert.equal(knock.decision, 'step_up');
    assert.equal(knock.approval_request.purpose, 'delegate-agent');
    assert.equal((await approve(knock.approval_request.request_id)).status, 'approved');
    const inside = await post('/api/door', { account: 'you' });
    assert.equal(inside.decision, 'allow');
    assert.ok(inside.result.items.includes("Grandma's teapot"));
    const toss = await post('/api/discard', { item: 'Box of old letters' });
    assert.equal(toss.decision, 'step_up');
    await approve(toss.approval_request.request_id);
    assert.equal((await post('/api/discard', { item: 'Box of old letters', approvalRef: toss.approval_request.request_id })).decision, 'allow');
    assert.notEqual((await post('/api/discard', { item: "Grandma's teapot", approvalRef: toss.approval_request.request_id })).decision, 'allow', 'an approval is good for one exact act');

    // In person, with no badge: the key alone is refused; a passkey approval of this entry works.
    await post('/api/badge', { on: false });
    assert.equal((await post('/api/door', { account: 'you', useKey: true })).decision, 'deny');
    const inPerson = await post('/api/knock');
    await approve(inPerson.request_id);
    const entered = await post('/api/enter', { requestId: inPerson.request_id });
    assert.equal(entered.decision, 'allow');
    assert.equal(entered.classification, 'HUMAN_APPROVED');
    await post('/api/badge', { on: true });

    // Maple's: knocking asks Maple (who declines); her lost key gets your principal a notice.
    const maple = await post('/api/door', { account: 'maple' });
    assert.equal(maple.declined_by, 'Maple');
    await post('/api/key');
    const misuse = await post('/api/door', { account: 'maple', useKey: true });
    assert.equal(misuse.decision, 'deny');
    const state = await call('GET', '/api/state');
    assert.equal(state.phone.incidents.length, 1, 'your phone hears about what your agent did');

    // Night: nobody gets in, and the visitors' principal is notified without you learning who it is.
    const night = await post('/api/night');
    assert.equal(night.got_in, 0);
    assert.equal(night.incidents_relayed, 3);
    const court = await post('/api/court');
    assert.equal(court.principal.name, 'Nightjar Labs Inc.');
    assert.equal(court.related_at_hearth, 3);

    // Revocation cascades to the helper; the agent is refused afterwards.
    const revoked = await post('/api/revoke');
    assert.equal(revoked.cascades_to, 1);
    assert.notEqual((await post('/api/buy', { shop: 'bramble', item: 'guide' })).decision, 'allow');
    assert.notEqual((await post('/api/buy', { shop: 'kettle', item: 'kettle', by: 'helper' })).decision, 'allow');
  } finally {
    await game.close();
  }
});
