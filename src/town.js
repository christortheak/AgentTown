// AgentTown on the server: the federation (local or external), the places and
// their policies, the simulated inhabitants, the people playing, police and
// courts, the town ledger, and the director's cues for live demos and videos.
import { loadConfig, connectFederation } from './federation.js';
import { buildWorld } from './world.js';
import { createPlaces, PLACE_DEFS, ADOPTION } from './places.js';
import { REGIMES } from './rulebook.js';
import { createSim } from './sim.js';
import { createSessions } from './sessions.js';
import { createJustice } from './justice.js';
import { createWorldId } from './worldid.js';
import { createX402 } from './x402.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';

export async function createTown({ origin, portOffset = 7000, config = loadConfig(), residents = true, timeScale = 1 }) {
  const fed = await connectFederation({ federation: config.federation, portOffset });
  const world = buildWorld({ trust: fed.trust, keysDir: fed.keysDir, adminTokens: fed.adminTokens });

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
  const places = await createPlaces({
    world, origin, config: config.places, law: config.law, worldid, x402, emit,
    alert: (a) => justice.fileCase({ kind: a.kind, placeId: a.placeId, title: a.title, evidence: a.evidence, by: PLACE_DEFS[a.placeId]?.name ?? 'Hearth & Key' }),
  });
  const keys = {};
  places.resetHomes(keys);
  const sim = createSim({ world, places, emit, worldid, x402, origin, keys, timeScale });
  sessions = createSessions({ world, places, sim, worldid, x402, emit, keys, justice, ledger, origin });
  if (residents) await sim.start();
  emit({ kind: 'director', tone: 'info', text: `AgentTown is open. Federation: ${fed.kind} (${world.registries.map((r) => r.name).join(', ')})` });

  let swarmRunning = false;
  const director = {
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
          adoption: pl.adoption, effective: places.adoptionOf(pl), jurisdiction: pl.jurisdiction, sector: pl.sector, summary: places.describePolicy(pl),
        };
      }),
      adoptions: Object.entries(ADOPTION).map(([id, a]) => ({ id, ...a })),
      law: sessions.lawView(),
    };
  }

  const npcOptions = () => [
    ...sim.snapshot().filter((n) => n.status !== 'gone').map((n) => ({ value: n.id, label: n.name, hint: n.kind })),
    ...sessions.people().filter((x) => x.role === 'agent').map((x) => ({ value: x.id, label: x.name, hint: 'an agent (a person playing)' })),
  ];

  return {
    world, places, sim, sessions, justice, ledger, keys,
    info: () => ({
      federation: fed.kind, trust_anchor: fed.trustAnchorUrl,
      registries: world.registries.map((r) => ({ id: r.id, name: r.name, url: r.url })),
      record_keepers: world.trust.recordKeepers.map((r) => ({ id: r.id, name: r.name, url: r.url, roles: r.roles })),
      identity_verifier: world.kyc?.id ?? null, court: world.court?.name ?? null,
    }),
    actions(s) {
      return sessions.actions(s, npcOptions()).map((a) => ({ ...a, params: a.params?.map((pm) => (pm.options === 'npcs' ? { ...pm, options: npcOptions() } : pm)) }));
    },
    world_(since = 0, s = null) {
      return {
        now: Date.now(), seq: ledger.seq, npcs: sim.snapshot(), people: sessions.people().filter((x) => x.id !== s?.id),
        events: sessions.visibleEvents(s, ledger.items.filter((e) => e.seq > since && (!e.private || e.owner === s?.id)).slice(-80)), director: directorState(), market: places.market(),
      };
    },
    async direct(event, params = {}) {
      const cue = director[event];
      if (!cue) throw new HttpError(404, 'unknown_cue', `no director cue ${event}`);
      return cue(params);
    },
    async close() {
      sessions.stop();
      sim.stop();
      await world.close();
      await fed.close();
    },
  };
}
