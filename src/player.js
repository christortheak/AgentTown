// The player: a principal (the person at the keyboard), their agent, its
// sub-agents, and every action the player can take. Every action is always
// listed; whether it works is up to the services. A refusal shown in the game
// is the refusal a registry, record keeper or place actually returned.
import { money } from 'aaf-reference/src/sim/world.js';
import { describePermission, toRar } from 'aaf-reference/src/lib/scope.js';
import { digestOf, generateSigningKey, nowSeconds, publicOf } from 'aaf-reference/src/lib/crypto.js';
import { issueSdJwt } from 'aaf-reference/src/lib/sd-jwt.js';
import { HEADERS } from 'aaf-reference/src/lib/protocol.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';
import { PLACE_DEFS, SHOPS, ATTRIBUTES, plainPermission } from './places.js';
import { explain, eventFromCard } from './explain.js';
import { ASSET } from './x402.js';

export const BUDGETS = [25, 50, 100];
const CATEGORIES = ['books', 'home', 'food', 'health'];
const HELPER_NAMES = ['Sprout', 'Pebble', 'Clover', 'Wick', 'Bramble', 'Fig', 'Tansy', 'Moth'];
const HELPER_LIFETIME_SECONDS = 240;
const OPENING_BALANCE = 400;
const TARGETS = ['bramble', 'kettle', 'bakery', 'apothecary', 'grocer', 'cafe', 'bank', 'exchange', 'forge', 'fair', 'toll'];
export const SHOP_ICONS = { bramble: '📚', kettle: '🫖', bakery: '🥐', apothecary: '🌿', cafe: '☕', pawn: '🕰️', tavern: '🍺', grocer: '🧺' };

const JUNIPER = { face: '🦉', who: 'Registrar Juniper' };
const MOSS = { face: '🦔', who: 'Archivist Moss' };
const ORB = { face: '🔮', who: 'The Orb (simulated World ID)' };
const COURT = { face: '⚖️', who: 'The Courthouse' };
const DOOR = { face: '🏡', who: 'Your front door' };
const PHONE = { face: '📱', who: 'Your phone' };

const attempt = (p) => p.then((value) => ({ ok: true, value }), (err) => ({ ok: false, reasons: [err.message], code: err.code ?? null }));
const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const service = ({ place, keeper, title, ok = true, reasons = [], story, facts = [], stamp }) => ({
  type: 'service', place, keeper, title, headline: title, decision: ok === null ? 'info' : ok ? 'allow' : 'refused', reasons, story, facts, stamp,
});

/**
 * One player with an agent.
 *   pid       the player's id (events they cause carry it as `owner`)
 *   account   their home's account at Hearth & Key
 *   justice   police and courts; neighbors() lists other homes to knock at
 */
