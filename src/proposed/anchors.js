// Proposed: several trust anchors at once (docs/PROPOSED.md §6).
//
// The reference implementation trusts exactly one trust anchor, and names its
// credential and trust-mark types after it. Here the town keeps a set of
// federations, each discovered from its own anchor, and every party chooses
// which of them it trusts: a shop may take badges from the town's federation
// only, or also from an outside one. Nothing in aaf-reference changes.
//
//   startAnchor()        a trust anchor that can admit members while it runs
//                        (the town's participants' federation, and the sample one)
//   createFederations()  the federations the town knows, refreshed on demand
//   MultiView            one view over several federations, shaped like
//                        aaf-reference's Federation so its code can use it
//
// The one shim: the reference verifier names the credential type it expects
// after `trust.trustAnchor`. A MultiView answers with the anchor of the
// federation whose member it was last asked about. The verifier always looks
// up the issuer and then checks the type in the same synchronous step, so that
// is the issuer's own anchor. The proposal is to pass the issuer's anchor
// explicitly instead.
import { createApp, closeServer, typed, HttpError } from 'aaf-reference/src/lib/http.js';
import { Federation, discoverFederation } from 'aaf-reference/src/lib/trust.js';
import { entityConfiguration, subordinateStatement, jwksOf, verifyEntityStatement, trustMarkType, WELL_KNOWN, ENTITY_TYPES } from 'aaf-reference/src/lib/openid-federation.js';
import { decodeJws, thumbprint } from 'aaf-reference/src/lib/crypto.js';

const STATEMENT = 'application/entity-statement+jwt';
const ROLES = ['authorization', 'provenance', 'activity'];

/**
 * A trust anchor (OpenID Federation): its Entity Configuration, the list of its members, and a Subordinate
 * Statement for each. Unlike the reference one, it can admit a member while it runs.
 *   members: [{ entity_id, entity_type, jwks, metadata }]
 *   open:    a registry it admits may accredit record keepers in this federation, for every role
 */
export async function startAnchor({ entityId, name, key, port = 0, host = '127.0.0.1', address = null, policies, members = [], trustMarkIssuers = {}, open = false }) {
  const list = [...members];
  const issuers = structuredClone(trustMarkIssuers);
  const app = createApp(entityId);
  app.get(WELL_KNOWN, () => typed(entityConfiguration({
    entityId, key, jwks: jwksOf(key),
    metadata: { federation_entity: { organization_name: name, federation_fetch_endpoint: `${entityId}/fetch`, federation_list_endpoint: `${entityId}/list` }, aaf_trust_anchor: { policies } },
    extra: { trust_mark_issuers: issuers },
  }), STATEMENT));
  app.get('/list', ({ query }) => list.filter((m) => !query.entity_type || m.entity_type === query.entity_type).map((m) => m.entity_id));
  app.get('/fetch', ({ query }) => {
    const m = list.find((x) => x.entity_id === query.sub);
    if (!m) throw new HttpError(404, 'not_found', `${query.sub} is not a subordinate of ${entityId}`);
    return typed(subordinateStatement({ issuer: entityId, key, sub: m.entity_id, jwks: m.jwks, metadata: { [m.entity_type]: m.metadata } }), STATEMENT);
  });
  const server = await app.listen(port, host);
  const url = `http://${address ?? host}:${server.address().port}`; // where others reach it: an address, if it listens on every interface
  return {
    entityId, name, url,
    anchor: { entity_id: entityId, url, jwks: jwksOf(key) },
    thumbprint: thumbprint(key.publicJwk),
    members: () => list,
    /** Admit a member. A registry in an open federation may then accredit record keepers here. */
    admit(m) {
      if (!ENTITY_TYPES.includes(m.entity_type)) throw new HttpError(400, 'bad_type', `entity_type must be one of ${ENTITY_TYPES.join(', ')}`);
      const at = list.findIndex((x) => x.entity_id === m.entity_id);
      if (at >= 0) list[at] = m;
      else list.push(m);
      if (open && m.entity_type === 'aaf_registry') {
        for (const role of ROLES) {
          const type = trustMarkType(entityId, role);
          issuers[type] = [...new Set([...(issuers[type] ?? []), m.entity_id])];
        }
      }
      return m;
    },
    close: () => closeServer(server),
  };
}

