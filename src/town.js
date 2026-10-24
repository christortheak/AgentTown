// AgentTown on the server: the federation (local or external), the places and
// their policies, the inhabitants, the player, the town ledger, and the
// director's cues for live demos and videos.
import { loadConfig, connectFederation } from './federation.js';
import { buildWorld } from './world.js';
import { createPlaces, PLACE_DEFS } from './places.js';
import { createSim } from './sim.js';
import { createPlayer } from './player.js';
import { createWorldId } from './worldid.js';
import { createX402 } from './x402.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';

export async function createTown({ origin, portOffset = 7000, config = loadConfig(), residents = true, timeScale = 1 }) {
  const fed = await connectFederation({ federation: config.federation, portOffset });
  const world = buildWorld({ trust: fed.trust, keysDir: fed.keysDir });

  // The town ledger: everything anyone did, newest last.
  const ledger = { seq: 0, items: [] };
  const emit = (e) => {
    const item = { ...e, seq: ++ledger.seq, at: Date.now() };
    ledger.items.push(item);
    if (ledger.items.length > 400) ledger.items.shift();
    return item;
  };

  const worldid = createWorldId();
  const x402 = createX402();
  const places = await createPlaces({ world, origin, config: config.places, worldid, x402, emit });
  const keys = {};
  places.resetHomes(keys);
  const sim = createSim({ world, places, emit, worldid, x402, origin, keys, timeScale });
  const player = createPlayer({ world, places, sim, worldid, x402, emit, keys });
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
  };

  function directorState() {
    return {
      outage_until: places.outage.until > Date.now() ? places.outage.until : null,
      residents: sim.residentsActive,
      swarm: swarmRunning,
      registries: world.registries.map((r) => ({ id: r.id, name: r.name })),
      places: Object.keys(PLACE_DEFS).map((id) => {
        const pl = places.places[id];
        return { id, name: pl.name, accepts: pl.policy.accepts, aaf: pl.policy.aaf, worldid: Boolean(pl.policy.worldid), x402: pl.policy.x402, summary: places.describePolicy(pl) };
      }),
    };
  }

  return {
    world, places, sim, player, ledger, keys,
    info: () => ({
      federation: fed.kind, trust_anchor: fed.trustAnchorUrl,
      registries: world.registries.map((r) => ({ id: r.id, name: r.name, url: r.url })),
      record_keepers: world.trust.recordKeepers.map((r) => ({ id: r.id, name: r.name, url: r.url, roles: r.roles })),
      identity_verifier: world.kyc?.id ?? null, court: world.court?.name ?? null,
    }),
    actions() {
      const npcs = sim.snapshot().filter((n) => n.status !== 'gone').map((n) => ({ value: n.id, label: n.name, hint: n.kind }));
      return player.catalog().map((a) => ({ ...a, params: a.params?.map((pm) => (pm.options === 'npcs' ? { ...pm, options: npcs } : pm)) }));
    },
    world_(since = 0) {
      return { now: Date.now(), seq: ledger.seq, npcs: sim.snapshot(), events: ledger.items.filter((e) => e.seq > since).slice(-60), director: directorState() };
    },
    async direct(event, params = {}) {
      const cue = director[event];
      if (!cue) throw new HttpError(404, 'unknown_cue', `no director cue ${event}`);
      return cue(params);
    },
    reset() {
      player.reset();
      places.resetHomes(keys, ['you']);
      return { ok: true };
    },
    async close() {
      sim.stop();
      await world.close();
      await fed.close();
    },
  };
}
