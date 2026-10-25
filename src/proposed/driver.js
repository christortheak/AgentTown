// PROPOSED EXTENSION, prototyped in AgentTown (see docs/PROPOSED.md).
//
// The seam between a place's question and an agent implementation. A place
// asks in a neutral form (src/places.js builds it: the framework's credential
// claims in DCQL form, plus the proposed items below). An agent's software
// answers each item from its principal's record:
//   yes     the record allows it for this place
//   ask     the record says to ask the principal (a passkey on their phone)
//   won't   the record says never, for this place
//   can't   this software doesn't support that kind of question, or there is
//           nothing on file to answer with
// "Can't" is kept apart from "won't": an implementation that can't answer is
// not refusing, just as a missing badge is not proof of a rogue agent.
import { digestOf } from 'aaf-reference/src/lib/crypto.js';
import { allowanceRequest } from './keeper.js';

/** Agent software a principal can choose when registering an agent. */
export const SOFTWARE = {
  pocket: {
    name: 'Pocket Agent 2.3', maker: 'Pocket Agents Co.', blurb: 'Answers every kind of question the town asks',
    can: ['identity', 'attribute', 'provenance', 'allowance', 'statement', 'worldid'],
  },
  tinybot: {
    name: 'Tinybot 0.9', maker: 'Tinybot Labs', blurb: 'Badge, permission and your name; nothing else yet',
    can: ['identity'],
  },
};

const RULE = { identity: 'name', attribute: 'age_over_18', provenance: 'bill_of_materials', statement: 'facts', worldid: 'world_id' };
const VERB = { identity: 'show your name', attribute: 'show proof of age', provenance: 'show its bill of materials', statement: 'state facts from your record', worldid: 'use your World ID', allowance: 'check your spending limits' };

/**
 * Answer each item of a place's ask.
 *   ask    { placeId, place, want: [{ kind, name?, label }] }
 *   ctx    { software, record, holds: { attributes: [names], provenance: bool, worldId: bool }, once: [kinds approved this once] }
 * Returns { items: [{ ...item, answer, why }], overall } where overall is the
 * strongest: can't, then won't, then ask, then yes.
 */
export function answerAsk(ask, { software = 'pocket', record, holds = {}, once = [] }) {
  const sw = SOFTWARE[software] ?? SOFTWARE.pocket;
  const items = ask.want.filter((w) => !w.shared).map((w) => {
    if (!sw.can.includes(w.kind)) return { ...w, answer: "can't", why: `${sw.name} can't ${VERB[w.kind] ?? 'answer that'}` };
    if (w.kind === 'allowance') return { ...w, answer: 'yes', why: 'checked with the Records Office for each purchase' };
    if (!record) return { ...w, answer: "can't", why: 'there is no record at the Records Office to answer from' };
    if (w.kind === 'attribute' && !holds.attributes?.includes(w.name)) return { ...w, answer: "can't", why: `nothing verified on file for "${w.label}"` };
    if (w.kind === 'provenance' && !holds.provenance) return { ...w, answer: "can't", why: 'this agent has no bill of materials on file' };
    if (w.kind === 'worldid' && !holds.worldId) return { ...w, answer: "can't", why: 'you have no World ID' };
    if (w.kind === 'statement' && !(w.name in (record.facts ?? {}))) return { ...w, answer: "can't", why: `there is nothing called "${w.label}" on your record` };
    if (once.includes(w.kind)) return { ...w, answer: 'yes', why: 'you approved it on your phone, this once' };
    const rule = record.sharing?.[RULE[w.kind]] ?? { always: [], otherwise: 'ask' };
    if (rule.always.includes(ask.placeId)) return { ...w, answer: 'yes', why: `your record shares ${w.label} with ${ask.place}` };
    if (rule.otherwise === 'never') return { ...w, answer: "won't", why: `your record says never to share ${w.label}` };
    return { ...w, answer: 'ask', why: `your record says to ask you before sharing ${w.label}` };
  });
  const rank = { "can't": 3, "won't": 2, ask: 1, yes: 0 };
  const overall = items.reduce((best, i) => (rank[i.answer] > rank[best] ? i.answer : best), 'yes');
  return { items, overall, software: sw.name };
}

/**
 * Fetch from the Records Office what a question needs: an allowance for this
 * exact request, and a statement of the facts asked for. Returns
 * { allowance?, jti?, statement? }, or { refused } when the record says no.
 */
export function fetchExtras({ keeper, principalId, agent, place, aud, action, params, want, approval = null }) {
  const out = {};
  if (want.some((w) => w.kind === 'allowance' && !w.shared)) {
    const res = keeper.allowance(allowanceRequest(agent, {
      principal: principalId, aud, place, action, amount: params.amount?.value ?? 0, category: params.category ?? null, params_digest: digestOf(params), ...(approval ? { approval } : {}),
    }));
    if (!res.covered) return { refused: res };
    Object.assign(out, { allowance: res.allowance, jti: res.jti, approved: res.approved });
  }
  const names = want.filter((w) => w.kind === 'statement' && !w.shared).map((w) => w.name);
  if (names.length) out.statement = keeper.statement(principalId, { aud, names });
  return out;
}
