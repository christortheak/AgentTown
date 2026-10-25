// PROPOSED EXTENSION to the Reference Profile, prototyped in AgentTown.
// Nothing here is part of aaf-reference; see docs/PROPOSED.md.
//
// The principal's record at the authorization record keeper (in town, the
// Records Office). The framework's grant says what an agent may do in one
// request; the record says the rest, and is extensible:
//   spending  per purchase, per day in total, purchases per day, kinds of
//             purchase, and above what amount the principal wants to approve
//             each purchase with a passkey
//   sharing   for each thing a place may ask about, which places always get
//             it, and otherwise whether to ask the principal or never share
//   facts     anything else the principal wants on file (a loyalty card, a
//             dietary need), which an agent may state, labelled as unverified
//   agents    which agents (by key thumbprint) may ask on the principal's behalf
//
// The record is signed by the principal and every version goes into the
// keeper's Merkle log. The keeper also:
//   - holds the passkey on the principal's phone, for approvals;
//   - answers allowance requests ("is this purchase within the record?") with a
//     signed yes bound to one place and one exact request. It never states the
//     remaining balance: the same figure seen at two places would link them.
//     Every request, allowed or not, goes into the principal's register;
//   - signs statements of facts on file, for one place.
// What the keeper learns: which places, and how much. That is the cost of
// limits no single place can enforce.
import { generateSigningKey, signJws, verifyJws, decodeJws, digestOf, randomId, thumbprint, publicOf, nowSeconds } from 'aaf-reference/src/lib/crypto.js';
import { MerkleLog } from 'aaf-reference/src/lib/log.js';
import { createAccounts } from 'aaf-reference/src/rp/accounts.js';
import { HttpError } from 'aaf-reference/src/lib/http.js';

export const TYP = { record: 'aaf-principal-record+jwt', allowance: 'aaf-allowance+jwt', statement: 'aaf-statement+jwt', request: 'aaf-allowance-request+jwt' };
export const CATEGORIES = ['books', 'home', 'food', 'health', 'garden'];
export const SHARABLE = {
  name: 'your name',
  age_over_18: 'proof you are over 18',
  bill_of_materials: "your agent's bill of materials",
  world_id: 'your World ID',
  facts: 'other facts on your record',
};
const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWANCE_SECONDS = 120;

export function defaultRecord({ perPurchase = 50 } = {}) {
  return {
    spending: { per_purchase: perPurchase, per_day: perPurchase * 3, purchases_per_day: 8, categories: ['books', 'home', 'food', 'health'], approve_above: null },
    sharing: {
      name: { always: [], otherwise: 'ask' },
      age_over_18: { always: [], otherwise: 'ask' },
      bill_of_materials: { always: [], otherwise: 'ask' },
      world_id: { always: [], otherwise: 'never' },
      facts: { always: [], otherwise: 'ask' },
    },
    facts: {},
    agents: [],
  };
}

const money = (n) => Math.round(Number(n) * 100) / 100;
const positive = (n) => (n === null || n === undefined || n === '' ? null : Math.max(0, money(n)));

/** Bring a record from the editor into shape; anything unknown in `facts` is kept, as text. */
export function normalizeRecord(r, base = defaultRecord()) {
  const s = r?.spending ?? {};
  const out = {
    spending: {
      per_purchase: positive(s.per_purchase) ?? base.spending.per_purchase,
      per_day: positive(s.per_day),
      purchases_per_day: s.purchases_per_day === null || s.purchases_per_day === '' || s.purchases_per_day === undefined ? null : Math.max(0, Math.floor(Number(s.purchases_per_day))),
      categories: (s.categories ?? base.spending.categories).filter((c) => CATEGORIES.includes(c)),
      approve_above: positive(s.approve_above),
    },
    sharing: {},
    facts: {},
    agents: [...new Set(r?.agents ?? base.agents)],
  };
  for (const k of Object.keys(SHARABLE)) {
    const rule = r?.sharing?.[k] ?? base.sharing[k];
    out.sharing[k] = { always: [...new Set(rule?.always ?? [])].map(String), otherwise: rule?.otherwise === 'never' ? 'never' : 'ask' };
  }
  for (const [k, v] of Object.entries(r?.facts ?? {})) {
    const key = String(k).trim().toLowerCase().replace(/[^a-z0-9_ ]/g, '').replace(/\s+/g, '_').slice(0, 30);
    if (key && v !== '' && v !== null && v !== undefined) out.facts[key] = String(v).slice(0, 80);
  }
  return out;
}

