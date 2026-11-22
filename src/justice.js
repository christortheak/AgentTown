// Police and courts. Places and people file cases with the police, and residents
// can bring one to the court themselves; the police petition the court; a judge
// rules; the court's orders run on the framework:
//   identify  the directory traces each ID in the case to its principal, its chain,
//             and the other IDs the same principal showed at that place. Only the
//             people in the case learn the name: whoever brought it, the police and
//             the judge. The town hears that the court traced it, not who.
//   delete    a judgment: the directory's operator revokes the chain's top
//             registration under legal order; the revocation cascades to every sub-agent
//   ban       a judgment, for repeated misconduct: the identity verifier withdraws the principal's verification:
//             every agent registered under it is suspended at once, new
//             registrations are refused, and the verifier won't verify that
//             identity again (someone can still come back under another name,
//             which real identity checks, with documents and liveness, would catch)
// A court acts on harm: a place's report (a likely pump, a break-in attempt, a
// suspicious payment, a rush of new badges at the regatta) or a break-in at your own
// door. A badge someone merely checked is no grounds. Only what the law forbids earns a
// judgment (public/laws.js): buying regatta seats over the ferry's limit breaks its
// rules, so the court has the extra seats cancelled; reselling them breaks the Harbor's
// law. Judgments are public and name whoever the court
// ruled against, except that in the Harbor (EU rules) a published judgment leaves
// out an individual's name, as many EU courts do. Companies are named on both sides.
// When nobody is playing the police or the judge, a simulated inspector and a
// simulated judge do the job, so the town keeps itself in order during a demo. The
// simulated judge grants only what the grounds support, and says why when it won't.
import { randomId } from 'aaf-reference/src/lib/crypto.js';
import { postJson, HttpError } from 'aaf-reference/src/lib/http.js';
import { PLACE_DEFS } from './places.js';

const MERGE_MS = 120000;
/** Harm a court can act on, by kind of case: the grounds for finding out who. */
export const HARM = {
  pump: 'a likely pump at the Thistle Exchange',
  'break-in': 'attempts to get into a home with a copied key',
  sar: 'a suspicious payment the bank refused',
  scalping: 'a rush of new badges buying up the Lantern Regatta, perhaps one person getting around its limit',
  resale: 'Lantern Regatta seats resold at a markup, bought by getting around the limit',
};
/** What a judgment says the principal answers for. */
const JUDGED = {
  pump: 'pushing up a price at the Thistle Exchange with many agents',
  'break-in': 'trying a copied key on someone’s door',
  resale: 'reselling Lantern Regatta seats bought by getting around the limit of two per person',
};
/** Harm the law forbids, so it can earn a judgment, not just an order to find out who. Regatta seats only once resold. */
const MISCONDUCT = new Set(['pump', 'break-in', 'scalping']);
const criminal = (c) => MISCONDUCT.has(c.kind) && (c.kind !== 'scalping' || c.resold);
const SIM_JUDGE = 'Judge Rowan (simulated)';
/** How many cases the police and the court keep on file; a case rarely has more than three petitions. */
export const CASES_KEPT = 300;
const PETITIONS_PER_CASE = 3;
const NO_HARM = 'No harm on record. A court makes a directory name someone only when there is harm to answer for: a place’s report, or someone trying your door. Checking a badge, or not liking a visit, is not enough.';

