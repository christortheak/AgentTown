// The town's view of a federation: its directories and records services, the
// identity verifier and court the town operates (when it holds their keys),
// and helpers for making principals, agents and counterparties. Like
// aaf-reference's simulation world, but it names no service in advance, so it
// works against an external federation as well as the local one.
import fs from 'node:fs';
import path from 'node:path';
import { loadKeys, fileNameFor } from 'aaf-reference/src/lib/trust.js';
import { getJson, postJson } from 'aaf-reference/src/lib/http.js';
import { identityKey } from 'aaf-reference/src/directory/directory.js';
import { verifyJws } from 'aaf-reference/src/lib/crypto.js';
import { buildPresentationRequest } from 'aaf-reference/src/lib/presentation.js';
import { verifyReceipt } from 'aaf-reference/src/lib/log.js';
import { Principal } from 'aaf-reference/src/actors/principal.js';
import { Agent } from 'aaf-reference/src/actors/agent.js';
import { AgentProvider, IdentityVerifier, DesignatedAuthority } from 'aaf-reference/src/actors/authorities.js';
import { startCounterparty } from 'aaf-reference/src/counterparty/server.js';

const hasKeys = (keysDir, id) => Boolean(keysDir && fs.existsSync(path.join(keysDir, `${fileNameFor(id)}.json`)));
const prefer = (list, hint) => list.find((e) => e.id.includes(hint)) ?? null;

/** How many of its latest decisions each place keeps in memory. */
export const DECISIONS_KEPT = 200;
const keepLast = (list, n) => {
  if (list.length > n) list.splice(0, list.length - n);
};

/** One of the town's own agents. Its requests carry the town's mark, so a place's front can tell it from an agent that came with its own badge. */
class TownAgent extends Agent {
  constructor(opts, mark) {
    super(opts);
    this.mark = mark;
  }

  act(counterpartyUrl, action, params = {}, opts = {}) {
    return super.act(counterpartyUrl, action, params, { ...opts, headers: { ...this.mark, ...opts.headers } });
  }
}

/**
 * front: the places' front doors (src/front.js); each counterparty is reached there, and the town's own requests are marked.
 * decisionsKept: how many of its latest decisions each place keeps (see counterparty).
 */