export function createKeeper({ id = 'https://records-office.agenttown.test', name = 'Records Office', rpId, origin }) {
  const key = generateSigningKey();
  const log = new MerkleLog({ logId: id, signer: key });
  const phone = createAccounts({ rpId, origin, name: `${name}: your phone` });
  const principals = new Map(); // principal id -> { jwk, versions, record, attempts }
  const usedJti = new Set(); // allowances and statements already relied on, by any place

  const mustPrincipal = (pid) => {
    const p = principals.get(pid);
    if (!p) throw new HttpError(404, 'no_record', 'There is no record for this principal at the Records Office.');
    return p;
  };

  /** Today's spending: allowances granted and not given back, over the last 24 hours. */
  function today(p) {
    const since = Date.now() - DAY_MS;
    const live = p.attempts.filter((a) => a.at > since && a.outcome === 'covered');
    return { spent: money(live.reduce((n, a) => n + a.amount, 0)), purchases: live.length };
  }

  const keeper = {
    id, name, phone,
    publicJwk: publicOf(key.publicJwk),

    /** A principal signs a new version of their record. The first one fixes the principal's key here. */
    setRecord(pid, jws) {
      const { header } = decodeJws(jws);
      const known = principals.get(pid);
      const jwk = known?.jwk ?? header.jwk;
      if (!jwk) throw new HttpError(400, 'no_key', "the first record must carry the principal's public key");
      let payload;
      try {
        ({ payload } = verifyJws(jws, jwk, { typ: TYP.record }));
      } catch (err) {
        throw new HttpError(403, 'bad_signature', `the record is not signed by this principal: ${err.message}`);
      }
      if (payload.principal !== pid) throw new HttpError(403, 'wrong_principal', 'the record names a different principal');
      const record = normalizeRecord(payload.record);
      const p = known ?? { jwk, versions: [], attempts: [] };
      const digest = digestOf(record);
      const { index } = log.append({ type: 'record', principal: pid, version: p.versions.length + 1, digest, at: new Date().toISOString() });
      p.versions.push({ jws, digest, index, at: Date.now() });
      p.record = record;
      principals.set(pid, p);
      return { version: p.versions.length, receipt: log.receipt(index) };
    },

    record: (pid) => principals.get(pid)?.record ?? null,
    version: (pid) => principals.get(pid)?.versions.length ?? 0,

    /**
     * An agent asks whether one purchase is within its principal's record. The
     * request is signed by the agent's long-term key, which the record lists.
     *   payload: { principal, aud, place, action, amount, category, params_digest, approval? }
     * Returns { covered: true, allowance } or { covered: false, outcome, reason, needs? }.
     */
    allowance(jws) {
      const { header, payload } = decodeJws(jws);
      const p = mustPrincipal(payload.principal);
      if (!header.jwk || !p.record.agents.includes(thumbprint(header.jwk))) throw new HttpError(403, 'not_listed', "this agent is not listed on its principal's record");
      verifyJws(jws, header.jwk, { typ: TYP.request });
      const s = p.record.spending;
      const amount = money(payload.amount ?? 0);
      const t = today(p);
      const jti = randomId('alw', 10);
      const attempt = { jti, at: Date.now(), place: payload.place, aud: payload.aud, action: payload.action, amount, category: payload.category ?? null, outcome: null, reason: null };
      const refuse = (outcome, reason, extra = {}) => {
        Object.assign(attempt, { outcome, reason });
        p.attempts.push(attempt);
        log.append({ type: 'allowance', principal: payload.principal, aud: payload.aud, amount, outcome, at: new Date().toISOString() });
        return { covered: false, outcome, reason, ...extra };
      };
      if (payload.category && s.categories.length && !s.categories.includes(payload.category)) return refuse('category', `your record doesn't cover ${payload.category}`);
      if (amount > s.per_purchase) return refuse('per_purchase', `$${amount} is over your $${s.per_purchase} limit per purchase`);
      if (s.per_day !== null && t.spent + amount > s.per_day) return refuse('per_day', `$${amount} would take today's spending to $${money(t.spent + amount)}, over your $${s.per_day} a day`);
      if (s.purchases_per_day !== null && t.purchases + 1 > s.purchases_per_day) return refuse('count', `that would be purchase ${t.purchases + 1} today; your record allows ${s.purchases_per_day}`);
      let approved = false;
      if (s.approve_above !== null && amount > s.approve_above) {
        const params = { aud: payload.aud, action: payload.action, params_digest: payload.params_digest, amount };
        const ev = payload.approval && phone.consumeActionApproval(payload.approval, { account: payload.principal, actor: 'principal', action: 'spend', params });
        if (!ev) {
          const request = phone.openRequest(payload.principal, 'approve-action', { actor: 'principal', action: 'spend', params_digest: digestOf(params), summary: `Spend $${amount} at ${payload.place}? (Over the $${s.approve_above} you approve yourself.)` });
          return refuse('needs_approval', `over $${s.approve_above}, so your record says to ask you first`, { request, approvalParams: params });
        }
        approved = true;
      }
      Object.assign(attempt, { outcome: 'covered', approved });
      p.attempts.push(attempt);
      log.append({ type: 'allowance', principal: payload.principal, aud: payload.aud, amount, outcome: 'covered', at: new Date().toISOString() });
      const now = nowSeconds();
      const allowance = signJws({ iss: id, aud: payload.aud, params_digest: payload.params_digest, covered: true, ...(approved ? { approved_by_principal: true } : {}), jti, iat: now, exp: now + ALLOWANCE_SECONDS }, key, { typ: TYP.allowance });
      return { covered: true, approved, allowance, jti };
    },

    /** The place refused, so the spend never happened: it no longer counts. */
    release(pid, jti, why = 'refused by the place') {
      const a = principals.get(pid)?.attempts.find((x) => x.jti === jti);
      if (a && a.outcome === 'covered') Object.assign(a, { outcome: 'released', reason: why });
    },

    /** A signed statement of facts on the principal's record, for one place. Stated by the principal, not verified. */
    statement(pid, { aud, names }) {
      const p = mustPrincipal(pid);
      const claims = Object.fromEntries(names.filter((n) => n in p.record.facts).map((n) => [n, p.record.facts[n]]));
      const now = nowSeconds();
      return signJws({ iss: id, aud, claims, source: 'principal', verified: false, jti: randomId('stm', 10), iat: now, exp: now + ALLOWANCE_SECONDS }, key, { typ: TYP.statement });
    },

    /** The principal's register: every allowance request, and today's totals against the record. */
    register(pid) {
      const p = principals.get(pid);
      if (!p) return null;
      return { record: p.record, version: p.versions.length, today: today(p), attempts: p.attempts.slice(-40).reverse() };
    },

    /** A place checks an allowance or statement: our signature, made out to it, for this request, unexpired, used once. */
    check(jws, { typ, aud, params_digest }) {
      try {
        const { payload } = verifyJws(jws, keeper.publicJwk, { typ });
        if (payload.aud !== aud) return { ok: false, reason: 'made out to another place' };
        if (params_digest && payload.params_digest !== params_digest) return { ok: false, reason: 'for a different request' };
        if (payload.exp < nowSeconds()) return { ok: false, reason: 'expired' };
        if (usedJti.has(payload.jti)) return { ok: false, reason: 'already used' };
        usedJti.add(payload.jti);
        return { ok: true, payload };
      } catch (err) {
        return { ok: false, reason: `not signed by the ${name}: ${err.message}` };
      }
    },

    sth: () => log.signedTreeHead(),
  };
  return keeper;
}

/** The principal signs a version of their record. */
export const signRecord = (principal, record) => signJws({ principal: principal.id, record, iat: nowSeconds() }, principal.key, { typ: TYP.record, embedJwk: true });

/** The agent signs an allowance request with its long-term key. */
export const allowanceRequest = (agent, payload) => signJws(payload, agent.longTermKey, { typ: TYP.request, embedJwk: true });

/** The thumbprint by which a record lists an agent. */
export const agentThumbprint = (agent) => thumbprint(agent.longTermKey.publicJwk);
