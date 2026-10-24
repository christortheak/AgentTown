// AgentTown's side of the game: one in-process federation from aaf-reference,
// the player as principal, the player's agent, and the places in town, each a
// real relying party with its own policy. Every game action is a real
// presentation to a real service, so what the player sees is that service's
// actual decision and the evidence it kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFederationInProcess } from 'aaf-reference/src/lib/federation.js';
import { createWorld, money } from 'aaf-reference/src/sim/world.js';
import { whatWasLearned } from 'aaf-reference/src/sim/privacy.js';
import { describePermission, toRar } from 'aaf-reference/src/lib/scope.js';
import { digestOf } from 'aaf-reference/src/lib/crypto.js';
import { HEADERS } from 'aaf-reference/src/lib/protocol.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';

export const BUDGETS = [25, 50, 100];
const CATEGORIES = ['books', 'home'];
const HELPER_LIFETIME_SECONDS = 240;

export const SHOPS = {
  bramble: {
    id: 'bramblebooks.agenttown.test', name: 'Bramble Books', category: 'books',
    items: [
      { id: 'guide', name: 'Pocket guide to mushrooms', price: 12 },
      { id: 'atlas', name: 'Atlas of old maps', price: 34 },
      { id: 'encyclopedia', name: 'Illuminated encyclopedia, 12 volumes', price: 180 },
    ],
  },
  kettle: {
    id: 'copperkettle.agenttown.test', name: 'Copper Kettle Goods', category: 'home',
    items: [
      { id: 'kettle', name: 'Copper kettle', price: 28 },
      { id: 'lantern', name: 'Brass lantern', price: 45 },
      { id: 'seeds', name: 'Moonflower seeds', price: 6, category: 'garden' },
      { id: 'clock', name: 'Grandfather clock', price: 260 },
    ],
  },
};

const HOME_CONTENTS = {
  you: ['Your journal', 'Box of old letters', "Grandma's teapot", 'Jar of buttons'],
  maple: ['Prize-winning carrot seeds', "Maple's diary"],
};

const attempt = (p) => p.catch((err) => ({ decision: 'refused', classification: null, reasons: [err.message], code: err.code ?? null }));

