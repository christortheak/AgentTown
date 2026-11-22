// The check at the door: what a directory or records service must answer to take
// part, probed without changing anything (the sample implementation’s profile 0.3, Appendix A).
// A team learns at once what its implementation is missing, rather than when a
// shop refuses a customer mid-game. Each result is passed, failed, or not yet
// (something that comes later, like accreditation).
import { decodeJws, verifyJws } from 'aaf-reference/src/lib/crypto.js';
import { verifyEntityStatement, WELL_KNOWN, TRUST_MARK_TYP } from 'aaf-reference/src/lib/openid-federation.js';
import { NOT_PUBLIC } from '../addresses.js';

const STH_TYP = 'aaf-sth+jwt';
const STATUS_LIST_TYP = 'statuslist+jwt';
const ROLES = ['authorization', 'provenance', 'activity'];

const signingKey = (jwks, kid) => jwks.keys.find((k) => k.use !== 'enc' && (!kid || k.kid === kid)) ?? jwks.keys.find((k) => k.use !== 'enc');

/** Is this a JWS of that type, signed by one of these keys? */
function signedBy(jwt, jwks, typ) {
  try {
    verifyJws(jwt, signingKey(jwks, decodeJws(jwt).header.kid), { typ });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a service at its address.
 *   anchors:     the entity ids of trust anchors the town knows
 *   directoryKeys(id): the signing keys of a directory the town knows (to check a records service's trust marks)
 *   guard:       which addresses the town may call (src/addresses.js); id: the entity the address is meant to be
 */
export async function checkService(url, { anchors = [], directoryKeys = () => null, guard = null, id } = {}) {
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  const results = [];
  const note = (check, ok, detail = '') => results.push({ check, ok, detail });
  const done = (extra = {}) => ({ url: base, results, passed: results.filter((r) => r.ok === true).length, failed: results.filter((r) => r.ok === false).length, ...extra });
  const get = (u, init) => fetch(u, { signal: AbortSignal.timeout(5000), ...guard?.fetchOptions, ...init }).catch(() => null);

  if (/^https?:\/\/[^/]+/.test(base)) await guard?.check(base, { id });
  const res = /^https?:\/\/[^/]+/.test(base) ? await get(`${base}${WELL_KNOWN}`) : null;
  note('Answers at its address', Boolean(res?.ok), res ? `${WELL_KNOWN} answered ${res.status}` : 'nothing answered');
  if (!res?.ok) return done();
  let ec;
  try {
    const jwt = await res.text();
    const claimed = decodeJws(jwt).payload;
    ec = verifyEntityStatement(jwt, claimed.jwks, { iss: claimed.sub, sub: claimed.sub });
    note('Describes itself (an Entity Configuration it signed)', true, ec.sub);
  } catch (err) {
    note('Describes itself (an Entity Configuration it signed)', false, err.message);
    return done();
  }
  const [type, md = {}] = Object.entries(ec.metadata ?? {}).find(([k]) => k === 'aaf_directory' || k === 'aaf_records_service') ?? [];
  note('Says what it is', Boolean(type), type === 'aaf_directory' ? 'a directory' : type === 'aaf_records_service' ? 'a records service' : 'no aaf_directory or aaf_records_service metadata');
  if (!type) return done({ entity_id: ec.sub });
  const hints = ec.authority_hints ?? [];
  const known = hints.filter((h) => anchors.includes(h));
  note('Names a trust anchor the town knows', known.length ? true : null, known.length ? known.join(', ') : hints.length ? `names ${hints.join(', ')}, which the town doesn't know` : 'names no trust anchor (authority_hints)');
  note('Says where it is served', md.endpoint_base ? true : null, md.endpoint_base ?? 'no endpoint_base: the town assumes the address you gave');
  const jwks = md.jwks ?? ec.jwks;
  const at = md.endpoint_base ?? base;
  // Where it says it's served is the service's word, so the town checks it may go there before it does.
  if (guard && !(await guard.allows(at, { id: ec.sub }))) {
    note('Is served on the public internet', false, NOT_PUBLIC);
    return done({ entity_id: ec.sub, name: md.organization_name ?? ec.sub, type });
  }

  // Its Token Status List, signed by its own key.
  const sl = await get(`${at}/status-lists/1`);
  note('Publishes a status list (GET /status-lists/1)', sl?.ok ? signedBy(await sl.text(), jwks, STATUS_LIST_TYP) : false, sl ? (sl.ok ? 'a statuslist+jwt signed by its key' : `answered ${sl.status}`) : 'nothing answered');

  if (type === 'aaf_directory') {
    note('Has a signing key and an encryption key', Boolean(signingKey(jwks) && jwks.keys.some((k) => k.use === 'enc')), 'the encryption key seals what only a court may open');
    const st = await get(`${at}/v1/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aaf_id: 'aaf:door-check:u_unknown' }) });
    const stOk = Boolean(st && st.status < 500 && (st.headers.get('content-type') ?? '').includes('json'));
    note('Answers live status (POST /v1/status)', stOk, st ? `answered ${st.status}` : 'nothing answered');
    // The paper's DR-1: a directory says how it verifies, issues, revokes, keeps records and discloses.
    const pr = await get(`${at}/v1/practices`);
    const practices = pr?.ok ? await pr.json().catch(() => null) : null;
    const sections = practices ? ['identity_proofing', 'revocation', 'records', 'disclosure'].filter((k) => practices[k] ?? practices.practices?.[k]) : [];
    note('Publishes its practices (GET /v1/practices)', sections.length === 4, practices ? (sections.length === 4 ? 'how it verifies, revokes, keeps records and discloses' : `missing ${['identity_proofing', 'revocation', 'records', 'disclosure'].filter((k) => !sections.includes(k)).join(', ')}`) : pr ? `answered ${pr.status}` : 'nothing answered');
    const sth = await get(`${at}/v1/transparency/sth`);
    const sthJwt = sth?.ok ? (await sth.json().catch(() => ({}))).sth : null;
    note('Keeps a transparency log (GET /v1/transparency/sth)', Boolean(sthJwt && signedBy(sthJwt, jwks, STH_TYP)), sthJwt ? 'a signed tree head' : sth ? `answered ${sth.status}` : 'nothing answered');
    const acc = await get(`${at}/v1/accreditations`);
    const list = acc?.ok ? await acc.json().catch(() => null) : null;
    const n = list ? (Array.isArray(list) ? list : list.accreditations ?? []).length : 0;
    note('Accredits records services (GET /v1/accreditations)', acc?.ok ? (n ? true : null) : false, acc?.ok ? (n ? `${n} accredited` : 'none yet') : acc ? `answered ${acc.status}` : 'nothing answered');
  } else {
    const roles = md.roles ?? [];
    note('Says which records it keeps', roles.length > 0 && roles.every((r) => ROLES.includes(r)), roles.length ? roles.join(', ') : 'no roles');
    const marks = ec.trust_marks ?? [];
    const valid = marks.filter((m) => {
      const jwt = m.trust_mark ?? m;
      try {
        const { payload } = decodeJws(jwt);
        const keys = directoryKeys(payload.iss);
        return keys && payload.sub === ec.sub && signedBy(jwt, keys, TRUST_MARK_TYP);
      } catch {
        return false;
      }
    });
    note('Accredited by a directory the town knows (trust marks)', valid.length ? true : null, valid.length ? `${valid.length} valid trust mark${valid.length === 1 ? '' : 's'}` : marks.length ? 'trust marks from directories the town doesn’t know' : 'none yet: a directory has to accredit it');
    const sth = await get(`${at}/v1/log/sth`);
    const sthJwt = sth?.ok ? (await sth.json().catch(() => ({}))).sth : null;
    note('Keeps a tamper-evident log (GET /v1/log/sth)', Boolean(sthJwt && signedBy(sthJwt, jwks, STH_TYP)), sthJwt ? 'a signed tree head' : sth ? `answered ${sth.status}` : 'nothing answered');
    if (roles.includes('authorization')) {
      const tok = await get(`${at}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
      const body = tok ? await tok.json().catch(() => null) : null;
      note('Answers token exchange (POST /token)', Boolean(tok && tok.status >= 400 && tok.status < 500 && body?.error), tok ? `an empty request answered ${tok.status}${body?.error ? ` (${body.error})` : ''}` : 'nothing answered');
    }
  }
  return done({ entity_id: ec.sub, name: md.organization_name ?? ec.sub, type });
}