/** remedies: what a court can have a place do besides trace and judge (cancelTickets(aaf_ids): the ferry's extra seats). */
export function createJustice({ world, emit, people = () => ({ police: 0, judge: 0 }), timeScale = 1, casesKept = CASES_KEPT, remedies = {} }) {
  const cases = [];
  const petitions = [];
  const bans = new Map(); // "legal name|jurisdiction" -> case id
  const banKey = (identity) => `${identity.legal_name}|${identity.jurisdiction}`.toLowerCase();
  const later = (ms, fn) => setTimeout(() => fn().catch((err) => emit({ kind: 'justice', tone: 'warn', text: `The court stumbled: ${err.message}` })), ms / timeScale);
  const pending = (c) => petitions.some((p) => p.case === c.id && p.status === 'pending');
  const onFile = (c) => cases.includes(c);
  const directoryOf = (c) => world.trust?.directory(c.evidence[0]?.directory)?.name ?? 'the directory';

  /**
   * Old files go: the oldest cases, with their petitions, so no petition points at a case that's gone. A case
   * with a petition still before the court stays until it's ruled on, and so does the case just filed. Petitions
   * filed again and again in one case go oldest first, once ruled on.
   */
  function tidy() {
    for (let i = 0; cases.length > casesKept && i < cases.length - 1;) {
      if (pending(cases[i])) i++;
      else {
        const [gone] = cases.splice(i, 1);
        for (let j = petitions.length - 1; j >= 0; j--) if (petitions[j].case === gone.id) petitions.splice(j, 1);
      }
    }
    for (let i = 0; petitions.length > casesKept * PETITIONS_PER_CASE && i < petitions.length;) {
      if (petitions[i].status === 'pending') i++;
      else petitions.splice(i, 1);
    }
  }

  /**
   * Open a case, or add to an open one of the same kind at the same place.
   *   grounds       for a resident's own case (kind 'suit'): the harm it is about, if any (a HARM key)
   *   jurisdiction  where the harm happened ('us' or 'eu'); by default, the place's
   *   publicTitle, publicBy  what the town hears, when the title or the filer names a person
   */
  function fileCase({ kind, placeId, title, evidence, by = 'the town', owner = null, grounds = null, jurisdiction = null, publicTitle = null, publicBy = null, resold = false }) {
    const now = Date.now();
    const fresh = evidence.filter((e) => e.aaf_id);
    const own = kind === 'complaint' || kind === 'suit';
    // Seats resold go with the regatta case they came from (one with a badge in common), whatever the court has done
    // with it so far; never with someone else's.
    const shares = (x) => x.evidence.some((e) => fresh.some((f) => f.aaf_id === e.aaf_id));
    let c = own ? null : cases.find((x) => x.kind === kind && x.placeId === placeId && now - x.updated < MERGE_MS && (resold ? x.status !== 'agents deleted' && shares(x) : x.status === 'open'));
    if (c) {
      for (const e of fresh) if (!c.evidence.some((x) => x.aaf_id === e.aaf_id)) c.evidence.push(e);
      c.updated = now;
      if (resold && !c.resold) {
        Object.assign(c, { resold: true, harm: HARM.resale });
        if (c.findings && !people().police) later(3000, () => inspect(c));
      }
      return c;
    }
    c = {
      id: randomId('case', 5), kind, grounds, placeId, title, by, owner, evidence: fresh, status: 'open', opened: now, updated: now, findings: null, outcome: [],
      jurisdiction: jurisdiction ?? PLACE_DEFS[placeId]?.jurisdiction ?? 'us',
    };
    c.harm = resold ? HARM.resale : HARM[kind] ?? HARM[grounds] ?? null;
    c.resold = resold;
    cases.push(c);
    tidy();
    const office = kind === 'suit' ? { placeId: 'court', place: 'Courthouse', who: 'The court' } : { placeId: 'police', place: 'Police Station', who: 'Police' };
    emit({ kind: 'justice', placeId: office.placeId, place: office.place, tone: 'warn', owner, text: `${office.who} opened case ${c.id}: ${publicTitle ?? title} (${fresh.length} badge${fresh.length === 1 ? '' : 's'} as evidence; filed by ${publicBy ?? by})` });
    if (!people().police) later(4000, () => inspect(c));
    return c;
  }

  /**
   * Ask the court for an order. With nobody playing the judge, the simulated judge rules a moment later, unless
   * the caller rules at once (ruleLater: false). publicBy is who the town hears asked, when that's a resident.
   */
  function petition(caseId, kind, by = 'Inspector Holt (simulated)', owner = null, { ruleLater = true, publicBy = null } = {}) {
    const c = cases.find((x) => x.id === caseId);
    if (!c) throw new HttpError(404, 'no_case', 'No such case.');
    if (!['identify', 'delete', 'ban'].includes(kind)) throw new HttpError(400, 'bad_petition', 'The court can identify, delete or ban.');
    if (kind !== 'identify' && !c.findings) throw new HttpError(409, 'identify_first', 'The court needs to know who stands behind the badge first: ask it to identify.');
    if (petitions.some((p) => p.case === caseId && p.kind === kind && p.status === 'pending')) throw new HttpError(409, 'already_pending', 'That petition is already before the court.');
    const p = { id: randomId('pet', 5), case: caseId, kind, by, owner, status: 'pending', filed: Date.now(), harm: c.harm };
    petitions.push(p);
    tidy();
    const what = { identify: 'identify who stands behind', delete: 'delete the agents behind', ban: 'ban the principal behind' }[kind];
    emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'info', owner, text: `${publicBy ?? by} petitioned the court to ${what} case ${caseId}` });
    if (!people().judge && ruleLater) later(3000, () => rule(p.id, { ...ruling(c, kind), by: SIM_JUDGE }));
    return p;
  }

  /**
   * A resident takes an ID to court: a case of their own, a petition to identify, and a ruling: at once from the
   * simulated judge, or later from the person playing the judge.
   */
  async function bring({ title, about, evidence, grounds = null, by, owner, jurisdiction = 'us' }) {
    const c = fileCase({ kind: 'suit', grounds, placeId: 'court', title, publicTitle: `a resident’s case about ${about}`, evidence, by, publicBy: 'a resident', owner, jurisdiction });
    const p = petition(c.id, 'identify', by, owner, { ruleLater: false, publicBy: 'A resident' });
    if (!people().judge) await rule(p.id, { ...ruling(c, 'identify'), by: SIM_JUDGE });
    return { case: c, petition: p };
  }

  /** What the grounds warrant beyond finding out who: deleting the agents, banning the principal. */
  function warrants(c) {
    if (!c.findings || !criminal(c)) return { delete: false, ban: false };
    // Only the principal behind the pattern answers for it, never a lone bystander: two of its badges in one case,
    // or misconduct in two cases. A ban is for a principal who does it again.
    const misconduct = cases.filter((x) => criminal(x) && x.findings?.principal.id === c.findings.principal.id);
    return { delete: c.findings.linked >= 2 || misconduct.length >= 2, ban: misconduct.length >= 2 };
  }

  /** How the simulated judge rules: { grant, reason }. */
  function ruling(c, kind) {
    if (!c.harm) return { grant: false, reason: NO_HARM };
    if (kind === 'identify') return { grant: true, reason: `Grounds: ${c.harm}.` };
    const w = warrants(c);
    if (kind === 'delete') {
      return w.delete
        ? { grant: true, reason: `Grounds: ${c.harm}, by one principal’s agents.` }
        : c.kind === 'scalping' && !c.resold
          ? { grant: false, reason: 'Buying over the ferry’s limit breaks its rules, not the Harbor’s law. The court has the extra seats cancelled; it doesn’t shut anyone down for it.' }
          : { grant: false, reason: 'Finding out who is one thing; shutting agents down needs a pattern: two of one principal’s badges in the case, or misconduct in two cases.' };
    }
    return w.ban
      ? { grant: true, reason: `Grounds: ${c.harm}, and misconduct in another case before it.` }
      : { grant: false, reason: 'A ban is for repeated misconduct: a second case against the same principal.' };
  }

  async function rule(petitionId, { grant, by = 'the judge', owner = null, reason = null }) {
    const p = petitions.find((x) => x.id === petitionId);
    if (!p || p.status !== 'pending') throw new HttpError(409, 'not_pending', 'That petition is not pending.');
    const c = cases.find((x) => x.id === p.case);
    p.ruled_by = by;
    p.reason = reason;
    if (!grant) {
      p.status = 'denied';
      emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'info', owner, text: `${by} denied the petition to ${p.kind} in case ${c.id}${reason ? `: ${reason.split('.')[0].toLowerCase()}` : ''}` });
      if (c.owner && c.owner !== owner) emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'info', owner: c.owner, private: true, text: `The court won't trace the ID in your case ${c.id}. ${reason ?? ''}`.trim() });
      return p;
    }
    try {
      if (!world.court) throw new HttpError(409, 'no_court', 'This town operates no court (no attribution authority keys).');
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
    const order = world.court.order({ caseId: c.id, aaf_ids: c.evidence.map((e) => e.aaf_id), counterparty: c.evidence[0].counterparty, requester: 'AgentTown police', scope: ['principal_identity', 'chain', 'related_ids'] });
    const byPrincipal = new Map();
    for (const e of c.evidence) {
      const directory = world.trust.directory(e.directory) ?? world.dirA;
      const ord = e.counterparty === c.evidence[0].counterparty ? order : world.court.order({ caseId: c.id, aaf_ids: [e.aaf_id], counterparty: e.counterparty, requester: 'AgentTown police', scope: ['principal_identity', 'chain', 'related_ids'] });
      const { result } = await world.court.trace(directory, { order: ord, aaf_id: e.aaf_id, sealedRef: e.sealed_ref ?? undefined });
      const root = result.principal;
      const p = byPrincipal.get(root.principal_id) ?? {
        id: root.principal_id, type: root.type, identity: root.identity, directory: root.directory, assurance: root.verification?.assurance_level, badges: 0, tops: new Map(), chain: null, related: 0, tickets: 0, aaf_ids: [],
      };
      p.badges++;
      p.tickets += e.tickets ?? 1;
      p.aaf_ids.push(e.aaf_id);
      const top = result.chain.at(-1);
      const t = p.tops.get(top.registration_id) ?? { label: top.label, status: top.status, registration_id: top.registration_id, directory: top.directory, badges: [] };
      // The badges under this top, for a directory the town can only send an order to (see remove).
      t.badges.push({ aaf_id: e.aaf_id, sealed_ref: e.sealed_ref ?? null, counterparty: e.counterparty, directory: directory.id, mine: result.chain[0]?.registration_id === top.registration_id });
      p.tops.set(top.registration_id, t);
      p.chain ??= result.chain.map((x) => ({ label: x.label, status: x.status, registration_id: x.registration_id, directory: x.directory }));
      p.related = Math.max(p.related, result.related_ids?.length ?? 0);
      byPrincipal.set(root.principal_id, p);
    }
    const principals = [...byPrincipal.values()].sort((a, b) => b.badges - a.badges);
    const main = principals[0];
    c.findings = {
      principal: { id: main.id, type: main.type, identity: main.identity, directory: main.directory, assurance: main.assurance },
      chain: main.chain, tops: [...main.tops.values()], related: main.related, linked: main.badges, tickets: main.tickets, aaf_ids: main.aaf_ids,
      others: principals.slice(1).map((p) => ({ name: p.identity.legal_name, type: p.type, badges: p.badges })),
    };
    c.status = 'identified';
    c.outcome.push(`identified by order of ${judge}`);
    // The town hears that the court traced the IDs, not who: that stays with the people in the case.
    const kind = main.type === 'legal_person' ? 'a company' : 'an individual';
    const rest = c.evidence.length - main.badges;
    const others = rest ? `; the other ${rest} to someone else` : '';
    emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'ok', text: `By order of ${judge}, ${directoryOf(c)} traced the IDs in case ${c.id}: ${main.badges} of ${c.evidence.length} lead to one principal, ${kind}${others}. Only the people in the case learn who` });
    if (c.owner) emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'ok', owner: c.owner, private: true, text: `The court traced the ID in your case ${c.id}: ${main.identity.legal_name} (${main.type.replace('_', ' ')}, ${main.identity.jurisdiction}) stands behind it. Only you, the police and the judge know` });
    if (c.kind === 'scalping') settle(c, judge);
    if (!people().police) later(3000, () => inspect(c));
  }

  /**
   * The regatta's seats, once the court knows who bought them. Within the limit, nobody did anything wrong. Over it,
   * the ferry cancels the extra seats: a breach of its rules, settled without a judgment or a name. Reselling them is
   * what the Harbor's law forbids, and goes on to a judgment (warrants).
   */
  function settle(c, judge) {
    const f = c.findings;
    const limit = ['none', 'one', 'two', 'three', 'four'][PLACE_DEFS.ferry.perPerson] ?? PLACE_DEFS.ferry.perPerson;
    if (f.tickets <= PLACE_DEFS.ferry.perPerson) {
      c.status = 'closed: within the limit';
      emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'ok', text: `Case ${c.id} is closed: no one principal bought more than ${limit} Lantern Regatta seats. Buying through several agents is no wrong in itself` });
      return;
    }
    const cancelled = remedies.cancelTickets?.(f.aaf_ids) ?? 0;
    c.status = c.resold ? 'identified' : 'seats cancelled';
    c.outcome.push(`${cancelled} seat${cancelled === 1 ? '' : 's'} cancelled by order of ${judge}`);
    emit({ kind: 'justice', placeId: 'ferry', place: 'Gull Ferry', tone: 'ok', text: `By order of ${judge}, Gull Ferry cancelled ${cancelled} Lantern Regatta seat${cancelled === 1 ? '' : 's'} that one principal’s agents bought over the limit of ${limit} per person; they’re on sale again.${c.resold ? '' : ' That breaks the ferry’s rules, not the Harbor’s law, so there’s no judgment and no name.'}` });
  }

  /** Who a published judgment names: everyone in the town (US rules); in the Harbor (EU rules), companies but not individuals. */
  function published(c) {
    const p = c.findings.principal;
    if (c.jurisdiction === 'eu' && p.type === 'natural_person') {
      return { name: 'an individual', whose: 'an individual’s', note: ' In the Harbor, as in much of the EU, a published judgment leaves out an individual’s name.' };
    }
    return { name: p.identity.legal_name, whose: `${p.identity.legal_name}'s`, note: '' };
  }

  /**
   * Delete the agents behind a case. At a directory this town operates, the operator revokes the top of each chain
   * under the court's order, and every sub-agent goes with it: the paper's directory shutting down copies by revoking
   * the original agent. Any other directory gets the order itself (POST /v1/revocations), which reaches only the agent
   * behind each badge in the case, not the agents above it (docs/PROPOSED.md, §7).
   */
  async function remove(c, judge) {
    let cascaded = 0;
    const done = [];
    const short = [];
    if (!(c.findings.tops ?? []).some((t) => t.status === 'active')) throw new HttpError(409, 'already_revoked', 'Those agents are already revoked.');
    for (const top of (c.findings.tops ?? [c.findings.chain.at(-1)]).filter((t) => t.status === 'active')) {
      const directory = world.trust.directory(top.directory);
      if (!directory) throw new HttpError(409, 'unknown_directory', 'The court can’t reach the directory those agents are registered at.');
      const token = world.adminToken(directory.id);
      if (token) {
        const res = await postJson(`${directory.url}/admin/registrations/${top.registration_id}/revoke`, { reason: 'legal_order' }, { authorization: `Bearer ${token}` });
        top.status = 'revoked';
        cascaded += res.cascades_to ?? 0;
        done.push(top.label);
        continue;
      }
      const ended = [];
      for (const b of top.badges ?? []) {
        const order = world.court.order({ caseId: c.id, aaf_ids: [b.aaf_id], counterparty: b.counterparty, requester: 'AgentTown police', scope: ['revoke_registration'] });
        const res = await world.court.revoke(directory, { order, aaf_id: b.aaf_id, sealedRef: b.sealed_ref ?? undefined });
        if (res.already) continue;
        ended.push(res.registration_id);
        cascaded += res.cascades_to ?? 0;
        if (res.registration_id === top.registration_id) top.status = 'revoked';
      }
      if (!ended.length) throw new HttpError(409, 'already_revoked', 'The agents behind those badges are already revoked.');
      done.push(top.status === 'revoked' ? top.label : `${ended.length} agent${ended.length === 1 ? '' : 's'} under ${top.label}`);
      if (top.status !== 'revoked') short.push(`${top.label}, above them, is still registered: an order names a badge, and ends only the agent behind it`);
    }
    c.status = 'agents deleted';
    c.outcome.push(`agents deleted by order of ${judge}`);
    const { name, note } = published(c);
    emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'ok', reveal: true, text: `Judgment in case ${c.id}, by ${judge}: ${name} answers for ${JUDGED[c.resold ? 'resale' : c.kind] ?? c.harm ?? 'the harm in this case'}. The directory revoked ${done.join(', ')} under legal order${cascaded ? `; ${cascaded} sub-agent(s) went with ${done.length === 1 ? 'it' : 'them'}` : ''}${short.length ? `. ${short.join('. ')}` : ''}.${note}` });
  }

  async function ban(c, judge) {
    const p = c.findings.principal;
    if (!world.kyc) throw new HttpError(409, 'no_verifier', 'This town operates no identity verifier, so it cannot withdraw a verification.');
    const directory = world.trust.directory(p.directory);
    await world.kyc.verify({ id: p.id, directory, type: p.type, identity: p.identity }, { assurance: p.assurance ?? (p.type === 'legal_person' ? 'high' : 'IAL2'), method: `verification withdrawn by court order (case ${c.id})`, validForDays: -1 });
    bans.set(banKey(p.identity), c.id);
    c.status = 'principal banned';
    c.outcome.push(`principal banned by order of ${judge}`);
    const { whose, note } = published(c);
    emit({ kind: 'justice', placeId: 'court', place: 'Courthouse', tone: 'ok', reveal: true, text: `Judgment in case ${c.id}, by ${judge}: VerityCheck withdrew ${whose} verification. Every agent registered under it is suspended at once, and that identity can't be verified again.${note}` });
  }

  /** The simulated inspector: identify first; then delete; ban a principal who does it again. */
  async function inspect(c) {
    if (people().police || !onFile(c)) return;
    if (!c.findings) {
      // A case with no harm in it goes no further: the judge would only say no.
      if (c.harm && !petitions.some((p) => p.case === c.id && p.kind === 'identify')) petition(c.id, 'identify');
      return;
    }
    const w = warrants(c);
    if (w.delete && !petitions.some((p) => p.case === c.id && p.kind === 'delete') && (c.findings.tops ?? []).some((t) => t.status === 'active')) petition(c.id, 'delete');
    if (w.ban && !bans.has(banKey(c.findings.principal.identity)) && !petitions.some((p) => p.case === c.id && p.kind === 'ban')) {
      later(2500, async () => {
        if (onFile(c) && c.findings && !bans.has(banKey(c.findings.principal.identity))) petition(c.id, 'ban');
      });
    }
  }

  return {
    fileCase, petition, rule, bring,
    isBanned: (identity) => bans.get(banKey(identity)) ?? null,
    cases: (n = 40) => cases.slice(-n),
    petitions: (n = 40) => petitions.slice(-n),
    caseById: (id) => cases.find((x) => x.id === id) ?? null,
  };
}
