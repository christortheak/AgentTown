// Police and courts. Places and people file cases with the police; the police
// petition the court; the court's orders run on the framework:
//   identify  the registry resolves a badge (PPID) to its principal, its chain,
//             and the other badges the same principal showed at that place
//   delete    the registry's operator revokes the chain's top registration under
//             legal order; the revocation cascades to every sub-agent
//   ban       the identity verifier withdraws the principal's verification:
//             every agent registered under it is suspended at once, new
//             registrations are refused, and the verifier won't verify that
//             identity again (someone can still come back under another name,
//             which real identity checks, with documents and liveness, would catch)
// When nobody is playing the police or the judge, a simulated inspector and a
// simulated judge do the job, so the town keeps itself in order during a demo.
import { randomId } from 'aaf-reference/src/lib/crypto.js';
import { postJson, HttpError } from 'aaf-reference/src/lib/http.js';

const MERGE_MS = 120000;
const MISCONDUCT = new Set(['pump', 'break-in']);

export function createJustice({ world, emit, people = () => ({ police: 0, judge: 0 }), timeScale = 1 }) {
  const cases = [];
  const petitions = [];
  const bans = new Map(); // "legal name|jurisdiction" -> case id
  const banKey = (identity) => `${identity.legal_name}|${identity.jurisdiction}`.toLowerCase();
  const later = (ms, fn) => setTimeout(() => fn().catch((err) => emit({ kind: 'justice', tone: 'warn', text: `The court stumbled: ${err.message}` })), ms / timeScale);

  /** Open a case, or add to an open one of the same kind at the same place. */
  function fileCase({ kind, placeId, title, evidence, by = 'the town', owner = null }) {
    const now = Date.now();
    const fresh = evidence.filter((e) => e.ppid);
    let c = cases.find((x) => x.kind === kind && x.placeId === placeId && x.status === 'open' && now - x.updated < MERGE_MS && kind !== 'complaint');
    if (c) {
      for (const e of fresh) if (!c.evidence.some((x) => x.ppid === e.ppid)) c.evidence.push(e);
      c.updated = now;
      return c;
    }
    c = { id: randomId('case', 5), kind, placeId, title, by, owner, evidence: fresh, status: 'open', opened: now, updated: now, findings: null, outcome: [] };
    cases.push(c);
    emit({ kind: 'justice', placeId: 'police', place: 'Police Station', tone: 'warn', owner, text: `Police opened case ${c.id}: ${title} (${fresh.length} badge${fresh.length === 1 ? '' : 's'} as evidence; filed by ${by})` });
    if (!people().police) later(4000, () => inspect(c));
    return c;
  }

  function petition(caseId, kind, by = 'Inspector Holt (simulated)', owner = null) {
    const c = cases.find((x) => x.id === caseId);
    if (!c) throw new HttpError(404, 'no_case', 'No such case.');
    if (!['identify', 'delete', 'ban'].includes(kind)) throw new HttpError(400, 'bad_petition', 'The court can identify, delete or ban.');
    if (kind !== 'identify' && !c.findings) throw new HttpError(409, 'identify_first', 'The court needs to know who stands behind the badge first: ask it to identify.');
    if (petitions.some((p) => p.case === caseId && p.kind === kind && p.status === 'pending')) throw new HttpError(409, 'already_pending', 'That petition is already before the court.');
    const p = { id: randomId('pet', 5), case: caseId, kind, by, owner, status: 'pending', filed: Date.now() };
    petitions.push(p);
    const what = { identify: 'identify who stands behind', delete: 'delete the agents behind', ban: 'ban the principal behind' }[kind];
    emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'info', owner, text: `${by} petitioned the court to ${what} case ${caseId}` });
    if (!people().judge) later(3000, () => rule(p.id, { grant: true, by: 'Judge Rowan (simulated)' }));
    return p;
  }

  async function rule(petitionId, { grant, by = 'the judge', owner = null }) {
    const p = petitions.find((x) => x.id === petitionId);
    if (!p || p.status !== 'pending') throw new HttpError(409, 'not_pending', 'That petition is not pending.');
    const c = cases.find((x) => x.id === p.case);
    p.ruled_by = by;
    if (!grant) {
      p.status = 'denied';
      emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'info', owner, text: `${by} denied the petition to ${p.kind} in case ${c.id}` });
      return p;
    }
    try {
      if (!world.court) throw new HttpError(409, 'no_court', 'This town operates no court (no resolution authority keys).');
      if (p.kind === 'identify') await identify(c, by);
      else if (p.kind === 'delete') await remove(c, by);
      else await ban(c, by);
    } catch (err) {
      p.status = 'failed';
      p.error = err.message;
      emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'warn', owner, text: `The order to ${p.kind} in case ${c.id} could not be carried out: ${err.message}` });
      throw err;
    }
    p.status = 'granted';
    return p;
  }

  /**
   * One order covering every badge in the case. Each is resolved on its own and
   * grouped by principal, so a bystander who happened to be in the same place
   * at the same time is told apart from whoever ran the scheme.
   */
  async function identify(c, judge) {
    if (!c.evidence.length) throw new HttpError(409, 'no_badge', 'There is no badge in this case to identify.');
    const order = world.court.order({ caseId: c.id, ppids: c.evidence.map((e) => e.ppid), relyingParty: c.evidence[0].rp, requester: 'AgentTown police', scope: ['root_principal_identity', 'chain', 'related_ppids'] });
    const byPrincipal = new Map();
    for (const e of c.evidence) {
      const registry = world.trust.registry(e.registry) ?? world.regA;
      const ord = e.rp === c.evidence[0].rp ? order : world.court.order({ caseId: c.id, ppids: [e.ppid], relyingParty: e.rp, requester: 'AgentTown police', scope: ['root_principal_identity', 'chain', 'related_ppids'] });
      const { result } = await world.court.resolve(registry, { order: ord, ppid: e.ppid, sealedRef: e.sealed_ref ?? undefined });
      const root = result.root_principal;
      const p = byPrincipal.get(root.principal_id) ?? {
        id: root.principal_id, type: root.type, identity: root.identity, registry: root.registry, assurance: root.verification?.assurance_level, badges: 0, tops: new Map(), chain: null, related: 0,
      };
      p.badges++;
      const top = result.chain.at(-1);
      p.tops.set(top.registration_id, { label: top.label, status: top.status, registration_id: top.registration_id, registry: top.registry });
      p.chain ??= result.chain.map((x) => ({ label: x.label, status: x.status, registration_id: x.registration_id, registry: x.registry }));
      p.related = Math.max(p.related, result.related_ppids?.length ?? 0);
      byPrincipal.set(root.principal_id, p);
    }
    const principals = [...byPrincipal.values()].sort((a, b) => b.badges - a.badges);
    const main = principals[0];
    c.findings = {
      principal: { id: main.id, type: main.type, identity: main.identity, registry: main.registry, assurance: main.assurance },
      chain: main.chain, tops: [...main.tops.values()], related: main.related, linked: main.badges,
      others: principals.slice(1).map((p) => ({ name: p.identity.legal_name, type: p.type, badges: p.badges })),
    };
    c.status = 'identified';
    c.outcome.push(`identified by order of ${judge}`);
    const others = c.findings.others.length ? ` The rest belong to ${c.findings.others.map((o) => `${o.name} (${o.badges})`).join(', ')}: not the same principal.` : '';
    emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'ok', reveal: true, text: `By order of ${judge}, the registry identified case ${c.id}: ${main.badges} of ${c.evidence.length} badge(s) belong to ${main.identity.legal_name} (${main.type.replace('_', ' ')}).${others}` });
    if (!people().police) later(3000, () => inspect(c));
  }

  async function remove(c, judge) {
    let cascaded = 0;
    const done = [];
    if (!(c.findings.tops ?? []).some((t) => t.status === 'active')) throw new HttpError(409, 'already_revoked', 'Those agents are already revoked.');
    for (const top of (c.findings.tops ?? [c.findings.chain.at(-1)]).filter((t) => t.status === 'active')) {
      const registry = world.trust.registry(top.registry);
      const token = world.adminToken(registry?.id);
      if (!token) throw new HttpError(409, 'no_operator', `This town can't instruct ${registry?.name ?? 'that registry'}'s operator (no operator token).`);
      const res = await postJson(`${registry.url}/admin/registrations/${top.registration_id}/revoke`, { reason: 'legal_order' }, { authorization: `Bearer ${token}` });
      top.status = 'revoked';
      cascaded += res.cascades_to ?? 0;
      done.push(top.label);
    }
    c.status = 'agents deleted';
    c.outcome.push(`agents deleted by order of ${judge}`);
    emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'ok', text: `By order of ${judge}, the registry revoked ${done.join(', ')} under legal order; ${cascaded} sub-agent(s) went with ${done.length === 1 ? 'it' : 'them'}` });
  }

  async function ban(c, judge) {
    const p = c.findings.principal;
    if (!world.kyc) throw new HttpError(409, 'no_verifier', 'This town operates no identity verifier, so it cannot withdraw a verification.');
    const registry = world.trust.registry(p.registry);
    await world.kyc.verify({ id: p.id, registry, type: p.type, identity: p.identity }, { assurance: p.assurance ?? (p.type === 'legal_person' ? 'high' : 'IAL2'), method: `verification withdrawn by court order (case ${c.id})`, validForDays: -1 });
    bans.set(banKey(p.identity), c.id);
    c.status = 'principal banned';
    c.outcome.push(`principal banned by order of ${judge}`);
    emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'ok', reveal: true, text: `By order of ${judge}, VerityCheck withdrew ${p.identity.legal_name}'s verification. Every agent registered under it is suspended at once, and that identity can't be verified again` });
  }

  /** The simulated inspector: identify first; then delete; ban a principal behind several cases or a scheme. */
  async function inspect(c) {
    if (people().police) return;
    if (!c.findings) {
      if (!petitions.some((p) => p.case === c.id && p.kind === 'identify')) petition(c.id, 'identify');
      return;
    }
    // A refused payment or a complaint is grounds to identify, not to punish. Misconduct is a
    // market pump or a break-in attempt, and only the principal behind the pattern answers for
    // it, never a lone bystander: two of its badges in one case, or two misconduct cases.
    if (!MISCONDUCT.has(c.kind)) return;
    const misconduct = cases.filter((x) => MISCONDUCT.has(x.kind) && x.findings?.principal.id === c.findings.principal.id);
    const serious = c.findings.linked >= 2 || misconduct.length >= 2;
    if (serious && !petitions.some((p) => p.case === c.id && p.kind === 'delete') && (c.findings.tops ?? []).some((t) => t.status === 'active')) petition(c.id, 'delete');
    // A principal behind a coordinated scheme (three or more of its badges in one case), or behind repeated misconduct, is banned.
    const scheme = c.findings.linked >= 3;
    if ((misconduct.length >= 2 || scheme) && !bans.has(banKey(c.findings.principal.identity)) && !petitions.some((p) => p.case === c.id && p.kind === 'ban')) {
      later(2500, async () => {
        if (c.findings && !bans.has(banKey(c.findings.principal.identity))) petition(c.id, 'ban');
      });
    }
  }

  return {
    fileCase, petition, rule,
    isBanned: (identity) => bans.get(banKey(identity)) ?? null,
    cases: () => cases.slice(-40),
    petitions: () => petitions.slice(-40),
    caseById: (id) => cases.find((x) => x.id === id) ?? null,
  };
}
