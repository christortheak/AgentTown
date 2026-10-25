// The town's view of a federation: its registries and record keepers, the
// identity verifier and court the town operates (when it holds their keys),
// and helpers for making principals, agents and relying parties. Like
// aaf-reference's simulation world, but it names no service in advance, so it
// works against an external federation as well as the local one.
import fs from 'node:fs';
import path from 'node:path';
import { loadKeys, fileNameFor } from 'aaf-reference/src/lib/trust.js';
import { getJson } from 'aaf-reference/src/lib/http.js';
import { verifyJws } from 'aaf-reference/src/lib/crypto.js';
import { buildPresentationRequest } from 'aaf-reference/src/lib/presentation.js';
import { verifyReceipt } from 'aaf-reference/src/lib/log.js';
import { Principal } from 'aaf-reference/src/actors/principal.js';
import { Agent } from 'aaf-reference/src/actors/agent.js';
import { AgentProvider, IdentityVerifier, ResolutionAuthority } from 'aaf-reference/src/actors/authorities.js';
import { startRelyingParty } from 'aaf-reference/src/rp/server.js';

const hasKeys = (keysDir, id) => Boolean(keysDir && fs.existsSync(path.join(keysDir, `${fileNameFor(id)}.json`)));
const prefer = (list, hint) => list.find((e) => e.id.includes(hint)) ?? null;

export function buildWorld({ trust, keysDir, adminTokens = {}, federations = null }) {
  const registries = trust.registries;
  if (!registries.length) throw new Error('the federation has no registries');
  const regA = prefer(registries, 'registry-a') ?? registries[0];
  const regB = prefer(registries, 'registry-b') ?? registries.find((r) => r.id !== regA.id) ?? null;
  const rkFor = (role) => trust.recordKeepers.find((rk) => rk.roles?.includes(role)) ?? null;
  const authRk = rkFor('authorization');
  const provRk = rkFor('provenance');
  const activityRk = rkFor('activity');
  const verifierEntry = (trust.doc.verifiers ?? []).find((v) => hasKeys(keysDir, v.id));
  const courtEntry = (trust.doc.resolution_authorities ?? []).filter((a) => hasKeys(keysDir, a.id)).sort((a, b) => Number(b.id.includes('court')) - Number(a.id.includes('court')))[0];
  const relyingParties = [];

  const world = {
    trust,
    federations,
    registries,
    regA,
    regB,
    authRk,
    provRk,
    activityRk,
    kyc: verifierEntry ? new IdentityVerifier({ id: verifierEntry.id, keys: loadKeys(verifierEntry.id, keysDir) }) : null,
    court: courtEntry ? new ResolutionAuthority({ id: courtEntry.id, name: courtEntry.name, keys: loadKeys(courtEntry.id, keysDir) }) : null,
    registryName: (id) => trust.registry(id)?.name ?? id,

    /**
     * A registry's own record keepers: the ones in its federation for each role. An agent registered in another
     * federation keeps its grant there, since the town's record keepers can't check its badge (one anchor each).
     */
    keeperFor(registryId, role) {
      const f = federations?.of(registryId);
      if (!f || f.kind === 'town') return { authorization: authRk, provenance: provRk, activity: activityRk }[role] ?? null;
      return f.view.recordKeepers.find((rk) => rk.roles?.includes(role)) ?? null;
    },
    recordsFor(registryId, provenanceId) {
      const rk = (role) => world.keeperFor(registryId, role);
      return [
        ...(rk('authorization') ? [{ role: 'authorization', rk: rk('authorization').id }] : []),
        ...(provenanceId && rk('provenance') ? [{ role: 'provenance', rk: rk('provenance').id, ref: provenanceId }] : []),
        ...(rk('activity') ? [{ role: 'activity', rk: rk('activity').id }] : []),
      ];
    },

    /** The operator token for a registry, if this town may instruct its operator (court orders). */
    adminToken: (id) => adminTokens[id] ?? (id && hasKeys(keysDir, id) ? loadKeys(id, keysDir).adminToken : null),

    /** Record pointers for a registration: authorization and provenance, and activity. */
    records(provenanceId) {
      return [
        ...(authRk ? [{ role: 'authorization', rk: authRk.id }] : []),
        ...(provenanceId && provRk ? [{ role: 'provenance', rk: provRk.id, ref: provenanceId }] : []),
        ...(activityRk ? [{ role: 'activity', rk: activityRk.id }] : []),
      ];
    },

    /** Enroll a principal (identity claims only; not yet verified). */
    async enrolledPrincipal({ type, identity, registry = regA, contact }) {
      const p = new Principal({ type, identity, registry, trust, contact });
      await p.enroll();
      return p;
    },

    /** Have the town's identity verifier verify an enrolled principal (simulated KYC). */
    async verify(principal, { assurance, method, attributes = [], validForDays }) {
      if (!world.kyc) throw new Error('this town operates no identity verifier, so it cannot verify anyone');
      principal.verification = await world.kyc.verify(principal, { assurance, method, attributes, ...(validForDays !== undefined ? { validForDays } : {}) });
      return principal.verification;
    },

    async verifiedPrincipal({ assurance, method, ...opts }) {
      const p = await world.enrolledPrincipal(opts);
      await world.verify(p, { assurance, method });
      return p;
    },

    agent: (name) => new Agent({ name, trust }),
    provider: (name, contact) => new AgentProvider({ name, contact }),

    async relyingParty(opts) {
      const rp = await startRelyingParty({ trust, ...opts });
      relyingParties.push(rp);
      return rp;
    },

    async close() {
      await Promise.all(relyingParties.map((rp) => rp.close()));
    },

    verifyReceipt(receipt, entry) {
      const op = trust.recordKeeper(receipt.log_id) ?? trust.registry(receipt.log_id);
      return op ? verifyReceipt(receipt, trust.signingKey(op), entry ? { entry } : {}) : { ok: false, reason: 'unknown log' };
    },

    /** A request without the agent SDK: no presentation, or with extra headers. */
    async rawRequest(rpUrl, action, params = {}, headers = {}) {
      const res = await fetch(`${rpUrl}/actions/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(params) });
      return { httpStatus: res.status, ...(await res.json()) };
    },

    /** A presentation built by hand (forged, replayed or shown to the wrong place). */
    async handBuiltRequest({ rp, action, params = {}, accountability, authorization, proofKey }) {
      const url = `${rp.url}/actions/${action}`;
      const { body, headers } = buildPresentationRequest({ url, rpId: rp.id, params, accountability, authorization, key: proofKey });
      const res = await fetch(url, { method: 'POST', headers, body });
      return { httpStatus: res.status, ...(await res.json()) };
    },

    async registrySth(registry) {
      const { sth } = await getJson(`${registry.url}/v1/transparency/sth`);
      return verifyJws(sth, trust.signingKey(registry), { typ: 'aaf-sth+jwt' }).payload;
    },
  };
  return world;
}