export async function createTown({ origin, portOffset = 7000, quiet = true }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttown-'));
  const federation = await startFederationInProcess({ dataDir, portOffset, quiet });
  const world = createWorld({ trust: federation.trustList, keysDir: federation.paths.keysDir });
  const { regA, ledgerline } = world;

  // The shops: a sale needs an accountable agent whose authority covers it.
  const shops = {};
  for (const [key, shop] of Object.entries(SHOPS)) {
    shops[key] = await world.relyingParty({
      id: shop.id, name: shop.name,
      rules: { 'commerce.purchase': [{ label: 'a sale', require: { accountability: 'established', authorization: true } }] },
      handlers: { 'commerce.purchase': async (p) => ({ receipt: `${key.slice(0, 2).toUpperCase()}-${Math.floor(Math.random() * 1e5)}`, item: p.item }) },
    });
  }

  // Homes: accounts at one housing service, with passkeys (aaf-reference §10.5).
  // A key (bearer token) alone opens nothing: people need their passkey, and
  // agents need the owner's passkey approval of that particular agent.
  let homes;
  const accountOf = (rp, p) => p.account ?? rp.accounts.byToken(p.account_token)?.id;
  const hearth = await world.relyingParty({
    id: 'hearth.agenttown.test', name: 'Hearth & Key (homes)',
    accounts: { rpId: new URL(origin).hostname, origin },
    rules: {
      'home.enter': [{ label: 'a home: its owner, or an agent the owner let in', require: { accountability: 'agent_or_human', account: 'owner' } }],
      'home.discard': [{ label: "throwing things out: the owner's passkey every time", require: { accountability: 'established', authorization: true, account: 'owner', humanApproval: true } }],
    },
    handlers: {
      'home.enter': async (p, v, rp) => ({ items: [...homes[accountOf(rp, p)]] }),
      'home.discard': async (p, v, rp) => {
        const account = accountOf(rp, p);
        homes[account] = homes[account].filter((i) => i !== p.item);
        return { discarded: p.item, items: [...homes[account]] };
      },
    },
    onAccountMisuse: async ({ rp, verification, account }) => {
      const owner = rp.accounts.get(account)?.owner ?? account;
      await rp.fileIncident({ ppid: verification.ppid, registry: verification.registry, summary: `An agent tried the key to ${owner}'s home without the owner's authorization` });
    },
  });

  // The night visitors: accountable agents of a verified lab, holding a copy of your house key.
  const nightjar = await world.verifiedPrincipal({
    type: 'legal_person', identity: { legal_name: 'Nightjar Labs Inc.', jurisdiction: 'US-DE', registration_number: 'DE-5521907' }, assurance: 'high', method: 'KYB: registry extract',
  });
  const burglars = [];
  for (let i = 1; i <= 3; i++) {
    const a = world.agent(`eval-runner-${i}`);
    await nightjar.registerAgent(a, { label: `eval-runner-${i}`, records: world.records() });
    await nightjar.grant(a, { rk: ledgerline, permissions: [{ action: 'benchmark.run' }] });
    burglars.push(a);
  }

  let s;
  const reset = () => {
    hearth.accounts.create('you', 'You');
    hearth.accounts.create('maple', 'Maple');
    homes = structuredClone(HOME_CONTENTS);
    s = {
      principal: null, agent: null, revoked: false, grant: null, helper: null, badge: false,
      keys: { you: hearth.accounts.issueToken('you'), maple: hearth.accounts.issueToken('maple') },
      foundKey: false, inventory: [], known: {}, receipts: [], nightPpids: [], visited: new Set(), events: new Set(),
    };
  };
  reset();

  const needPrincipal = () => {
    if (!s.principal) throw new HttpError(409, 'not_verified', 'Get verified at Town Hall first.');
  };
  const needAgent = () => {
    needPrincipal();
    if (!s.agent) throw new HttpError(409, 'no_agent', 'Register your agent at Town Hall first.');
  };
  const needHelper = () => {
    needAgent();
    if (!s.helper || s.helper.expiresAt <= Date.now()) throw new HttpError(409, 'no_helper', 'You have no helper right now. Hire one at Town Hall.');
  };
  const wearingBadge = () => Boolean(s.agent && s.badge);
  const placeName = (id) => [hearth, ...Object.values(shops)].find((p) => p.id === id)?.name.replace(/ \(.*\)$/, '') ?? id;

  /** What a place decided, what it checked and learned, and the receipt for its activity-log entry. */
  function record(place, action, actor, r) {
    const ev = r.txn ? place.evidence.find((e) => e.txn === r.txn) : null;
    const receipt = ev?.activity_receipt ?? null;
    const card = {
      place: place.name, action, actor,
      decision: r.decision, classification: r.classification ?? null, reasons: r.reasons ?? [],
      approval_request: r.approval_request ?? null, result: r.result ?? null,
      checks: ev?.checks ?? [], learned: ev ? whatWasLearned(ev) : [], ppid: ev?.ppid ?? null, chain_length: ev?.chain_length ?? null,
      receipt: receipt ? { log: receipt.log_id, index: receipt.index, verified: world.verifyReceipt(receipt).ok } : null,
    };
    if (card.receipt) s.receipts.push({ place: place.name, action, decision: card.decision, ...card.receipt });
    if (ev?.ppid && actor === s.agent?.name) s.known[place.id] = { place: place.name, ppid: ev.ppid };
    return card;
  }

  /** The player's agent (with or without its badge) or its helper asks a place to do something. */
  async function visit(place, action, params, { by = 'agent', headers } = {}) {
    if (by === 'helper') {
      const r = await attempt(s.helper.agent.act(place.url, action, params, headers ? { headers } : {}));
      return record(place, action, s.helper.name, r);
    }
    if (wearingBadge()) {
      const r = await attempt(s.agent.act(place.url, action, params, headers ? { headers } : {}));
      return record(place, action, s.agent.name, r);
    }
    const r = await world.rawRequest(place.url, action, params, headers);
    return record(place, action, s.agent ? `${s.agent.name} (no badge)` : 'your agent (unregistered)', r);
  }

  const town = {
    world, hearth, shops, origin,

    reset() {
      reset();
      return { ok: true };
    },

    /** Everything the HUD shows. */
    async state() {
      const notifications = s.principal ? (await s.principal.notifications()).filter((n) => n.kind === 'incident') : [];
      const hasPasskey = (hearth.accounts.get('you')?.passkeys.size ?? 0) > 0;
      const ppidAtHome = s.agent?.contexts.get(hearth.id)?.ppid;
      const helperAlive = s.helper && s.helper.expiresAt > Date.now();
      return {
        principal: s.principal ? { name: s.principal.name, assurance: 'IAL2', verifier: world.kyc.id, registry: regA.name } : null,
        agent: s.agent ? { name: s.agent.name, registration: s.agent.registrationId, status: s.revoked ? 'revoked' : 'active' } : null,
        badge: wearingBadge(),
        grant: s.grant,
        helper: s.helper ? { name: s.helper.name, expires_at: s.helper.expiresAt, budget: s.helper.budget, status: s.revoked ? 'revoked' : helperAlive ? 'active' : 'expired' } : null,
        home: { passkey: hasPasskey, agent_let_in: Boolean(ppidAtHome && hearth.accounts.delegationFor('you', ppidAtHome, 'home.enter')) },
        found_key: s.foundKey,
        inventory: s.inventory,
        known: Object.values(s.known),
        receipts: s.receipts.length,
        events: [...s.events],
        phone: {
          incidents: notifications.map((n) => ({ id: n.incident_id, agent: n.agent_label, reporter: placeName(n.reporter), summary: n.summary, at: n.at })),
          approvals: hearth.accounts.pendingFor('you').map(({ id, purpose, details }) => ({ request_id: id, purpose, details })),
        },
        budgets: BUDGETS,
        shops: SHOPS,
      };
    },

    // ---- Town Hall (Registry A) --------------------------------------------

    async enroll({ name }) {
      if (s.principal) throw new HttpError(409, 'already_verified', 'You are already verified.');
      const legalName = String(name ?? '').trim().slice(0, 40) || 'A Resident';
      s.principal = await world.verifiedPrincipal({
        type: 'natural_person', identity: { legal_name: legalName, jurisdiction: 'US-NY' }, assurance: 'IAL2', method: 'government ID + liveness check',
      });
      hearth.accounts.get('you').owner = legalName;
      return { principal_id: s.principal.id, assurance: 'IAL2', verifier: world.kyc.id, registry: regA.name };
    },

    async registerAgent({ name }) {
      needPrincipal();
      if (s.agent && !s.revoked) throw new HttpError(409, 'already_registered', 'Your agent is already registered.');
      const agentName = String(name ?? '').trim().slice(0, 16) || 'Pip';
      const agent = world.agent(agentName);
      const res = await s.principal.registerAgent(agent, { label: agentName, records: world.records(), lineage: { max_depth: 1 } });
      Object.assign(s, { agent, revoked: false, grant: null, helper: null, badge: true, known: {} });
      return { registration_id: res.registration_id, issuance_ms: res.issuance_ms };
    },

    setBadge({ on }) {
      needAgent();
      s.badge = Boolean(on);
      return { badge: s.badge };
    },

    async revoke() {
      needAgent();
      if (s.revoked) throw new HttpError(409, 'already_revoked', 'That agent is already revoked.');
      const res = await s.principal.revokeAgent(s.agent, 'compromised');
      s.revoked = true;
      return { status: res.status, cascades_to: res.cascades_to };
    },

    async hireHelper({ name }) {
      needAgent();
      if (s.helper && s.helper.expiresAt > Date.now() && !s.revoked) throw new HttpError(409, 'has_helper', 'You already have a helper.');
      const helperName = String(name ?? '').trim().slice(0, 16) || 'Sprout';
      const helper = world.agent(helperName);
      const res = await attempt(s.agent.registerSubagent(helper, { label: helperName, records: world.records(), expiresIn: HELPER_LIFETIME_SECONDS }));
      if (res.decision === 'refused') return { ok: false, reasons: res.reasons, code: res.code };
      s.helper = { agent: helper, name: helperName, expiresAt: Date.now() + HELPER_LIFETIME_SECONDS * 1000, budget: null };
      return { ok: true, registration_id: res.registration_id, expires_at: s.helper.expiresAt };
    },

    async helperHiresHelper() {
      needHelper();
      const res = await attempt(s.helper.agent.registerSubagent(world.agent('Tiny'), { label: 'Tiny', records: world.records() }));
      return res.decision === 'refused' ? { ok: false, reasons: res.reasons, code: res.code } : { ok: true };
    },

    /** Petition the court to unmask whoever stands behind last night's visitors. */
    async courtOrder() {
      needPrincipal();
      const ppid = s.nightPpids[0];
      if (!ppid) throw new HttpError(409, 'no_case', 'There is nothing to take to court yet.');
      const order = world.court.order({
        caseId: `${s.principal.name} v. Does 1–3`, ppids: [ppid], relyingParty: hearth.id,
        requester: `${s.principal.name} (homeowner)`, scope: ['root_principal_identity', 'chain', 'related_ppids'],
      });
      const res = await world.court.resolve(regA, { order, ppid });
      const sth = await world.registrySth(regA);
      s.events.add('court');
      const root = res.result.root_principal;
      return {
        court: world.court.name, registry: regA.name,
        principal: { name: root.identity.legal_name, type: root.type, jurisdiction: root.identity.jurisdiction, registration_number: root.identity.registration_number },
        agents: res.result.chain.map((c) => ({ label: c.label, status: c.status })),
        related_at_hearth: res.result.related_ppids.length,
        transparency_log_size: sth.tree_size,
      };
    },

    // ---- Records Office (Ledgerline: authority; Tessera: activity) ---------

    async grant({ budget }) {
      needAgent();
      if (s.revoked) throw new HttpError(409, 'revoked', 'That agent is revoked. Register a new one at Town Hall.');
      if (s.grant) throw new HttpError(409, 'already_granted', 'Your agent already has a grant.');
      const b = BUDGETS.includes(Number(budget)) ? Number(budget) : 50;
      const permissions = [{ action: 'commerce.purchase', constraints: { max_amount: money(b), categories: CATEGORIES } }, { action: 'home.*' }];
      const res = await s.principal.grant(s.agent, { rk: ledgerline, permissions, delegation: { allowed: true, max_depth: 1 }, purpose: 'Errands around AgentTown', validForDays: 30 });
      s.grant = { budget: b, id: res.grant_id, permissions: permissions.map(toRar).map(describePermission) };
      return s.grant;
    },

    async fundHelper({ budget }) {
      needHelper();
      if (!s.grant) return { ok: false, reasons: [`${s.agent.name} has no authority of its own yet, so it has none to pass on. Sign a grant first.`] };
      const b = Number(budget) || 10;
      const res = await attempt(s.agent.delegate(s.helper.agent, {
        permissions: [{ action: 'commerce.purchase', constraints: { max_amount: money(b), categories: CATEGORIES } }], validForDays: 1, purpose: 'One errand',
      }));
      if (res.decision === 'refused') return { ok: false, reasons: res.reasons, code: res.code };
      s.helper.budget = b;
      return { ok: true, grant_id: res.grant_id, budget: b };
    },

    receipts: () => ({ receipts: s.receipts.slice(-12).reverse(), total: s.receipts.length }),

    // ---- Shops ---------------------------------------------------------------

    async buy({ shop, item, by = 'agent' }) {
      const def = SHOPS[shop]?.items.find((i) => i.id === item);
      if (!def) throw new HttpError(404, 'unknown_item', 'No such item.');
      if (by === 'helper') needHelper();
      const card = await visit(shops[shop], 'commerce.purchase', { item: def.name, amount: money(def.price), category: def.category ?? SHOPS[shop].category }, { by });
      if (card.decision === 'allow') {
        s.inventory.push({ name: def.name, from: SHOPS[shop].name, by: card.actor });
        s.visited.add(shop);
        if (s.visited.size === Object.keys(SHOPS).length) s.events.add('both-shops');
      }
      return card;
    },

    // ---- Homes ---------------------------------------------------------------

    pickUpKey() {
      s.foundKey = true;
      return { key: `${s.keys.maple.slice(0, 12)}…` };
    },

    /** Walk up to a door: knock, or try a key (a bearer token). Maple is out, so she declines on her phone. */
    async door({ account, useKey = false }) {
      if (!['you', 'maple'].includes(account)) throw new HttpError(404, 'unknown_home', 'No such home.');
      if (useKey && account === 'maple' && !s.foundKey) throw new HttpError(409, 'no_key', "You don't have Maple's key.");
      const card = await visit(hearth, 'home.enter', useKey ? { account_token: s.keys[account] } : { account });
      if (account === 'maple' && card.decision === 'step_up' && card.approval_request) {
        hearth.accounts.decline(card.approval_request.request_id);
        card.declined_by = 'Maple';
      }
      if (account === 'you' && card.decision === 'allow') s.events.add('home');
      if (account === 'maple' && useKey) s.events.add('tried-key');
      return card;
    },

    async discard({ item, approvalRef }) {
      return visit(hearth, 'home.discard', { account: 'you', item }, approvalRef ? { headers: { [HEADERS.approvalRef]: approvalRef } } : {});
    },

    /** The human path: no badge, so the owner approves this exact entry with a passkey. */
    knockInPerson() {
      const params = { account: 'you' };
      return hearth.accounts.openRequest('you', 'approve-action', { actor: 'human', action: 'home.enter', params_digest: digestOf(params), summary: 'Open your front door (you, in person)' });
    },

    async enterInPerson({ requestId }) {
      const r = await world.rawRequest(hearth.url, 'home.enter', { account: 'you' }, requestId ? { [HEADERS.humanApproval]: requestId } : {});
      return record(hearth, 'home.enter', 'you, in person', r);
    },

    /** Night falls: three accountable agents and one anonymous client try a copy of your key. */
    async night() {
      const before = (await nightjar.notifications()).length;
      const params = { account_token: s.keys.you };
      const results = [];
      for (const a of burglars) {
        const r = await attempt(a.act(hearth.url, 'home.enter', params));
        const card = record(hearth, 'home.enter', a.name, r);
        if (card.ppid) s.nightPpids.push(card.ppid);
        results.push({ ...card, presented: 'a badge and a copy of your house key' });
      }
      const anon = await world.rawRequest(hearth.url, 'home.enter', params);
      results.push({ ...record(hearth, 'home.enter', 'someone with no badge', anon), presented: 'a copy of your house key, nothing else' });
      const relayed = (await nightjar.notifications()).slice(before).filter((n) => n.kind === 'incident');
      s.events.add('night');
      return { results, got_in: results.filter((r) => r.decision === 'allow').length, incidents_relayed: relayed.length };
    },

    async close() {
      await world.close();
      await federation.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return town;
}
