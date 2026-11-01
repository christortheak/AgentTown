// A town left running keeps its memory flat: each place keeps its latest
// decisions, the court its latest cases, and the Records Office and the x402
// facilitator forget what they no longer need, without letting anything be
// used twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { DECISIONS_KEPT } from '../src/world.js';
import { PLACE_DEFS } from '../src/places.js';
import { createJustice, CASES_KEPT } from '../src/justice.js';
import { createKeeper, signRecord, allowanceRequest, agentThumbprint, normalizeRecord, CATEGORIES, TYP } from '../src/proposed/keeper.js';
import { createX402 } from '../src/x402.js';
import { generateSigningKey, digestOf } from 'aaf-reference/src/lib/crypto.js';

/** One browser tab: it joins the town and sends its session with every call. (As in town.test.js.) */
const client = (game) => {
  let session = null;
  const call = async (method, p, body) => {
    const headers = { 'content-type': 'application/json', ...(session ? { 'x-session': session } : {}) };
    const res = await fetch(game.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ...(await res.json()), httpStatus: res.status };
  };
  const post = (p, body = {}) => call('POST', p, body);
  const run = (action, params = {}) => post('/api/do', { action, params });
  const join = async (role, name, claim) => {
    const r = await post('/api/join', { role, name, claim });
    session = r.session;
    return r;
  };
  return { run, join };
};

test('a place keeps its latest decisions, and still says what it learned', { timeout: 90000 }, async () => {
  const game = await startServer({ port: 4475, portOffset: 12000, quiet: true, residents: false, timeScale: 25 });
  const { run, join } = client(game);
  const { world, places } = game.town;
  const bramble = places.places.bramble;
  try {
    await join('agent', 'Robin Ash');
    assert.equal((await run('verify')).decision, 'allow');
    assert.equal((await run('agent.start', { register: 'yes', name: 'Pip' })).decision, 'allow');
    assert.equal((await run('play', { as: 'agent' })).playing, 'agent');
    assert.equal((await run('grant', { budget: 50 })).decision, 'allow');
    assert.equal((await run('buy', { shop: 'bramble', item: 'guide' })).decision, 'allow');

    // 300 more decisions at the same place: requests with no badge, which it refuses.
    const params = places.purchase('bramble', PLACE_DEFS.bramble.items[0]);
    for (let i = 0; i < 300; i++) await world.rawRequest(bramble.rp.url, 'commerce.purchase', params);
    assert.equal(bramble.rp.evidence.length, DECISIONS_KEPT, 'the place keeps its latest decisions, no more');
    assert.equal(bramble.rp.received.length, DECISIONS_KEPT, 'and the requests that came with them');

    // The next request's card still finds its own decision: what the place learned, the X-ray, the receipt.
    const guide = await run('buy', { shop: 'bramble', item: 'guide' });
    assert.equal(guide.decision, 'allow');
    assert.ok(guide.plain.some((x) => x.kind === 'ppid'), 'in plain words: a badge number that only works here');
    assert.ok(guide.plain.some((x) => x.kind === 'protected'), 'in plain words: not who they are');
    assert.ok(guide.trace.some((h) => h.from === 'bramble' && h.to === 'townhall'), 'the X-ray shows the status check');
    assert.ok(guide.receipt?.verified, 'the activity-log receipt is there, and verifies');
    assert.equal(bramble.rp.evidence.length, DECISIONS_KEPT);
    assert.equal(bramble.rp.evidence.at(-1).decision, 'allow', 'the newest decision is the one just made');
  } finally {
    await game.close();
  }
});