export function createPlayer({ id: pid, account, world, places: P, sim, worldid, x402, emit, keys, justice, neighbors = () => [], lookup = (id) => (sim.npcs.get(id) ? sim.byFor(sim.npcs.get(id)) : null) }) {
  let p;
  let nightjar = null;
  const reset = () => {
    if (p?.helpers) for (const hid of p.helpers) sim.npcs.delete(hid);
    p = {
      principal: null, verified: false, agent: null, revoked: false, grant: null, badge: false, incognito: false, disclose: false,
      worldIdentity: null, helpers: [], helperCount: 0, foundKey: false, inventory: [], known: {}, receipts: 0, cases: [], events: new Set(),
      pos: { x: 0, y: 0 }, wallet: `${pid}-${Date.now()}`, knocks: [], consent: {}, once: null, asks: [], askCount: 0, spent: 0,
    };
    x402.wallet(p.wallet, OPENING_BALANCE);
    P.resetHomes(keys, [account], 'A resident');
  };
  reset();

  const town = world.regA?.name ?? 'the registry';
  const helpers = () => p.helpers.map((id) => sim.npcs.get(id)).filter(Boolean);
  const helper = (hid) => {
    const h = sim.npcs.get(hid);
    if (!h || h.owner !== pid) throw new HttpError(404, 'no_helper', 'You have no sub-agent by that name.');
    return h;
  };

  // ---- Disclosure: what the principal lets places see ----------------------------------
  // Standing consent per place ("always here"), one-time consent for a single
  // retry, and the old switch that shares the name everywhere. The registry
  // puts only what the principal allows into a badge; the agent then shows only
  // what the place's tier needs.
  const allowedFor = (placeId) => {
    const always = p.consent[placeId] ?? {};
    const once = p.once?.placeId === placeId ? p.once : {};
    return {
      identity: Boolean(p.disclose || always.identity || once.identity),
      attributes: [...new Set([...(always.attributes ?? []), ...(once.attributes ?? [])])],
      provenance: Boolean(always.provenance || once.provenance),
    };
  };
  async function syncPolicy() {
    const ids = Object.keys(P.places);
    const audiences = ids.filter((id) => allowedFor(id).identity).map((id) => P.places[id].rp.id);
    const attributes = [...new Set(ids.flatMap((id) => allowedFor(id).attributes))];
    await p.principal.setDisclosurePolicy({ identity: { audiences, claims: audiences.length ? ['legal_name'] : [] }, attributes });
    // Badges already issued follow the old policy: fetch fresh ones (same badge numbers) next time.
    for (const ctx of p.agent?.contexts.values() ?? []) ctx.attestation = null;
  }

  const by = () => ({
    name: p.agent ? (p.badge ? p.agent.name : `${p.agent.name} (no badge)`) : 'your agent (unregistered)',
    agent: p.agent, badge: p.badge, mode: p.incognito ? 'ephemeral' : 'pairwise', disclose: (place) => allowedFor(place.id),
    worldIdentity: p.worldIdentity, wallet: p.wallet,
  });

  /** The one thing that would most likely turn a refusal into a yes. */
  function fixFor(card) {
    if (card.decision === 'allow' || card.type !== 'check') return null;
    if (card.ask) return { client: 'consent', label: 'Decide on your phone' };
    const r = card.reasons?.[0] ?? '';
    if (card.legacy) return null;
    if (card.classification === 'UNLABELED') {
      if (p.agent && !p.revoked && !p.badge) return { action: 'badge', params: { on: true }, label: 'Put your badge on' };
      if (!p.agent || p.revoked) return p.verified ? { action: 'register', label: 'Register your agent at Town Hall', place: 'townhall' } : { action: 'verify', label: 'Get verified at Town Hall', place: 'townhall' };
    }
    if (card.classification === 'REVOKED') return { action: 'register', label: 'Register a new agent', place: 'townhall' };
    if (/no authorization presented/.test(r) && !p.grant) return { action: 'grant', params: { budget: 50 }, label: 'Sign a grant at the Records Office', place: 'records' };
    if (/no World ID proof/.test(r) && !p.worldIdentity) return { action: 'worldid.enroll', label: 'Get a World ID at the Orb', place: 'orb' };
    return null;
  }

  const track = (card) => {
    if (card.receipt) p.receipts++;
    if (card.ppid && p.agent && card.actor === p.agent.name && !p.incognito) p.known[card.placeId] = { place: card.place, ppid: card.ppid };
    const plain = explain(card);
    if (plain) Object.assign(card, { headline: plain.headline, why: plain.why, tone: plain.tone, fix: fixFor(card) });
    emit(eventFromCard(card, { id: pid, owner: pid }));
    return card;
  };
  const visit = async (placeId, action, params, extra) => track(await P.visit(placeId, action, params, by(), extra));
  const spend = (card, amount) => {
    if (card.decision === 'allow' && amount) {
      card.wallet = x402.adjust(p.wallet, -amount);
      p.spent = Math.round((p.spent + amount) * 100) / 100;
    }
    return card;
  };
  const broke = (place, amount) => (x402.balance(p.wallet) < amount
    ? service({ place, keeper: PHONE, title: 'Not enough money', ok: false, reasons: [`Your wallet has $${x402.balance(p.wallet)}; this costs $${amount}.`] })
    : null);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const ACTIONS = {
    // ---- You, the principal -------------------------------------------------
    async verify() {
      if (!p.principal) throw new HttpError(409, 'not_enrolled', 'Tell Town Hall your name first.');
      if (p.verified) return service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Already verified', ok: null, story: `You're already verified, ${p.principal.name}. That's the slow step, and it only happens once.` });
      const barred = justice?.isBanned(p.principal.identity);
      if (barred) {
        return service({
          place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Verification refused', ok: false, reasons: [`VerityCheck: this identity is barred by court order (case ${barred})`],
          story: "A court banned this identity, so VerityCheck won't verify it again. You could come back under another name; in this town that works, but real identity checks, with documents and a liveness check, are built to catch it.",
        });
      }
      const r = await attempt(world.verify(p.principal, {
        assurance: 'IAL2', method: 'government ID + liveness check',
        attributes: [{ name: 'age_over_18', value: true, source: 'VerityCheck (date of birth on the ID, not shared)' }],
      }));
      if (!r.ok) return service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Verification', ok: false, reasons: r.reasons });
      p.verified = true;
      emit({ kind: 'registry', actor: p.principal.name, place: town, placeId: 'townhall', tone: 'ok', owner: pid, private: true, text: `${town} verified ${p.principal.name} at IAL2 (the slow step, once)` });
      return service({
        place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Verified',
        story: `All done, ${p.principal.name}. VerityCheck verified you at **IAL2**, and noted one fact a place might ask about: you're **over 18**.\n\nThat was the slow step, and you only do it once. Places won't learn your name, or that fact, unless they ask and you say yes on your phone. Only this registry can say who you are without your say-so, and only to a court.`,
        facts: [{ label: 'Verified by', value: world.kyc?.id ?? '—' }, { label: 'Assurance', value: 'IAL2' }, { label: 'Facts on file', value: 'over 18 (no birth date)' }, { label: 'Who knows your name', value: town }],
      });
    },

    async 'worldid.enroll'() {
      if (p.worldIdentity) return service({ place: 'Orb Kiosk', keeper: ORB, title: 'Already verified', ok: null, story: 'Your World App already holds a World ID.' });
      p.worldIdentity = worldid.enroll('orb');
      return service({
        place: 'Orb Kiosk', keeper: ORB, title: 'World ID issued (simulated)',
        story: "The Orb checked that you're a unique human and your World App now holds a secret. It proves **a verified human** to a place without your name. Each place and action sees a different nullifier, so places can't link you, but the same place sees the same one twice.\n\nIt says nothing about who answers for an agent, or what the agent may do.",
        facts: [{ label: 'Level', value: 'orb' }, { label: 'Name shared', value: 'none' }, { label: 'Simulated', value: 'a MAC stands in for the zero-knowledge proof' }],
      });
    },

    async disclose({ on }) {
      if (!p.principal) throw new HttpError(409, 'not_enrolled', 'Enroll at Town Hall first.');
      const was = p.disclose;
      p.disclose = on === undefined ? !p.disclose : Boolean(on);
      const r = await attempt(syncPolicy());
      if (!r.ok) {
        p.disclose = was;
        return service({ place: town, keeper: JUNIPER, title: 'Disclosure', ok: false, reasons: r.reasons });
      }
      return service({
        place: `Town Hall · ${town}`, keeper: JUNIPER, title: p.disclose ? 'Any place that asks may see your name' : 'Your name is private again',
        story: p.disclose
          ? `You've consented once for the whole town: when a place asks for your name, ${p.agent?.name ?? 'your agent'} shows **${p.principal.name}** without asking you first. Places that don't ask still see only the badge.`
          : 'Places will see that a verified person stands behind your agent, but not who. When one asks for your name, your phone will ask you.',
      });
    },

    /** Answer a disclosure request on your phone: share once, always with this place, or decline. */
    async consent({ ask: askId, choice = 'once' }) {
      const a = p.asks.find((x) => x.id === askId) ?? (askId ? null : p.asks.at(-1));
      if (!a) return service({ place: 'Your phone', keeper: PHONE, title: 'Nothing to answer', ok: null, story: 'There is no request waiting.' });
      p.asks = p.asks.filter((x) => x !== a);
      const labels = a.what.map((w) => w.label);
      if (choice === 'decline') {
        p.events.add('consent');
        emit({ kind: 'consent', place: a.place, placeId: a.placeId, tone: 'info', owner: pid, private: true, text: `You declined to share ${listOf(labels)} with ${a.place}` });
        return service({ place: a.place, keeper: PHONE, title: 'Declined', ok: null, story: `You said no. ${a.place} gets nothing beyond the badge it already saw, and ${p.agent?.name ?? 'your agent'} doesn't go ahead. That's the point: the place asks, and you decide.` });
      }
      const grant = {
        identity: a.what.some((w) => w.kind === 'identity'),
        attributes: a.what.filter((w) => w.kind === 'attribute').map((w) => w.name),
        provenance: a.what.some((w) => w.kind === 'provenance'),
      };
      if (choice === 'always') {
        const had = p.consent[a.placeId] ?? {};
        p.consent[a.placeId] = { identity: had.identity || grant.identity, attributes: [...new Set([...(had.attributes ?? []), ...grant.attributes])], provenance: had.provenance || grant.provenance };
      } else {
        p.once = { placeId: a.placeId, ...grant };
      }
      p.events.add('consent');
      emit({ kind: 'consent', place: a.place, placeId: a.placeId, tone: 'ok', owner: pid, private: true, text: `You agreed to share ${listOf(labels)} with ${a.place}${choice === 'always' ? ' whenever it asks' : ', this once'}` });
      let card;
      try {
        await syncPolicy();
        card = await run(a.retry.action, a.retry.params);
      } finally {
        if (p.once) {
          p.once = null;
          await syncPolicy().catch(() => {});
        }
      }
      return { ...card, note: choice === 'always' ? `You agreed to share ${listOf(labels)} with ${a.place} whenever it asks. You can take that back on your phone.` : `You shared ${listOf(labels)} with ${a.place}, this once. Next time it will ask again.` };
    },

    /** Take back standing consent for one place. */
    async 'consent.revoke'({ place: placeId }) {
      if (!p.consent[placeId]) return service({ place: 'Your phone', keeper: PHONE, title: 'Nothing to take back', ok: null, story: 'You have no standing consent with that place.' });
      delete p.consent[placeId];
      await syncPolicy();
      const name = P.places[placeId]?.name ?? placeId;
      return service({ place: 'Your phone', keeper: PHONE, title: `${name} will have to ask again`, story: `Done. Badges issued from now on carry nothing extra for ${name}; if it asks, your phone will ask you.` });
    },

    async court({ case: caseId }) {
      if (!world.court) return service({ place: 'Courthouse', keeper: COURT, title: 'No court', ok: false, reasons: ['this town operates no court (no resolution authority keys)'] });
      const c = p.cases.find((x) => x.id === caseId) ?? p.cases[0];
      if (!c) return service({ place: 'Courthouse', keeper: COURT, title: 'No case', ok: false, reasons: ['There is no case to bring yet. Check a stranger\'s badge first, or wait for trouble at your door.'] });
      const order = world.court.order({ caseId: `${p.principal?.name ?? 'Resident'} v. Doe`, ppids: [c.ppid], relyingParty: c.rp, requester: p.principal?.name ?? 'a resident', scope: ['root_principal_identity', 'chain', 'related_ppids'] });
      const registry = world.trust.registry(c.registry) ?? world.regA;
      const r = await attempt(world.court.resolve(registry, { order, ppid: c.ppid }));
      if (!r.ok) return service({ place: 'Courthouse', keeper: COURT, title: 'Resolution refused', ok: false, reasons: r.reasons });
      const res = r.value.result;
      const sth = await world.registrySth(registry).catch(() => null);
      p.events.add('court');
      emit({ kind: 'registry', actor: 'Courthouse', place: registry.name, placeId: 'court', tone: 'info', owner: pid, private: true, text: `A court order made ${registry.name} resolve one PPID (${c.about}); the lookup itself was logged` });
      return service({
        place: 'Courthouse', keeper: COURT, title: 'Court order: resolved', stamp: { label: 'Resolved', tone: 'info' },
        story: `The court ordered **${registry.name}** to say who stands behind ${c.about}. Nobody else learned this name until a court asked.`,
        facts: [
          { label: 'Principal', value: `${res.root_principal.identity.legal_name} (${res.root_principal.type.replace('_', ' ')}, ${res.root_principal.identity.jurisdiction})` },
          { label: 'Agents in the chain', value: res.chain.map((x) => `${x.label} (${x.status})`).join(', ') },
          { label: 'Badges seen at the same place', value: String(res.related_ppids?.length ?? 1) },
          { label: 'Transparency log', value: sth ? `the lookup is recorded; the log now has ${sth.tree_size} entries` : 'recorded' },
        ],
      });
    },

    // ---- Your agent -----------------------------------------------------------
    async register({ name }) {
      if (!p.principal) throw new HttpError(409, 'not_enrolled', 'Enroll at Town Hall first.');
      if (p.agent && !p.revoked) return service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Already registered', ok: null, story: `${p.agent.name} is already registered. You steer one agent; spawn sub-agents for errands.` });
      const agentName = String(name ?? '').trim().slice(0, 16) || 'Pip';
      const agent = world.agent(agentName);
      // Its maker publishes a bill of materials; places that need it can ask to see it.
      const bom = world.provRk ? await attempt(world.provider('Pocket Agents Co.', 'safety@pocket-agents.test').publishProvenance(world.provRk, {
        build: 'Pocket Agent 2.3', components: [{ type: 'model', name: 'a general-purpose model', supplier: 'a model lab' }, { type: 'tool', name: 'shopping', version: '1.4' }, { type: 'tool', name: 'payments', version: '0.9' }],
        incidentResponse: { contact: 'safety@pocket-agents.test' },
      })) : null;
      const r = await attempt(p.principal.registerAgent(agent, { label: agentName, records: world.records(bom?.ok ? bom.value.provenanceId : undefined), lineage: { max_depth: 1 } }));
      if (!r.ok) {
        return service({ place: `Town Hall · ${town}`, keeper: JUNIPER, title: 'Registration refused', ok: false, reasons: r.reasons, story: r.code === 'principal_not_verified' ? "The registry won't register an agent until someone has verified who stands behind it. Get verified first: it's the slow step, and it only happens once." : undefined });
      }
      for (const h of helpers()) h.status = 'gone';
      Object.assign(p, { agent, revoked: false, grant: null, helpers: [], badge: true, known: {} });
      emit({ kind: 'registry', actor: agentName, place: town, placeId: 'townhall', tone: 'ok', owner: pid, text: `${town} registered ${agentName} in ${r.value.issuance_ms} ms` });
      return service({
        place: `Town Hall · ${town}`, keeper: JUNIPER, title: `${agentName} is registered`,
        story: `Registered in **${r.value.issuance_ms} ms**. That's the fast step, because you're already verified.\n\nHere's ${agentName}'s badge. Every place sees a **different badge number**, so places can't compare notes about you. Next: the Records Office, to say what ${agentName} may do.`,
        facts: [{ label: 'Registry', value: town }, { label: 'Lineage depth budget', value: '1 (sub-agents yes, sub-sub-agents no)' }, { label: 'Bill of materials', value: 'on file at the Records Office; shown only to a place that asks, if you agree' }],
      });
    },

    badge({ on }) {
      if (!p.agent) throw new HttpError(409, 'no_agent', 'No badge yet. Register your agent at Town Hall.');
      p.badge = on === undefined ? !p.badge : Boolean(on);
      return { type: 'toggle', badge: p.badge };
    },

    incognito({ on }) {
      p.incognito = on === undefined ? !p.incognito : Boolean(on);
      return service({
        place: p.agent?.name ?? 'Your agent', keeper: { face: '🎭', who: 'Badge settings' }, title: p.incognito ? 'One-time badge numbers' : 'Steady badge numbers',
        story: p.incognito
          ? 'From now on your agent shows a **fresh badge number on every request** (an ephemeral PPID). A shop can no longer tell that two visits were the same agent. The registry can still connect them, if a court asks.'
          : 'Back to one stable number per place (a pairwise PPID): each shop recognizes you on a return visit, but no two shops can match notes.',
      });
    },

    async 'agent.revoke'() {
      if (!p.agent) throw new HttpError(409, 'no_agent', 'You have no agent to revoke.');
      const r = await attempt(p.principal.revokeAgent(p.agent, 'compromised'));
      if (!r.ok) return service({ place: town, keeper: JUNIPER, title: 'Revocation', ok: false, reasons: r.reasons });
      p.revoked = true;
      for (const h of helpers()) h.status = 'revoked';
      emit({ kind: 'registry', actor: p.agent.name, place: town, placeId: 'townhall', tone: 'warn', owner: pid, private: true, text: `${p.principal.name} revoked ${p.agent.name}; the revocation cascaded to ${r.value.cascades_to} sub-agent(s)` });
      return service({
        place: `Town Hall · ${town}`, keeper: JUNIPER, title: `${p.agent.name} is revoked`, stamp: { label: 'Revoked', tone: 'bad' },
        story: `${p.agent.name} is revoked${r.value.cascades_to ? `, and so ${r.value.cascades_to === 1 ? 'is its sub-agent' : `are its ${r.value.cascades_to} sub-agents`}` : ''}. Places that check live status refuse it from now on. You can register a new agent at Town Hall.`,
      });
    },

    // ---- Sub-agents -----------------------------------------------------------------
    async 'helper.spawn'({ kind = 'ephemeral', registry = 'town' }) {
      if (!p.agent) throw new HttpError(409, 'no_agent', 'Register your agent first: sub-agents are registered by it.');
      if (helpers().filter((h) => h.status === 'active').length >= 6) return service({ place: town, keeper: JUNIPER, title: 'Too many helpers', ok: false, reasons: ['The game keeps it to six sub-agents at once (the framework limits depth, not breadth).'] });
      const eu = registry === 'harbor';
      const reg = eu ? world.regB : world.regA;
      if (!reg) return service({ place: 'Harbor Registry', keeper: JUNIPER, title: 'No second registry', ok: false, reasons: ['this federation has only one registry'] });
      const name = HELPER_NAMES[p.helperCount++ % HELPER_NAMES.length];
      const child = world.agent(name);
      const expiresIn = kind === 'ephemeral' ? HELPER_LIFETIME_SECONDS : null;
      const r = await attempt(p.agent.registerSubagent(child, { registry: reg, label: name, records: world.records(), expiresIn }));
      const place = eu ? `Harbor Registry · ${reg.name}` : `Town Hall · ${town}`;
      if (!r.ok) return service({ place, keeper: JUNIPER, title: 'Sub-agent refused', ok: false, reasons: r.reasons });
      const npc = sim.addHelper({
        id: `helper-${name}-${Date.now()}`, name, agent: child, worldIdentity: p.worldIdentity, wallet: `${p.wallet}-${name}`,
        ephemeralUntil: expiresIn ? Date.now() + expiresIn * 1000 : null, registry: reg.name, owner: pid,
      });
      p.helpers.push(npc.id);
      emit({ kind: 'registry', actor: p.agent.name, place: reg.name, placeId: eu ? 'harbor' : 'townhall', tone: 'ok', owner: pid, text: `${p.agent.name} registered a sub-agent, ${name}, at ${reg.name}${expiresIn ? ' (ephemeral, 4 minutes)' : ''}` });
      return service({
        place, keeper: JUNIPER, title: `${name} is registered`,
        story: `${name} is a **sub-agent** of ${p.agent.name}${eu ? `, registered at **${reg.name}** across the river. Its chain still leads back to you through ${town}: the registries are federated` : ''}. ${expiresIn ? 'It is **ephemeral**: it lapses on its own in four minutes. ' : ''}It can't spend anything until the Records Office records a budget for it. Send it on errands from the action deck.`,
        facts: [{ label: 'Chain', value: `you → ${p.agent.name} → ${name}` }, { label: 'Registry', value: reg.name }, { label: 'Wallet', value: `5 ${ASSET}` }],
      });
    },

    async 'helper.fund'({ helper: id, budget }) {
      const h = helper(id);
      if (!p.grant) return service({ place: 'Records Office', keeper: MOSS, title: 'Nothing to delegate', ok: false, reasons: [`${p.agent?.name ?? 'Your agent'} has no authority of its own yet, so it has none to pass on. Sign a grant first.`] });
      const b = Number(budget) || 10;
      const r = await attempt(p.agent.delegate(h.agent, {
        permissions: [{ action: 'commerce.purchase', constraints: { max_amount: money(b), categories: CATEGORIES } }, { action: 'payments.authorize', constraints: { max_amount: money(b) } }, { action: 'trading.order', constraints: { max_amount: money(b) } }],
        validForDays: 1, purpose: 'Errands',
      }));
      if (!r.ok) {
        return service({ place: `Records Office · ${world.authRk?.name ?? ''}`, keeper: MOSS, title: 'Delegation refused', ok: false, reasons: r.reasons, story: r.code === 'exceeds_parent_authority' ? `A sub-agent can only get a slice of what ${p.agent.name} already has.` : undefined });
      }
      h.budget = b;
      return service({ place: `Records Office · ${world.authRk?.name ?? ''}`, keeper: MOSS, title: `${h.name} has a budget`, story: `Recorded. ${h.name} may spend up to **$${b} a purchase**. That's narrower than ${p.agent.name}'s grant, so it passes.` });
    },

    async 'helper.errand'({ helper: id, task }) {
      if (!id) return { ...service({ place: 'Sub-agents', keeper: { face: '🌱', who: 'Nobody to send' }, title: 'No sub-agents yet', ok: false, reasons: [`Spawn a sub-agent first: ${p.agent?.name ?? 'your agent'} registers it at Town Hall.`] }), fix: p.agent ? { action: 'helper.spawn', params: { kind: 'ephemeral' }, label: 'Spawn a sub-agent', place: 'townhall' } : null };
      const h = helper(id);
      if (!h.budget && String(task).match(/^(buy|pay|trade|toll)/)) {
        return { ...service({ place: 'Records Office', keeper: MOSS, title: `${h.name} has no budget yet`, ok: false, reasons: [`${h.name} may not spend anything until you give it a budget. Places would refuse it.`] }), fix: { action: 'helper.fund', params: { helper: h.id, budget: Math.round((p.grant?.budget ?? 50) / 2.5) }, label: `Give ${h.name} a budget`, place: 'records' } };
      }
      if (h.busy) return service({ place: h.name, keeper: { face: '🌱', who: h.name }, title: 'Busy', ok: false, reasons: [`${h.name} is already out: ${h.busy}.`] });
      const t = errandTask(task);
      if (!t) throw new HttpError(400, 'unknown_task', 'No such errand.');
      if (t.needsKey && !p.foundKey) return service({ place: h.name, keeper: { face: '🌱', who: h.name }, title: 'No key', ok: false, reasons: ["You don't have Maple's key."] });
      sim.errand(h, t, p.pos).then((card) => {
        if (card.receipt) p.receipts++;
      }).catch((err) => emit({ kind: 'info', tone: 'warn', owner: pid, text: `${h.name}'s errand failed: ${err.message}` }));
      return service({ place: h.name, keeper: { face: '🌱', who: h.name }, title: 'On its way', ok: null, story: `${h.name} is off to ${t.label}. Its result will show in the town ledger (bottom left) and over its head.` });
    },

    async 'helper.deeper'({ helper: id }) {
      const h = helper(id);
      const r = await attempt(h.agent.registerSubagent(world.agent(`${h.name}-jr`), { label: `${h.name}-jr`, records: world.records() }));
      return service({
        place: `Town Hall · ${town}`, keeper: JUNIPER, title: r.ok ? 'Registered (unexpected)' : 'Refused', ok: r.ok, reasons: r.ok ? [] : r.reasons,
        story: r.ok ? undefined : `When you registered ${p.agent.name}, you gave its lineage a **depth budget of one**. A sub-agent's own sub-agent would be two levels down.`,
      });
    },

    async 'helper.revoke'({ helper: id }) {
      const h = helper(id);
      const r = await attempt(p.agent.revokeSubagent(h.agent));
      if (r.ok) {
        h.status = 'revoked';
        setTimeout(() => sim.npcs.delete(h.id), 4000);
      }
      return service({ place: h.registry ?? town, keeper: JUNIPER, title: r.ok ? `${h.name} is revoked` : 'Refused', ok: r.ok, reasons: r.ok ? [] : r.reasons, stamp: r.ok ? { label: 'Revoked', tone: 'bad' } : undefined });
    },

    // ---- Authority -----------------------------------------------------------------
    async grant({ budget }) {
      if (!p.agent) throw new HttpError(409, 'no_agent', 'Register your agent first.');
      if (p.grant) return service({ place: 'Records Office', keeper: MOSS, title: 'Already granted', ok: null, story: `${p.agent.name}'s grant is on file: ${p.grant.permissions.join('; ')}. Revoke it here if you want to start again.` });
      const b = BUDGETS.includes(Number(budget)) ? Number(budget) : 50;
      const permissions = [
        { action: 'commerce.purchase', constraints: { max_amount: money(b), categories: CATEGORIES } },
        { action: 'payments.authorize', constraints: { max_amount: money(b) } },
        { action: 'compute.provision', constraints: { max_units: { value: 8, unit: 'gpu_hours' } } },
        { action: 'trading.order', constraints: { max_amount: money(b) } },
        { action: 'home.*' },
      ];
      const r = await attempt(p.principal.grant(p.agent, { rk: world.authRk, permissions, delegation: { allowed: true, max_depth: 1 }, purpose: 'Errands around AgentTown', validForDays: 30 }));
      if (!r.ok) return service({ place: 'Records Office', keeper: MOSS, title: 'Grant refused', ok: false, reasons: r.reasons });
      p.grant = { budget: b, id: r.value.grant_id, permissions: permissions.map(toRar).map(describePermission), plain: permissions.map(plainPermission) };
      emit({ kind: 'records', actor: p.agent.name, place: world.authRk.name, placeId: 'records', tone: 'ok', owner: pid, private: true, text: `${p.principal.name} deposited a grant for ${p.agent.name}: up to $${b} a purchase` });
      return service({
        place: `Records Office · ${world.authRk.name}`, keeper: MOSS, title: 'Grant deposited',
        story: `Signed and deposited. ${p.agent.name} may spend up to **$${b} a purchase** on books, home goods, food and health goods, pay bills up to $${b}, trade up to $${b} an order, rent up to 8 GPU-hours, and come and go at home. Nothing else.\n\nA place sees only the part that covers what ${p.agent.name} asks it for.`,
        facts: p.grant.plain.map((x) => ({ label: 'May', value: x })),
      });
    },

    async 'grant.revoke'() {
      if (!p.grant) return service({ place: 'Records Office', keeper: MOSS, title: 'No grant', ok: false, reasons: ['There is no grant on file to revoke.'] });
      const r = await attempt(p.principal.revokeGrant(world.authRk, p.grant.id));
      if (!r.ok) return service({ place: 'Records Office', keeper: MOSS, title: 'Refused', ok: false, reasons: r.reasons });
      p.grant = null;
      return service({ place: `Records Office · ${world.authRk.name}`, keeper: MOSS, title: 'Grant revoked', stamp: { label: 'Revoked', tone: 'bad' }, story: `The grant is revoked. ${p.agent?.name ?? 'Your agent'} is still registered and accountable, but has no authority: places will refuse anything that needs it.` });
    },

    receipts() {
      return { type: 'receipts', total: p.receipts, entries: [] };
    },

    // ---- Shops and services -------------------------------------------------------------
    async buy({ shop, item }) {
      const def = PLACE_DEFS[shop]?.items?.find((i) => i.id === item);
      if (!def) throw new HttpError(404, 'unknown_item', 'No such item.');
      const short = broke(PLACE_DEFS[shop].name, def.price);
      if (short) return short;
      const card = spend(await visit(shop, 'commerce.purchase', P.purchase(shop, def)), def.price);
      if (card.decision === 'allow') {
        p.inventory.push({ name: def.name, from: card.place });
        p.events.add(`bought:${shop}`);
      }
      return card;
    },
    async pay({ bill }) {
      const def = PLACE_DEFS.bank.bills.find((b) => b.id === bill) ?? PLACE_DEFS.bank.bills[0];
      return broke('First Ledger Bank', def.amount) ?? spend(await visit('bank', 'payments.authorize', { payee: def.name, amount: money(def.amount) }), def.amount);
    },
    compute: ({ job }) => {
      const def = PLACE_DEFS.forge.jobs.find((j) => j.id === job) ?? PLACE_DEFS.forge.jobs[0];
      return visit('forge', 'compute.provision', { units: def.units, unit: 'gpu_hours' });
    },
    async 'fair.claim'() {
      const card = await visit('fair', 'fair.claim', {});
      if (card.decision === 'allow') p.inventory.push({ name: 'A free pie', from: 'Harvest Fair' });
      return card;
    },
    'toll.pay': () => visit('toll', 'payments.authorize', { payee: 'Bridge Toll', amount: money(0.5) }),

    async 'id.ask'({ npc: who }) {
      const them = lookup(who);
      if (!them) throw new HttpError(404, 'gone', 'They have left.');
      const card = await P.visit('reader', 'id.check', {}, them);
      if (card.ppid && card.registry) {
        p.cases.push({ id: `case-${p.cases.length + 1}`, ppid: card.ppid, sealed_ref: card.sealed_ref, rp: P.reader.rp.id, registry: card.registry, about: `${them.name}, whose badge you checked` });
      }
      return { ...card, title: `${them.name}'s badge`, place: 'Your badge reader' };
    },

    async trade({ symbol, side = 'buy', qty = 2 }) {
      const price = P.quote(symbol);
      if (!price) throw new HttpError(404, 'unknown_symbol', 'No such symbol.');
      const n = Math.max(1, Math.min(50, Number(qty) || 1));
      const total = Math.round(price * n * 100) / 100;
      if (side === 'buy') return broke('Thistle Exchange', total) ?? spend(await visit('exchange', 'trading.order', { symbol, side, qty: n, amount: money(total) }), total);
      return spend(await visit('exchange', 'trading.order', { symbol, side, qty: n, amount: money(total) }), -total);
    },

    'bank.open': () => visit('bank', 'banking.open_account', {}),

    /** Knock at someone else's door: the lock asks its owner, who may be another person playing. */
    async 'neighbor.knock'({ home }) {
      const n = neighbors().find((x) => x.account === home);
      if (!n) throw new HttpError(404, 'no_home', 'No such home.');
      const card = await visit('hearth', 'home.enter', { account: home });
      if (card.decision === 'step_up' && card.approval_request) {
        if (n.human) {
          p.knocks.push({ account: home, label: n.label, request_id: card.approval_request.request_id, at: Date.now() });
          card.note = `${n.label}'s phone is buzzing: a person decides who comes in. If they approve, try the door again.`;
        } else {
          P.hearth.rp.accounts.decline(card.approval_request.request_id);
          card.declined_by = n.label;
          card.note = `The lock asked the owner of ${n.label}. Their phone showed who stands behind your agent, but not who. They don't know you, so they declined.`;
        }
      }
      if (card.decision === 'allow' && card.result?.items) card.result = { visited: n.label };
      return card;
    },

    /** Tell the police about a badge you checked or a visitor you had. */
    async 'police.complain'({ case: caseId }) {
      const c = p.cases.find((x) => x.id === caseId) ?? p.cases[0];
      if (!c) return service({ place: 'Police Station', keeper: { face: '👮', who: 'Desk sergeant' }, title: 'Nothing to report', ok: false, reasons: ['Bring a badge number: check someone\'s badge first, or wait for trouble at your door.'] });
      const filed = justice.fileCase({ kind: 'complaint', placeId: 'police', title: `Complaint from ${p.principal?.name ?? 'a resident'} about ${c.about}`, evidence: [{ ppid: c.ppid, registry: c.registry, sealed_ref: c.sealed_ref, rp: c.rp, place: 'a complaint' }], by: p.principal?.name ?? 'a resident', owner: pid });
      return service({ place: 'Police Station', keeper: { face: '👮', who: 'Desk sergeant' }, title: `Case ${filed.id} opened`, story: `We've opened case **${filed.id}**. The badge number is all we need: a judge can order the registry to say who stands behind it.` });
    },

    // ---- Home -------------------------------------------------------------------
    async 'home.enter'() {
      const card = await visit('hearth', 'home.enter', { account });
      if (card.decision === 'allow') p.events.add('home');
      if (card.decision === 'step_up' && card.approval_request) card.pending = { request_id: card.approval_request.request_id, retry: { action: 'home.enter', params: {} } };
      return { ...card, keeper: DOOR };
    },
    'home.key': () => visit('hearth', 'home.enter', { account_token: keys[account] }),
    'home.knock'() {
      const params = { account };
      const req = P.hearth.rp.accounts.openRequest(account, 'approve-action', { actor: 'human', action: 'home.enter', params_digest: digestOf(params), summary: 'Open your front door (you, in person)' });
      return service({ place: 'Your front door', keeper: DOOR, title: 'Check your phone', ok: null, story: 'The lock sent a request to your phone. Approve it with your passkey and the door opens, just this once.', pending: undefined, request_id: req.request_id, pendingRequest: { request_id: req.request_id, retry: { action: 'home.inPerson', params: { requestId: req.request_id } } } });
    },
    async 'home.inPerson'({ requestId }) {
      const r = await world.rawRequest(P.hearth.rp.url, 'home.enter', { account }, requestId ? { [HEADERS.humanApproval]: requestId } : {});
      return track(P.cardFrom(P.hearth, 'home.enter', 'you, in person', r));
    },
    async 'home.discard'({ item, approvalRef }) {
      const card = await visit('hearth', 'home.discard', { account, item }, approvalRef ? { headers: { [HEADERS.approvalRef]: approvalRef } } : {});
      if (card.decision === 'step_up' && card.approval_request) card.pending = { request_id: card.approval_request.request_id, retry: { action: 'home.discard', params: { item, approvalRef: card.approval_request.request_id } } };
      return card;
    },
    'maple.knock': async () => {
      const card = await visit('hearth', 'home.enter', { account: 'maple' });
      if (card.decision === 'step_up' && card.approval_request) {
        P.hearth.rp.accounts.decline(card.approval_request.request_id);
        card.declined_by = 'Maple';
      }
      return card;
    },
    'maple.key': async () => {
      if (!p.foundKey) return service({ place: "Maple's door", keeper: { face: '🐰', who: "Maple's door" }, title: 'No key', ok: false, reasons: ["You don't have Maple's key. It's somewhere on a street in Hearthside."] });
      p.events.add('tried-key');
      return visit('hearth', 'home.enter', { account_token: keys.maple });
    },
    'key.pickup'() {
      p.foundKey = true;
      return { type: 'toggle', foundKey: true };
    },
    night: () => night(),

    // ---- Mischief: things the framework should refuse ---------------------------------------
    async 'mischief.wrongplace'({ at }) {
      const target = P.places[at];
      const elsewhere = p.agent && [...p.agent.contexts.values()].find((c) => c.audience !== target.rp.id && c.attestation);
      if (!elsewhere) return service({ place: target.name, keeper: target.keeper, title: 'Nothing to show', ok: false, reasons: [`${p.agent?.name ?? 'Your agent'} hasn't shown its badge anywhere else yet.`] });
      const r = await world.handBuiltRequest({ rp: target.rp, action: target.action, params: sampleParams(at), accountability: elsewhere.attestation, authorization: elsewhere.authorization ?? undefined, proofKey: elsewhere.key });
      return { ...track(P.cardFrom(target, target.action, `${p.agent.name} (badge from elsewhere)`, r)), note: 'Every badge is issued for one place. This one was made out to somewhere else, so it proves nothing here.' };
    },
    async 'mischief.forge'({ at }) {
      const target = P.places[at];
      const forgerKey = generateSigningKey();
      const now = nowSeconds();
      const forged = issueSdJwt({
        vct: `${world.trust.trustAnchor.entity_id}/vct/accountability/1`, iss: 'https://registry-x.example', sub: 'ppid:registry-x.example:p_0000000000000000000000000', aud: target.rp.id, iat: now, exp: now + 300,
        cnf: { jwk: publicOf(forgerKey.publicJwk) }, ppid_mode: 'pairwise',
        accountability: { status: 'accountable', root_principal: { type: 'natural_person', verified: true, verification: { trust_framework: 'nist_800_63A', assurance_level: 'IAL2', verifier: 'https://trust-me.example' }, identity: 'protected' }, chain_length: 1, attributes: [] },
        records: [],
      }, generateSigningKey(), { typ: 'dc+sd-jwt' });
      const r = await world.handBuiltRequest({ rp: target.rp, action: target.action, params: sampleParams(at), accountability: forged, proofKey: forgerKey });
      return { ...track(P.cardFrom(target, target.action, 'a forged badge', r)), note: 'The badge looks right, but no registry in the federation signed it.' };
    },
    async 'mischief.replay'({ at }) {
      const target = P.places[at];
      const victim = [...sim.npcs.values()].find((n) => n.kind === 'resident' && n.agent?.contexts.get(target.rp.id)?.attestation);
      if (!victim) return service({ place: target.name, keeper: target.keeper, title: 'Nothing to copy', ok: false, reasons: [`No resident has shown a badge at ${target.name} yet. Wait for one to shop there.`] });
      const ctx = victim.agent.contexts.get(target.rp.id);
      const r = await world.handBuiltRequest({ rp: target.rp, action: target.action, params: sampleParams(at), accountability: ctx.attestation, authorization: ctx.authorization ?? undefined, proofKey: generateSigningKey() });
      return { ...track(P.cardFrom(target, target.action, `a copy of ${victim.name}'s badge`, r)), note: `You copied ${victim.name}'s badge, but not the key it is bound to. Every request has to be signed by the agent holding that key.` };
    },
    async 'mischief.claim'({ at }) {
      const target = P.places[at];
      const r = await world.rawRequest(target.rp.url, target.action, sampleParams(at), { 'aaf-claim': `principal="${p.principal?.name ?? 'Someone'}"; accountable=true` });
      return { ...track(P.cardFrom(target, target.action, 'a self-asserted claim', r)), note: 'Saying "someone stands behind me" is not the same as a registry vouching for it.' };
    },
  };

  function sampleParams(at) {
    if (PLACE_DEFS[at]?.items) return P.purchase(at, PLACE_DEFS[at].items[0]);
    if (at === 'bank') return { payee: 'the water bill', amount: money(30) };
    if (at === 'forge') return { units: 4, unit: 'gpu_hours' };
    if (at === 'toll') return { payee: 'Bridge Toll', amount: money(0.5) };
    return {};
  }

  function errandTask(task) {
    const [kind, a] = String(task).split(':');
    if (kind === 'buy') {
      const [shop, item] = a.split('/');
      const def = PLACE_DEFS[shop]?.items?.find((i) => i.id === item);
      return def && { label: `buy ${def.name.toLowerCase()} at ${PLACE_DEFS[shop].name}`, place: shop, action: 'commerce.purchase', params: P.purchase(shop, def) };
    }
    if (kind === 'pay') return { label: 'pay the water bill', place: 'bank', action: 'payments.authorize', params: { payee: 'the water bill', amount: money(30) } };
    if (kind === 'fair') return { label: 'claim a free pie at the Harvest Fair', place: 'fair', action: 'fair.claim', params: {} };
    if (kind === 'toll') return { label: 'pay the bridge toll', place: 'toll', action: 'payments.authorize', params: { payee: 'Bridge Toll', amount: money(0.5) } };
    if (kind === 'trade' && P.quote(a)) return { label: `buy 2 ${a} at the Thistle Exchange`, place: 'exchange', action: 'trading.order', params: { symbol: a, side: 'buy', qty: 2, amount: money(Math.round(P.quote(a) * 2 * 100) / 100) } };
    if (kind === 'maplekey') return { label: "try Maple's key", place: 'maple', placeId: 'hearth', action: 'home.enter', params: { account_token: keys.maple }, needsKey: true };
    return null;
  }

  // ---- Night: visitors with a copy of your key ----------------------------------------
  async function night() {
    if (!nightjar) {
      const principal = await world.verifiedPrincipal({
        type: 'legal_person', identity: { legal_name: 'Nightjar Labs Inc.', jurisdiction: 'US-DE', registration_number: 'DE-5521907' }, assurance: 'high', method: 'KYB: registry extract', registry: world.regA,
      });
      const burglars = [];
      for (let i = 1; i <= 3; i++) {
        const a = world.agent(`eval-runner-${i}`);
        await principal.registerAgent(a, { label: `eval-runner-${i}`, records: world.records() });
        burglars.push(a);
      }
      nightjar = { principal, burglars };
    }
    const before = (await nightjar.principal.notifications()).length;
    const params = { account_token: keys[account] };
    const results = [];
    for (const a of nightjar.burglars) {
      const card = await P.visit('hearth', 'home.enter', params, { name: a.name, agent: a, badge: true });
      if (card.ppid) p.cases.push({ id: `night-${p.cases.length + 1}`, ppid: card.ppid, rp: P.hearth.rp.id, registry: card.registry, about: 'one of the badges at your door last night' });
      results.push({ ...card, presented: 'a badge and a copy of your house key' });
    }
    const anon = await P.visit('hearth', 'home.enter', params, { name: 'someone with no badge', agent: null });
    results.push({ ...anon, presented: 'a copy of your house key, nothing else' });
    const relayed = (await nightjar.principal.notifications()).slice(before).filter((n) => n.kind === 'incident');
    p.events.add('night');
    emit({ kind: 'info', place: 'Hearth & Key', placeId: 'home', tone: 'ok', owner: pid, private: true, text: `Four night visitors tried a copy of your key; nobody got in; ${relayed.length} reports relayed to whoever stands behind them` });
    return { type: 'night', results, got_in: results.filter((r) => r.decision === 'allow').length, incidents_relayed: relayed.length };
  }

  // ---------------------------------------------------------------------------
  // The catalog the action deck shows: everything, every time.
  // ---------------------------------------------------------------------------

  const DONE = {
    verify: () => p.verified,
    register: () => Boolean(p.agent && !p.revoked),
    grant: () => Boolean(p.grant),
    'worldid.enroll': () => Boolean(p.worldIdentity),
    'door.passkey': () => (P.hearth.rp.accounts.get(account)?.passkeys.size ?? 0) > 0,
  };

  function catalog() {
    const hs = helpers().filter((h) => h.status === 'active');
    const helperOpts = hs.map((h) => ({ value: h.id, label: h.name, hint: h.busy ? `out: ${h.busy}` : h.budget ? `up to $${h.budget}` : 'no budget yet' }));
    const placeOpts = TARGETS.map((id) => ({ value: id, label: PLACE_DEFS[id].name }));
    const budgetBase = p.grant?.budget ?? 50;
    const errands = [
      ...SHOPS.flatMap((s) => PLACE_DEFS[s].items.filter((i) => !i.restricted).slice(0, 2).map((i) => ({ value: `buy:${s}/${i.id}`, label: `Buy ${i.name.toLowerCase()} at ${PLACE_DEFS[s].name}`, hint: `$${i.price}` }))),
      { value: 'pay', label: 'Pay the water bill', hint: '$30' },
      { value: 'fair', label: 'Claim a free pie at the Harvest Fair' },
      { value: 'toll', label: 'Pay the bridge toll', hint: `x402, 0.5 ${ASSET}` },
      ...P.market().map((m) => ({ value: `trade:${m.id}`, label: `Buy 2 ${m.id} at the Thistle Exchange`, hint: `$${m.price} each` })),
      { value: 'maplekey', label: "Try Maple's key", hint: p.foundKey ? 'you have it' : "you haven't found it" },
    ];
    const name = p.agent?.name ?? 'your agent';
    return [
      { id: 'verify', group: 'You', icon: '🪪', label: 'Get verified (KYC)', hint: 'Once. Only the registry keeps your name.', place: 'townhall' },
      { id: 'worldid.enroll', group: 'You', icon: '🔮', label: 'Get a World ID at the Orb', hint: 'Simulated: proof you are a unique human, no name', place: 'orb' },
      { id: 'disclose', group: 'You', icon: '📛', label: p.disclose ? 'Ask me before sharing my name' : 'Share my name with any place that asks', hint: p.disclose ? 'Back to asking on your phone each time' : 'Skip the phone: standing consent for the whole town' },
      { id: 'court', group: 'You', icon: '⚖️', label: 'Ask the court who is behind a badge', hint: 'Resolution under legal process', place: 'court', params: [{ key: 'case', label: 'Which case?', options: p.cases.map((c) => ({ value: c.id, label: c.about })) }] },
      { id: 'police.complain', group: 'You', icon: '👮', label: 'Report someone to the police', hint: 'A badge you checked, or a visitor', place: 'police', params: [{ key: 'case', label: 'About whom?', options: p.cases.map((c) => ({ value: c.id, label: c.about })) }] },

      { id: 'register', group: 'Your agent', icon: '🤖', label: p.revoked ? 'Register a new agent' : 'Register your agent', hint: 'The fast step, once you are verified', place: 'townhall', params: [{ key: 'name', label: "Your agent's name", input: true, value: p.revoked ? '' : 'Pip' }] },
      { id: 'badge', group: 'Your agent', icon: p.badge ? '🙈' : '🪪', label: p.badge ? 'Take your badge off' : 'Put your badge on', hint: 'Key: B' },
      { id: 'incognito', group: 'Your agent', icon: '🎭', label: p.incognito ? 'Use steady badge numbers' : 'Use one-time badge numbers', hint: 'Ephemeral PPIDs: a fresh number every request' },
      { id: 'agent.revoke', group: 'Your agent', icon: '⛔', label: `Revoke ${name} (device stolen)`, hint: 'Cascades to its sub-agents', danger: true },

      { id: 'helper.spawn', group: 'Sub-agents', icon: '🌱', label: 'Spawn a sub-agent', hint: `Registered by ${name}`, place: 'townhall', params: [{ key: 'kind', label: 'What kind?', options: [{ value: 'ephemeral', label: 'Ephemeral', hint: 'lapses in 4 minutes' }, { value: 'standing', label: 'Standing', hint: 'until revoked' }] }] },
      { id: 'helper.spawn', group: 'Sub-agents', icon: '🇪🇺', label: 'Spawn a sub-agent at the Harbor Registry (EU)', hint: 'Cross-registry: a federated chain', place: 'harbor', fixed: { registry: 'harbor', kind: 'standing' }, key: 'helper.spawn.eu' },
      { id: 'helper.errand', group: 'Sub-agents', icon: '🧺', label: 'Send a sub-agent on an errand', hint: helperOpts.length ? 'It walks there and back on its own' : 'Spawn a sub-agent first', params: helperOpts.length ? [{ key: 'helper', label: 'Who?', options: helperOpts }, { key: 'task', label: 'To do what?', options: errands }] : [] },
      { id: 'helper.fund', group: 'Sub-agents', icon: '💰', label: 'Give a sub-agent a budget', hint: 'Delegation, at the Records Office', place: 'records', params: [{ key: 'helper', label: 'Who?', options: helperOpts }, { key: 'budget', label: 'How much a purchase?', options: [Math.round(budgetBase / 5), Math.round(budgetBase / 2.5), budgetBase * 2].map((v) => ({ value: v, label: `$${v}`, hint: v > budgetBase ? `more than ${name} has` : '' })) }] },
      { id: 'helper.deeper', group: 'Sub-agents', icon: '🪆', label: 'Ask a sub-agent to spawn its own', hint: 'Depth budget', params: [{ key: 'helper', label: 'Who?', options: helperOpts }] },
      { id: 'helper.revoke', group: 'Sub-agents', icon: '✂️', label: 'Revoke a sub-agent', params: [{ key: 'helper', label: 'Who?', options: helperOpts }] },

      { id: 'grant', group: 'Authority', icon: '📜', label: 'Sign a grant', hint: 'What your agent may do', place: 'records', params: [{ key: 'budget', label: 'Spending limit per purchase', options: BUDGETS.map((b) => ({ value: b, label: `Up to $${b}` })) }] },
      { id: 'grant.revoke', group: 'Authority', icon: '🗑️', label: 'Revoke the grant', place: 'records' },
      { id: 'receipts', group: 'Authority', icon: '🧾', label: 'Show activity receipts', place: 'records', client: 'receipts' },

      ...SHOPS.map((s) => ({ id: 'buy', group: 'Shops & services', icon: SHOP_ICONS[s] ?? '🛍️', label: `Buy at ${PLACE_DEFS[s].name}`, hint: P.adoptionOf(P.places[s]) === 'full' ? undefined : { none: "doesn't check badges", block: 'blocks agents', pilot: 'pilot: badges optional' }[P.adoptionOf(P.places[s])], place: s, fixed: { shop: s }, key: `buy.${s}`, params: [{ key: 'item', label: 'What?', options: PLACE_DEFS[s].items.map((i) => ({ value: i.id, label: i.name, hint: `$${i.price}${i.category ? ` (${i.category})` : ''}` })) }] })),
      { id: 'pay', group: 'Shops & services', icon: '🏦', label: 'Pay at First Ledger Bank', place: 'bank', params: [{ key: 'bill', label: 'Pay what?', options: PLACE_DEFS.bank.bills.map((b) => ({ value: b.id, label: b.name, hint: `$${b.amount}` })) }] },
      { id: 'bank.open', group: 'Shops & services', icon: '🏦', label: 'Open an account at First Ledger Bank', hint: 'Know-your-customer: the bank needs your name', place: 'bank' },
      { id: 'trade', group: 'Shops & services', icon: '📈', label: 'Trade at the Thistle Exchange', place: 'exchange', params: [
        { key: 'symbol', label: 'Which?', options: P.market().map((m) => ({ value: m.id, label: `${m.id} · ${m.name}`, hint: `$${m.price} (${m.change >= 0 ? '+' : ''}${m.change}% today)` })) },
        { key: 'side', label: 'Buy or sell?', options: [{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }] },
        { key: 'qty', label: 'How many?', options: [1, 2, 5, 10].map((n) => ({ value: n, label: String(n) })) },
      ] },
      { id: 'compute', group: 'Shops & services', icon: '🔥', label: 'Rent GPUs at the Compute Forge', place: 'forge', params: [{ key: 'job', label: 'How big?', options: PLACE_DEFS.forge.jobs.map((j) => ({ value: j.id, label: j.name })) }] },
      { id: 'fair.claim', group: 'Shops & services', icon: '🥧', label: 'Claim a free pie at the Harvest Fair', hint: 'One per person', place: 'fair' },
      { id: 'toll.pay', group: 'Shops & services', icon: '🌉', label: 'Pay the bridge toll', hint: `x402 · 0.5 ${ASSET} (simulated)`, place: 'toll' },
      { id: 'id.ask', group: 'Shops & services', icon: '🔍', label: "Ask someone to show their badge", hint: 'Your own badge reader', params: [{ key: 'npc', label: 'Whom?', options: 'npcs' }] },

      { id: 'door.passkey', group: 'Home', icon: '🔑', label: 'Put a passkey on your door', hint: 'Touch ID, Face ID or device PIN', place: 'home', client: 'passkey' },
      { id: 'home.enter', group: 'Home', icon: '🚪', label: `Send ${name} in`, place: 'home' },
      { id: 'home.knock', group: 'Home', icon: '✋', label: 'Knock in person (passkey)', hint: 'The human path', place: 'home' },
      { id: 'home.key', group: 'Home', icon: '🗝️', label: 'Just use your house key', hint: 'A bearer token', place: 'home' },
      { id: 'night', group: 'Home', icon: '🌙', label: 'Rest at home until night', place: 'home', client: 'night' },
      { id: 'neighbor.knock', group: 'Home', icon: '🚪', label: "Knock at a neighbor's door", hint: 'Its owner decides', params: [{ key: 'home', label: 'Whose door?', options: neighbors().map((n) => ({ value: n.account, label: n.label, walk: n.place, hint: n.human ? 'someone is home' : 'nobody is playing here' })) }] },
      { id: 'maple.key', group: 'Home', icon: '🗝️', label: "Try Maple's key", place: 'maple', hint: p.foundKey ? 'you found it' : 'lost somewhere in Hearthside' },

      { id: 'mischief.wrongplace', group: 'Mischief', icon: '🔀', label: 'Show a badge made out to another place', params: [{ key: 'at', label: 'Where?', options: placeOpts, here: true }] },
      { id: 'mischief.forge', group: 'Mischief', icon: '🖨️', label: 'Show a forged badge', params: [{ key: 'at', label: 'Where?', options: placeOpts, here: true }] },
      { id: 'mischief.replay', group: 'Mischief', icon: '📋', label: "Replay a copy of a resident's badge", params: [{ key: 'at', label: 'Where?', options: placeOpts, here: true }] },
      { id: 'mischief.claim', group: 'Mischief', icon: '🗣️', label: 'Just claim to be accountable', params: [{ key: 'at', label: 'Where?', options: placeOpts, here: true }] },
    ].map((a) => ({ ...a, key: a.key ?? a.id, done: DONE[a.key ?? a.id]?.() ?? false }));
  }

  async function run(id, params = {}) {
    const fn = ACTIONS[id];
    if (!fn) throw new HttpError(404, 'unknown_action', `no action ${id}`);
    const out = await fn(params);
    // A place asked for something the agent didn't show: put the question on the principal's phone.
    if (out?.ask && out.decision === 'step_up') {
      p.asks = p.asks.filter((a) => !(a.placeId === out.ask.placeId && a.retry.action === id));
      const ask = { id: `ask-${++p.askCount}`, ...out.ask, retry: { action: id, params }, at: Date.now() };
      p.asks.push(ask);
      out.ask = { ...out.ask, id: ask.id };
    }
    return out;
  }

  async function enroll({ name }) {
    if (p.principal) throw new HttpError(409, 'already_enrolled', 'You are already enrolled.');
    const legalName = String(name ?? '').trim().slice(0, 40) || 'A Resident';
    p.principal = await world.enrolledPrincipal({ type: 'natural_person', identity: { legal_name: legalName, jurisdiction: 'US-NY' }, registry: world.regA });
    P.hearth.rp.accounts.get(account).owner = legalName;
    return { principal_id: p.principal.id, registry: town };
  }

  async function state() {
    const all = p.principal ? await p.principal.notifications().catch(() => []) : [];
    const notifications = all.filter((n) => n.kind === 'incident').concat(all.filter((n) => n.kind === 'resolution').map((n) => ({
      incident_id: n.resolution_id, agent_label: n.agent_label, reporter: n.authority, summary: `A court order (case ${n.case}) made the registry say who stands behind this agent`, at: n.at,
    })));
    const ppidAtHome = p.agent?.contexts.get(P.hearth.rp.id)?.ppid;
    const knocks = p.knocks.map((k) => {
      const ppid = p.agent?.contexts.get(P.hearth.rp.id)?.ppid;
      const pendingNow = P.hearth.rp.accounts.pendingFor(k.account).some((r) => r.id === k.request_id);
      const status = ppid && P.hearth.rp.accounts.delegationFor(k.account, ppid, 'home.enter') ? 'approved' : pendingNow ? 'waiting' : 'declined';
      return { ...k, status };
    });
    return {
      principal: p.principal ? { name: p.principal.name, verified: p.verified, registry: town, worldid: Boolean(p.worldIdentity), disclose: p.disclose, banned: justice?.isBanned(p.principal.identity) ?? null, facts: p.verified ? ['over 18'] : [] } : null,
      knocks,
      market: P.market(),
      agent: p.agent ? { name: p.agent.name, status: p.revoked ? 'revoked' : 'active', incognito: p.incognito } : null,
      badge: Boolean(p.agent && p.badge),
      grant: p.grant,
      wallet: { balance: x402.balance(p.wallet), spent: p.spent, asset: ASSET },
      helpers: helpers().map((h) => ({ id: h.id, name: h.name, status: h.status, budget: h.budget ?? null, busy: h.busy ?? null, registry: h.registry, ephemeral_until: h.ephemeralUntil })),
      home: { passkey: (P.hearth.rp.accounts.get(account)?.passkeys.size ?? 0) > 0, agent_let_in: Boolean(ppidAtHome && P.hearth.rp.accounts.delegationFor(account, ppidAtHome, 'home.enter')) },
      found_key: p.foundKey, inventory: p.inventory, known: Object.values(p.known), receipts: p.receipts, events: [...p.events],
      phone: {
        incidents: notifications.map((n) => ({ id: n.incident_id, agent: n.agent_label, reporter: placeName(n.reporter), summary: n.summary, at: n.at })),
        approvals: P.hearth.rp.accounts.pendingFor(account).map(({ id, purpose, details }) => ({ request_id: id, purpose, details })),
        asks: p.asks.map(({ id, place, placeId, what, tier, law, at }) => ({ id, place, placeId, what, tier, law, at })),
        consent: Object.entries(p.consent).map(([placeId, c]) => ({
          placeId, place: P.places[placeId]?.name ?? placeId,
          what: [c.identity && 'your name', ...(c.attributes ?? []).map((a) => ATTRIBUTES[a]?.label ?? a), c.provenance && 'bill of materials'].filter(Boolean),
        })),
      },
      cases: p.cases.length,
    };
  }

  const placeName = (id) => Object.values(P.places).find((x) => x.rp?.id === id)?.name ?? id;

  return {
    catalog, run, enroll, state, reset, account,
    /** How this player's agent presents itself when someone asks to see its badge. */
    presentAs: () => by(),
    setPos(pos) {
      if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) p.pos = { x: pos.x, y: pos.y };
    },
    get pos() {
      return p.pos;
    },
    get principal() {
      return p.principal;
    },
    /** What others see walking past. */
    appearance: () => ({ name: p.agent?.name ?? 'a newcomer', badge: Boolean(p.agent && p.badge), revoked: p.revoked }),
  };
}