/**
 * What a service says about itself at its URL: its Entity Configuration, self-signed. Read before admitting it.
 * Returns the member entry an anchor needs, and what was found, in words.
 */
export async function readEntity(url) {
  const base = String(url).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(base)) throw new HttpError(400, 'bad_url', 'Give the service’s address, like http://192.168.1.20:4101');
  const res = await fetch(`${base}${WELL_KNOWN}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res) throw new HttpError(502, 'unreachable', `Nothing answered at ${base}${WELL_KNOWN}. If your service must be a member before it can start, give its entity statement instead.`);
  if (!res.ok) throw new HttpError(502, 'unreachable', `${base}${WELL_KNOWN} answered ${res.status}`);
  const jwt = await res.text();
  const claimed = decodeJws(jwt).payload;
  const ec = verifyEntityStatement(jwt, claimed.jwks, { iss: claimed.sub, sub: claimed.sub }); // self-signed: it holds the keys it names
  const [type, md] = Object.entries(ec.metadata ?? {}).find(([k]) => ENTITY_TYPES.includes(k)) ?? [];
  if (!type) throw new HttpError(400, 'not_a_member_type', `${base} is not a registry or record keeper (no aaf_ metadata in its Entity Configuration)`);
  const sigKeys = (md.jwks ?? ec.jwks).keys.filter((k) => k.use !== 'enc');
  return {
    member: { entity_id: ec.sub, entity_type: type, jwks: { keys: ec.jwks.keys.filter((k) => k.use !== 'enc') }, metadata: { ...md, endpoint_base: md.endpoint_base ?? base, jwks: md.jwks ?? ec.jwks } },
    name: md.organization_name ?? ec.sub, type, hints: ec.authority_hints ?? [], thumbprint: thumbprint(sigKeys[0]),
  };
}

/**
 * One view over several federations, in the shape of aaf-reference's Federation. `feds()` says which, at the
 * moment of each call: a shop that starts trusting another federation sees its members at once.
 */
export class MultiView {
  constructor(feds) {
    this.feds = feds;
    this.current = null;
  }

  /** The federation that lists an entity, and the entry; remembered as the current one (see the note at the top). */
  find(pick, id) {
    for (const f of this.feds()) {
      const e = pick(f.view, id);
      if (e) {
        this.current = f;
        return e;
      }
    }
    return null;
  }

  get trustAnchor() {
    return (this.current ?? this.feds()[0]).view.trustAnchor;
  }
  get policies() {
    return this.feds()[0].view.policies;
  }
  get doc() {
    const all = (k) => {
      const seen = new Set();
      return this.feds().flatMap((f) => f.view.doc[k]).filter((e) => !seen.has(e.id) && seen.add(e.id));
    };
    const first = this.feds()[0].view.doc;
    return { ...first, registries: all('registries'), record_keepers: all('record_keepers'), verifiers: all('verifiers'), resolution_authorities: all('resolution_authorities') };
  }
  get registries() {
    return this.doc.registries;
  }
  get recordKeepers() {
    return this.doc.record_keepers;
  }
  registry(id) {
    return this.find((v, x) => v.registry(x), id);
  }
  recordKeeper(id) {
    return this.find((v, x) => v.recordKeeper(x), id);
  }
  authority(id, kind) {
    return this.find((v, x) => v.authority(x, kind), id);
  }
  entityForUri(uri) {
    return this.find((v, x) => v.entityForUri(x), uri);
  }
  locate(uri) {
    const e = this.entityForUri(uri);
    if (!e?.url) throw new Error(`no endpoint known for ${uri}`);
    return e.url + uri.slice(e.id.length);
  }
  /** Each federation names its own trust-mark types (after its anchor), so the issuers of a type are one federation's. */
  trustMarkIssuers(type) {
    return this.feds().flatMap((f) => f.view.trustMarkIssuers(type));
  }
  signingKey(entity, kid) {
    if (entity?.id) this.find((v, x) => v.registry(x) ?? v.recordKeeper(x) ?? v.authority(x, 'verifier') ?? v.authority(x, 'resolution'), entity.id);
    return Federation.prototype.signingKey.call(null, entity, kid);
  }
  encryptionKey(entity) {
    return Federation.prototype.encryptionKey.call(null, entity);
  }
  withUrlOverrides(overrides) {
    const changed = this.feds().map((f) => ({ ...f, view: f.view.withUrlOverrides(overrides) }));
    return new MultiView(() => changed);
  }
}

/**
 * The federations the town knows. The town's own is first; the participants' federation is run by the town and
 * admits members while it runs; any other is added by its trust anchor's address.
 */
export function createFederations() {
  const feds = new Map(); // key -> { key, name, kind, anchor, view, owner?, added }

  const discover = async (anchor, overrides) => {
    const view = await discoverFederation(anchor);
    return overrides ? view.withUrlOverrides(overrides) : view;
  };

  /** A federation by its anchor: discovered now, or with a view already in hand (and where its members are really served). */
  async function add({ key, name, kind, anchor, owner = null, view = null, overrides = null }) {
    if (feds.has(key)) throw new HttpError(409, 'known', `The town already knows ${name}.`);
    const v = view ?? (await discover(anchor, overrides));
    const f = { key, name: name ?? v.doc.federation, kind, anchor, view: v, owner, overrides, added: Date.now() };
    feds.set(key, f);
    return f;
  }

  const set = {
    add,
    get: (key) => feds.get(key) ?? null,
    list: () => [...feds.values()],
    /** Rediscover one federation (or all): a new member shows up, a removed one goes. One that can't be reached keeps its last view. */
    async refresh(key) {
      for (const f of key ? [feds.get(key)].filter(Boolean) : feds.values()) {
        try {
          f.view = await discover(f.anchor, f.overrides);
        } catch (err) {
          if (key) throw err;
        }
      }
    },
    /** The federation that lists an entity. */
    of(entityId) {
      return [...feds.values()].find((f) => f.view.registry(entityId) || f.view.recordKeeper(entityId)) ?? null;
    },
    /** A view over the federations with these keys (all, if none given), as they are at each call. */
    view(keys) {
      return new MultiView(() => [...feds.values()].filter((f) => !keys || (typeof keys === 'function' ? keys() : keys).includes(f.key)));
    },
    /**
     * Add a federation by its trust anchor's address. Its keys are taken on first use, unless a thumbprint is
     * given to pin: then they must match.
     */
    async addByUrl(url, { pin = null, name = null } = {}) {
      const base = String(url ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^/]+/.test(base)) throw new HttpError(400, 'bad_url', 'Give the trust anchor’s address, like http://192.168.1.20:4100');
      const res = await fetch(`${base}${WELL_KNOWN}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!res?.ok) throw new HttpError(502, 'unreachable', `Nothing answered at ${base}${WELL_KNOWN}.`);
      const jwt = await res.text();
      const claimed = decodeJws(jwt).payload;
      if (!claimed.metadata?.aaf_trust_anchor) throw new HttpError(400, 'not_an_anchor', `${base} is not a trust anchor (no aaf_trust_anchor metadata).`);
      const key = claimed.jwks.keys.find((k) => k.kid === decodeJws(jwt).header.kid) ?? claimed.jwks.keys[0];
      const print = thumbprint(key);
      if (pin && pin !== print) throw new HttpError(409, 'pin_mismatch', `The anchor's key has thumbprint ${print}, not ${pin}. Not added.`);
      verifyEntityStatement(jwt, claimed.jwks, { iss: claimed.sub, sub: claimed.sub });
      if ([...feds.values()].some((f) => f.anchor.entity_id === claimed.sub)) throw new HttpError(409, 'known', 'The town already knows that federation.');
      const f = await add({ key: `fed-${feds.size}`, name: name ?? claimed.metadata.federation_entity?.organization_name, kind: 'outside', anchor: { entity_id: claimed.sub, url: base, jwks: claimed.jwks } });
      return { ...f, thumbprint: print, pinned: Boolean(pin) };
    },
  };
  return set;
}