test('the court keeps its latest cases, and every petition left has its case', async () => {
  // Someone plays the police and the judge, so nothing is simulated and nothing waits on a timer.
  const justice = createJustice({ world: {}, emit: () => {}, people: () => ({ police: 1, judge: 1 }) });
  const evidence = (i) => [{ ppid: `ppid-${i}`, registry: 'https://registry-a.test', rp: 'bramble.agenttown.test', place: 'Bramble Books' }];
  const filed = [];
  for (let i = 0; i < CASES_KEPT + 200; i++) filed.push(justice.fileCase({ kind: 'complaint', placeId: 'bramble', title: `Complaint ${i}`, evidence: evidence(i) }));
  // An old case with a petition still before the court, and one refiled and denied again and again.
  const waiting = filed[CASES_KEPT + 10];
  const before = justice.petition(waiting.id, 'identify');
  const refiled = filed.at(-1);
  for (let i = 0; i < CASES_KEPT * 4; i++) await justice.rule(justice.petition(refiled.id, 'identify').id, { grant: false });
  assert.ok(justice.petitions(Infinity).length <= CASES_KEPT * 3, 'petitions refiled again and again in one case are capped too');
  assert.ok(justice.caseById(refiled.id));
  // Newer cases push the old ones out; some of them have petitions, ruled on.
  for (let i = 0; i < 300; i++) {
    const c = justice.fileCase({ kind: 'complaint', placeId: 'kettle', title: `Later ${i}`, evidence: evidence(10000 + i) });
    if (i % 3 === 0) await justice.rule(justice.petition(c.id, 'identify').id, { grant: false });
  }

  const cases = justice.cases(Infinity);
  const petitions = justice.petitions(Infinity);
  assert.ok(cases.length <= CASES_KEPT, `${cases.length} cases kept`);
  assert.ok(petitions.length <= CASES_KEPT * 3, `${petitions.length} petitions kept`);
  assert.ok(petitions.length > 50, `${petitions.length} petitions left to check`);
  for (const p of petitions) assert.ok(justice.caseById(p.case), `petition ${p.id} still has its case`);
  assert.equal(justice.caseById(filed[0].id), null, 'the oldest case went first');
  assert.ok(justice.caseById(waiting.id), 'a case whose petition is before the court stays');
  assert.ok(petitions.includes(before), 'and so does the petition');
  assert.equal(justice.cases().length, 40, 'the police station shows the latest 40, as before');
});

test('the Records Office forgets what no longer counts, and nothing is used twice', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const keeper = createKeeper({ rpId: 'localhost', origin: 'http://localhost:4475' });
  const principal = { id: 'principal-test', key: generateSigningKey() };
  const agent = { longTermKey: generateSigningKey() };
  for (let v = 0; v < 50; v++) {
    const r = keeper.setRecord(principal.id, signRecord(principal, normalizeRecord({ spending: { per_purchase: 20, per_day: null, purchases_per_day: null, categories: CATEGORIES }, agents: [agentThumbprint(agent)] })));
    assert.equal(r.version, v + 1, 'each version is numbered');
  }
  const ask = (amount) => keeper.allowance(allowanceRequest(agent, { principal: principal.id, aud: 'bramble.agenttown.test', place: 'Bramble Books', action: 'commerce.purchase', amount, category: 'books', params_digest: digestOf({ amount }) }));

  // 120 covered and 300 refused: the register shows the latest 40, and today's totals count every covered one.
  for (let i = 0; i < 120; i++) assert.equal(ask(5).covered, true);
  for (let i = 0; i < 300; i++) assert.equal(ask(50).covered, false);
  const reg = keeper.register(principal.id);
  assert.equal(reg.version, 50);
  assert.equal(reg.attempts.length, 40);
  assert.deepEqual(reg.today, { spent: 600, purchases: 120 });

  // An allowance is good once; after it expires it's refused as expired.
  const { allowance } = ask(5);
  const check = () => keeper.check(allowance, { typ: TYP.allowance, aud: 'bramble.agenttown.test', params_digest: digestOf({ amount: 5 }) });
  assert.equal(check().ok, true);
  assert.equal(check().reason, 'already used');
  t.mock.timers.tick(125000);
  assert.equal(check().reason, 'expired');
  // A day later the old covered requests no longer count, and the register still shows the latest 40.
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(ask(5).covered, true);
  assert.deepEqual(keeper.register(principal.id).today, { spent: 5, purchases: 1 });
  assert.equal(keeper.register(principal.id).attempts.length, 40);
});

test('the x402 facilitator forgets spent payments once they expire, and a payment is still good once', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const x402 = createX402();
  x402.wallet('robin', 100);
  const required = x402.requirements({ resource: 'toll.agenttown.test/payments.authorize', amount: 0.5, payTo: 'toll.agenttown.test', description: 'Bridge Toll' });
  const payment = x402.pay('robin', required);
  assert.equal(x402.facilitator.verify(payment, required).isValid, true);
  assert.equal(x402.facilitator.settle(payment, required).success, true);
  assert.equal(x402.facilitator.settle(payment, required).errorReason, 'payment already used');
  const forged = { ...payment, payload: { ...payment.payload, validBefore: payment.payload.validBefore + 3600 } };
  assert.equal(x402.facilitator.verify(forged, required).invalidReason, 'invalid signature', 'its expiry is signed');
  t.mock.timers.tick(61000);
  assert.equal(x402.facilitator.settle(payment, required).errorReason, 'payment expired');
  for (let i = 0; i < 50; i++) assert.equal(x402.facilitator.settle(x402.pay('robin', required), required).success, true);
  assert.equal(x402.facilitator.settle(payment, required).errorReason, 'payment expired', 'still refused, though forgotten');
  assert.equal(x402.balance('robin'), 74.5);
});
