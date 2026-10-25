// AgentTown on the server: the federation (local or external), the places and
// their policies, the simulated inhabitants, the people playing, police and
// courts, the town ledger, and the director's cues for live demos and videos.
import { loadConfig, connectFederation } from './federation.js';
import { buildWorld } from './world.js';
import { createPlaces, PLACE_DEFS, ADOPTION, PEOPLE } from './places.js';
import { REGIMES } from './rulebook.js';
import { createSim } from './sim.js';
import { createSessions } from './sessions.js';
import { createJustice } from './justice.js';
import { createWorldId } from './worldid.js';
import { createX402 } from './x402.js';
import { createKeeper } from './proposed/keeper.js';
import { createFederations, startAnchor, readEntity } from './proposed/anchors.js';
import { startSampleFederation, asMembers } from './proposed/sample-federation.js';
import { checkService } from './proposed/door.js';
import { generateSigningKey, thumbprint } from 'aaf-reference/src/lib/crypto.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';

export async function createTown({ origin, portOffset = 7000, config = loadConfig(), residents = true, timeScale = 1, address = null }) {
  // With an address, the town's own federation, its participants' anchor and any sample are reachable from other
  // machines at it (they listen on every interface); without one, they stay on this machine.
  const listen = address ? '0.0.0.0' : '127.0.0.1';
  const fed = await connectFederation({ federation: config.federation, portOffset, address });
  // Proposed (docs/PROPOSED.md §6): several trust anchors. The town's own federation; one the town runs for
  // participants, which admits registries and record keepers while it runs; and any others added by address.
  const federations = createFederations();
  await federations.add({ key: 'town', name: fed.kind === 'local' ? 'The town’s federation' : fed.trust.doc.federation, kind: 'town', anchor: fed.anchor, view: fed.trust, overrides: fed.overrides });
  const participants = await startAnchor({
    entityId: 'https://participants.agenttown.test', name: 'AgentTown Participants', key: generateSigningKey(), policies: fed.trust.policies,
    host: listen, address, port: 4170 + portOffset, // a steady address to give teams; clear of the federation's own ports
    members: asMembers(fed.trust), // it accepts the town's identity verifier and court
    open: true,
  });
  await federations.add({ key: 'participants', name: 'AgentTown Participants', kind: 'participants', anchor: participants.anchor, owner: participants });
  const world = buildWorld({ trust: federations.view(), keysDir: fed.keysDir, adminTokens: fed.adminTokens, federations });
  // Every party re-reads its federations every 30 s (Reference Profile §6.1): new members, new trust marks.
  const refresher = setInterval(() => federations.refresh().catch(() => {}), 30000);

  // The town ledger: everything anyone did, newest last.
  const ledger = { seq: 0, items: [] };
  const emit = (e) => {
    const item = { ...e, seq: ++ledger.seq, at: Date.now() };
    ledger.items.push(item);
    if (ledger.items.length > 600) ledger.items.shift();
    return item;
  };

  let sessions = null;
  const justice = createJustice({ world, emit, people: () => sessions?.counts() ?? { police: 0, judge: 0 }, timeScale });
  const worldid = createWorldId();
  const x402 = createX402();
  // Proposed extension: the principal's record, allowances and statements (src/proposed, docs/PROPOSED.md).
  const keeper = createKeeper({ rpId: new URL(origin).hostname, origin });
  const places = await createPlaces({
    world, origin, config: config.places, law: config.law, worldid, x402, emit, keeper, federations,
    alert: (a) => justice.fileCase({ kind: a.kind, placeId: a.placeId, title: a.title, evidence: a.evidence, by: PLACE_DEFS[a.placeId]?.name ?? 'Hearth & Key' }),
  });
  const keys = {};
  places.resetHomes(keys);
  const sim = createSim({ world, places, emit, worldid, x402, origin, keys, timeScale });
  sessions = createSessions({ world, places, sim, worldid, x402, emit, keys, justice, ledger, origin, timeScale });
  if (residents) await sim.start();
  emit({ kind: 'director', tone: 'info', text: `AgentTown is open. Federation: ${fed.kind} (${world.registries.map((r) => r.name).join(', ')})` });

  let swarmRunning = false;
  let sample = null;
  /** What the town knows about each federation, for the halls. */
  const federationView = (f) => ({
    key: f.key, name: f.name, kind: f.kind, anchor: f.anchor.entity_id, url: f.anchor.url,
    registries: f.view.registries.map((r) => ({ id: r.id, name: r.name, url: r.url, chain: r.chain })),
    recordKeepers: f.view.recordKeepers.map((r) => ({ id: r.id, name: r.name, url: r.url, roles: r.roles, chain: r.chain, accredited: (r.trust_marks ?? []).length > 0 })),
    acceptsTownVerifier: Boolean(world.kyc && f.view.authority(world.kyc.id, 'verifier')),
  });
  /** A federation was added, or gained a member: tell the town, and let places see it (if they choose to trust it). */
  /** Someone from a federation the town just added comes to visit (in a town with residents). */
  const visitor = (f) => {
    if (residents && f.kind !== 'town') sim.visitorFrom(f).catch((err) => emit({ kind: 'info', tone: 'warn', text: `A visitor from ${f.name} couldn't come: ${err.message}` }));
  };
  const announceFederation = (f, what) => emit({ kind: 'federation', tone: 'info', text: `${what}. ${f.name} lists ${f.view.registries.length} registr${f.view.registries.length === 1 ? 'y' : 'ies'} and ${f.view.recordKeepers.length} record keeper${f.view.recordKeepers.length === 1 ? '' : 's'}. Places decide for themselves whether to trust it.` });

  const director = {
    /** Someone else's federation: its own trust anchor, registry and record keeper. Not added until someone adds it. */
    async sample({ add = false } = {}) {
      if (!sample) {
        sample = await startSampleFederation({ basePort: 4150 + portOffset, host: listen, address, policies: fed.trust.policies, authorities: asMembers(fed.trust) });
        emit({ kind: 'director', tone: 'info', text: `${sample.name} is running on its own, with its trust anchor at ${sample.url}. Add it in the Hall of Registries (Town Hall).` });
      }
      if (add && !federations.list().some((f) => f.anchor.entity_id === sample.anchor.entity_id)) {
        const f = await federations.addByUrl(sample.url);
        announceFederation(f, `The town added ${f.name}`);
        visitor(f);
      }
      return { ok: true, text: `${sample.name}: trust anchor at ${sample.url}`, url: sample.url };
    },
    swarm() {
      if (swarmRunning) return { ok: false, text: 'The swarm is already loose.' };
      swarmRunning = true;
      emit({ kind: 'director', tone: 'warn', text: 'Something stirs at the Old Mill…' });
      sim.swarm().catch((err) => emit({ kind: 'info', tone: 'warn', text: `The swarm stumbled: ${err.message}` })).finally(() => {
        swarmRunning = false;
      });
      return { ok: true, text: 'A rogue swarm is leaving the Old Mill.' };
    },
    outage({ seconds = 45 } = {}) {
      if (!world.regA) return { ok: false, text: 'No registry to take down.' };
      places.outage.until = Date.now() + seconds * 1000;
      emit({ kind: 'director', tone: 'warn', text: `${world.regA.name} can't be reached from the shops for ${seconds} seconds (a network partition). Places will defer, not refuse.` });
      setTimeout(() => emit({ kind: 'director', tone: 'info', text: `${world.regA.name} is reachable again` }), seconds * 1000);
      return { ok: true, text: `${world.regA.name} is unreachable for ${seconds} seconds.` };
    },
    newcomer: () => sim.newcomer(),
    residents({ on }) {
      sim.setResidentsActive(Boolean(on));
      return { ok: true, text: on ? 'Residents are out and about.' : 'Residents are staying in.' };
    },
    policy({ place, patch }) {
      const res = places.setPolicy(place, patch ?? {});
      emit({ kind: 'policy', place: res.place, placeId: place, tone: 'info', text: `${res.place} now asks for: ${res.policy}` });
      return { ok: true, text: `${res.place}: ${res.policy}` };
    },
    /** The law for one jurisdiction: a regime on or off. */
    law({ jurisdiction = 'us', regime, on = true }) {
      if (!REGIMES[regime]) return { ok: false, text: `No regime ${regime}.` };
      const res = places.setLaw(jurisdiction, regime, Boolean(on));
      sessions.announce(null, `The council ${on ? 'switched on' : 'repealed'} ${REGIMES[regime].name} in ${res.jurisdiction}`, res.changed);
      return { ok: true, text: `${REGIMES[regime].name} ${on ? 'in force' : 'repealed'}: ${res.changed.length} places changed`, changed: res.changed };
    },
    /** Every place (but those run by a person playing) trusts a federation, or stops trusting it. */
    trust({ key, on = true }) {
      const f = federations.get(key);
      if (!f) return { ok: false, text: `No federation ${key}.` };
      const changed = [];
      for (const id of Object.keys(PLACE_DEFS)) {
        const pl = places.places[id];
        if (pl.human) continue;
        const now = pl.policy.anchors ?? federations.list().map((x) => x.key);
        const next = on ? [...new Set([...now, key])] : now.filter((k) => k !== key);
        if (next.length !== now.length) {
          places.setPolicy(id, { anchors: next });
          changed.push(pl.name);
        }
      }
      emit({ kind: 'policy', tone: 'info', text: `${changed.length} place${changed.length === 1 ? ' now' : 's now'} ${on ? 'trust' : 'no longer trust'} ${f.name}${changed.length ? `: ${changed.join(', ')}` : ''}. Registries and badges unchanged.` });
      return { ok: true, text: `${changed.length} places changed`, changed };
    },
    /** How much of town is on the framework: one place, or a preset for all. */
    adoption({ place, mode, preset }) {
      if (preset) {
        const res = places.presetAdoption(preset);
        sessions.announce(null, `The town is now "${res.preset}"`, res.changed);
        return { ok: true, text: `${res.preset}: ${res.changed.length} places changed`, changed: res.changed };
      }
      if (places.places[place]?.human) return { ok: false, text: `${places.places[place].name} is run by a person playing; it's their call.` };
      const res = places.setAdoption(place, mode);
      emit({ kind: 'policy', place: res.place, placeId: place, tone: 'info', text: `${res.place}: ${ADOPTION[res.adoption].label}${res.mandated ? ' (required by law)' : ''}` });
      return { ok: true, text: `${res.place}: ${ADOPTION[res.adoption].label}` };
    },
  };

  function directorState() {
    return {
      outage_until: places.outage.until > Date.now() ? places.outage.until : null,
      residents: sim.residentsActive,
      swarm: swarmRunning,
      registries: world.registries.map((r) => ({ id: r.id, name: r.name })),
      places: Object.keys(PLACE_DEFS).map((id) => {
        const pl = places.places[id];
        return {
          id, name: pl.name, keeper: pl.human?.name ?? null, accepts: pl.policy.accepts, aaf: pl.policy.aaf, worldid: Boolean(pl.policy.worldid), x402: pl.policy.x402,
          adoption: pl.adoption, effective: places.adoptionOf(pl), jurisdiction: pl.jurisdiction, sector: pl.sector, summary: places.describePolicy(pl), people: pl.policy.people, anchors: pl.policy.anchors,
        };
      }),
      adoptions: Object.entries(ADOPTION).map(([id, a]) => ({ id, ...a })),
      peoples: Object.entries(PEOPLE).map(([id, a]) => ({ id, ...a })),
      law: sessions.lawView(),
      federations: federations.list().map(federationView),
      sample: sample ? { name: sample.name, url: sample.url } : null,
    };
  }

  const npcOptions = () => [
    ...sim.snapshot().filter((n) => n.status !== 'gone').map((n) => ({ value: n.id, label: n.name, hint: n.kind })),
    ...sessions.people().filter((x) => x.role === 'agent').map((x) => ({ value: x.id, label: x.name, hint: 'an agent (a person playing)' })),
  ];

  return {
    world, places, sim, sessions, justice, ledger, keys, npcOptions, federations,
    federationsView: () => federations.list().map(federationView),
    /** A federation's trust-anchor bootstrap: what a service or party is configured with to join or trust it. */
    bootstrap(key) {
      const f = federations.get(key);
      if (!f) throw new HttpError(404, 'unknown_federation', `No federation ${key}. Try ${federations.list().map((x) => x.key).join(', ')}.`);
      const sig = f.anchor.jwks.keys.find((k) => k.use !== 'enc');
      return { name: f.name, entity_id: f.anchor.entity_id, url: f.anchor.url, jwks: f.anchor.jwks, thumbprint: thumbprint(sig) };
    },
    /** The town's identity verifier and court, as members another federation would list to accept them. */
    authorities: () => asMembers(fed.trust),
    /** Add a whole federation by its trust anchor's address (and, to be sure of its key, a thumbprint to pin). */
    async addFederation({ url, pin }) {
      const f = await federations.addByUrl(url, { pin: pin || null });
      announceFederation(f, `The town added ${f.name}, by its trust anchor at ${f.anchor.url}`);
      visitor(f);
      return { ...federationView(f), thumbprint: f.thumbprint, pinned: f.pinned };
    },
    /**
     * Admit one registry or record keeper into the participants' federation: read what it says about itself at its
     * address, or take its entity statement as given (for a service that must be a member before it can start).
     */
    /** The check at the door, for a service by its address, or by its entity id once the town knows where it's served. */
    async check({ url, entity_id: id }) {
      const entry = id ? world.trust.registry(id) ?? world.trust.recordKeeper(id) : null;
      if (id && !entry?.url) throw new HttpError(404, 'unknown', `The town doesn't know where ${id} is served.`);
      return checkService(entry?.url ?? url, { anchors: federations.list().map((f) => f.anchor.entity_id), registryKeys: (r) => world.trust.registry(r)?.jwks ?? null });
    },
    async admit({ url, statement }) {
      const read = statement ? { member: statement, name: statement.metadata?.organization_name ?? statement.entity_id, type: statement.entity_type, hints: [] } : await readEntity(url);
      if (federations.of(read.member.entity_id)) throw new HttpError(409, 'known', `${read.name} is already a member of a federation the town knows.`);
      participants.admit(read.member);
      await federations.refresh('participants');
      const f = federations.get('participants');
      announceFederation(f, `AgentTown Participants admitted ${read.name} (${read.type === 'aaf_registry' ? 'a registry' : 'a record keeper'})`);
      // Admitted by address, it's running: check it at the door now. Admitted by statement, check it once it starts.
      const check = statement ? null : await this.check({ url: read.member.metadata.endpoint_base });
      return { name: read.name, type: read.type, entity_id: read.member.entity_id, names_this_anchor: read.hints.includes(participants.entityId), check, federation: federationView(f) };
    },
    info: () => ({
      federation: fed.kind, trust_anchor: fed.trustAnchorUrl, federations: federations.list().map((f) => ({ key: f.key, name: f.name, kind: f.kind, url: f.anchor.url })),
      registries: world.registries.map((r) => ({ id: r.id, name: r.name, url: r.url })),
      record_keepers: world.trust.recordKeepers.map((r) => ({ id: r.id, name: r.name, url: r.url, roles: r.roles })),
      identity_verifier: world.kyc?.id ?? null, court: world.court?.name ?? null,
    }),
    actions(s) {
      return sessions.actions(s, npcOptions()).map((a) => ({ ...a, params: a.params?.map((pm) => (pm.options === 'npcs' ? { ...pm, options: npcOptions() } : pm)) }));
    },
    world_(since = 0, s = null) {
      return {
        now: Date.now(), seq: ledger.seq, npcs: sim.snapshot(), people: sessions.people().filter((x) => x.id !== s?.id && x.owner !== s?.id), me: sessions.me(s),
        events: sessions.visibleEvents(s, ledger.items.filter((e) => e.seq > since && (!e.private || e.owner === s?.id)).slice(since ? 0 : -80, since ? 200 : undefined)), director: directorState(), market: places.market(),
      };
    },
    async direct(event, params = {}) {
      const cue = director[event];
      if (!cue) throw new HttpError(404, 'unknown_cue', `no director cue ${event}`);
      return cue(params);
    },
    async close() {
      clearInterval(refresher);
      sessions.stop();
      sim.stop();
      await world.close();
      await sample?.close();
      await participants.close();
      await fed.close();
    },
  };
}