export function buildWorld({ trust, keysDir, adminTokens = {}, federations = null, front = null, decisionsKept = DECISIONS_KEPT }) {
  const mark = front?.mark ?? {};
  const directories = trust.directories;
  if (!directories.length) throw new Error('the federation has no directories');
  const dirA = prefer(directories, 'directory-a') ?? directories[0];
  const dirB = prefer(directories, 'directory-b') ?? directories.find((r) => r.id !== dirA.id) ?? null;
  const rsFor = (role) => trust.recordsServices.find((rs) => rs.roles?.includes(role)) ?? null;
  const authRs = rsFor('authorization');
  const provRs = rsFor('provenance');
  const activityRs = rsFor('activity');
  const verifierEntry = (trust.doc.verifiers ?? []).find((v) => hasKeys(keysDir, v.id));
  const courtEntry = (trust.doc.designated_authorities ?? []).filter((a) => hasKeys(keysDir, a.id)).sort((a, b) => Number(b.id.includes('court')) - Number(a.id.includes('court')))[0];
  const counterparties = [];
  const cast = new Map(); // directory | verified identity -> the town character's principal (see verifiedPrincipal)

  const world = {
    trust,
    federations,
    directories,
    dirA,
    dirB,
    authRs,
    provRs,
    activityRs,
    kyc: verifierEntry ? new IdentityVerifier({ id: verifierEntry.id, keys: loadKeys(verifierEntry.id, keysDir) }) : null,
    court: courtEntry ? new DesignatedAuthority({ id: courtEntry.id, name: courtEntry.name, keys: loadKeys(courtEntry.id, keysDir) }) : null,
    directoryName: (id) => trust.directory(id)?.name ?? id,

    /**
     * A directory's own records services: the ones in its federation for each role. An agent registered in another
     * federation keeps its grant there, since the town's records services can't check its badge (one anchor each).
     */
    recordsServiceFor(directoryId, role) {
      const f = federations?.of(directoryId);
      if (!f || f.kind === 'town') return { authorization: authRs, provenance: provRs, activity: activityRs }[role] ?? null;
      return f.view.recordsServices.find((rs) => rs.roles?.includes(role)) ?? null;
    },
    recordsFor(directoryId, provenanceId) {
      const rs = (role) => world.recordsServiceFor(directoryId, role);
      return [
        ...(rs('authorization') ? [{ role: 'authorization', rs: rs('authorization').id }] : []),
        ...(provenanceId && rs('provenance') ? [{ role: 'provenance', rs: rs('provenance').id, ref: provenanceId }] : []),
        ...(rs('activity') ? [{ role: 'activity', rs: rs('activity').id }] : []),
      ];
    },

    /** The operator token for a directory, if this town may instruct its operator (court orders). */
    adminToken: (id) => adminTokens[id] ?? (id && hasKeys(keysDir, id) ? loadKeys(id, keysDir).adminToken : null),

    /** Record pointers for a registration: authorization and provenance, and activity. */
    records(provenanceId) {
      return [
        ...(authRs ? [{ role: 'authorization', rs: authRs.id }] : []),
        ...(provenanceId && provRs ? [{ role: 'provenance', rs: provRs.id, ref: provenanceId }] : []),
        ...(activityRs ? [{ role: 'activity', rs: activityRs.id }] : []),
      ];
    },

    /** Enroll a principal (identity claims only; not yet verified). */
    async enrolledPrincipal({ type, identity, directory = dirA, contact }) {
      const p = new Principal({ type, identity, directory, trust, contact });
      await p.enroll();
      return p;
    },

    /** Have the town's identity verifier verify an enrolled principal (simulated KYC). */
    async verify(principal, { assurance, method, attributes = [], validForDays }) {
      if (!world.kyc) throw new Error('this town operates no identity verifier, so it cannot verify anyone');
      principal.verification = await world.kyc.verify(principal, { assurance, method, attributes, ...(validForDays !== undefined ? { validForDays } : {}) });
      return principal.verification;
    },

    /**
     * One of the town's own characters (a resident, the night's visitors, the swarm's owner), verified. A directory
     * keeps one principal record per verified identity (the paper's PV-3), so a character who turns up again, or for
     * a second player, is the same principal, with the record it already has.
     */
    verifiedPrincipal({ assurance, method, ...opts }) {
      const key = `${(opts.directory ?? dirA).id}|${identityKey(opts.type, opts.identity)}`;
      if (!cast.has(key)) {
        const made = world.enrolledPrincipal(opts).then(async (p) => {
          await world.verify(p, { assurance, method });
          return p;
        });
        cast.set(key, made.catch((err) => {
          cast.delete(key);
          throw err;
        }));
      }
      return cast.get(key);
    },

    /**
     * Close a principal record, the operator's procedure for an identity that will enroll again (its agents stop;
     * their history stays). Only at a directory this town operates; elsewhere it does nothing.
     */
    async closePrincipal(principal, reason = 'left town') {
      const token = principal?.id ? world.adminToken(principal.directory?.id) : null;
      if (!token) return null;
      return postJson(`${principal.directory.url}/admin/principals/${principal.id}/close`, { reason }, { authorization: `Bearer ${token}` });
    },

    agent: (name) => new TownAgent({ name, trust }, mark),
    provider: (name, contact) => new AgentProvider({ name, contact }),

    /**
     * A place's counterparty, behind the front at /<the first label of its id>. `visitor` handles agents the town didn't make.
     * The framework's counterparty keeps every decision it makes (counterparty.evidence, counterparty.received). The town only reads the
     * one it just got back, which is always the newest, and the place's signed account of each decision is in the
     * agent's activity log already, so a place keeps its latest few and lets the rest go.
     */
    async counterparty({ visitor = null, onDecision, ...opts }) {
      const counterparty = await startCounterparty({
        trust, ...opts,
        onDecision: (d) => {
          keepLast(d.counterparty.evidence, decisionsKept);
          keepLast(d.counterparty.received, decisionsKept);
          return onDecision?.(d);
        },
      });
      if (front) front.mount(opts.id.split('.')[0], counterparty, visitor);
      counterparties.push(counterparty);
      return counterparty;
    },

    async close() {
      await Promise.all(counterparties.map((counterparty) => counterparty.close()));
    },

    verifyReceipt(receipt, entry) {
      const op = trust.recordsService(receipt.log_id) ?? trust.directory(receipt.log_id);
      return op ? verifyReceipt(receipt, trust.signingKey(op), entry ? { entry } : {}) : { ok: false, reason: 'unknown log' };
    },

    /** A request without the agent SDK: no presentation, or with extra headers. */
    async rawRequest(counterpartyUrl, action, params = {}, headers = {}) {
      const res = await fetch(`${counterpartyUrl}/actions/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...mark, ...headers }, body: JSON.stringify(params) });
      return { httpStatus: res.status, ...(await res.json()) };
    },

    /** A presentation built by hand (forged, replayed or shown to the wrong place). */
    async handBuiltRequest({ counterparty, action, params = {}, accountability, authorization, proofKey }) {
      const url = `${counterparty.url}/actions/${action}`;
      const { body, headers } = buildPresentationRequest({ url, counterpartyId: counterparty.id, params, accountability, authorization, key: proofKey });
      const res = await fetch(url, { method: 'POST', headers: { ...headers, ...mark }, body });
      return { httpStatus: res.status, ...(await res.json()) };
    },

    async directorySth(directory) {
      const { sth } = await getJson(`${directory.url}/v1/transparency/sth`);
      return verifyJws(sth, trust.signingKey(directory), { typ: 'aaf-sth+jwt' }).payload;
    },
  };
  return world;
}
